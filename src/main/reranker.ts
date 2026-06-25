/**
 * 检索结果 LLM 重排（v1.3.2）
 *
 * 背景：
 *   v1.2.8→v1.2.9 调了一轮 BM25/RRF 参数（topK 5→8、fetchK=max(50,10×topK)、RRF_K 60→30、b 0.75→0.5），
 *   但用户实测「北京历史文化名城保护条例 第二章第十三条前后备案事项」仍召回错——BM25 中文 unigram
 *   分词让条例名前缀（每章节 chunk 都以「北京历史文化名城保护条例 第N章」开头）稀释 IDF，8 个整章
 *   chunk 的 BM25 分数挤在 10% 区间内，区分度极低；RRF 融合后正确答案（第十九-二十二条）被排到
 *   topK 边缘甚至之外，LLM 拿到整章总则 chunk 幻觉出「第四章只有第三十四条」。
 *
 *   继续调参边际递减——根因是 BM25 对中文长结构化文档区分度本身不够。改用 LLM 语义重排：
 *   召回扩大到 20 候选 → 小 LLM 看 query+chunk 联合语义重排 → 取 topK。LLM 能识别「第十九-二十二条
 *   备案」才是「第十三条前后备案」的真匹配，把答案从 rank 6+ 抬到前 1-2。
 *
 * 设计取舍：
 *   - 只重排顺序，不替换 score——RRF norm score 保留，citationScoreThreshold / citation 逻辑零侵入
 *   - 复用 resolveSummaryProvider（走 Chat Provider + chatModel，同 summary/rewriter），无新依赖
 *   - 候选上限 20（防 prompt 爆）；≤1 个 hit 直接返回不调 LLM
 *   - 降级链：缺 key / 抛错 / 非 JSON / 空 order / order 非整数数组 → 返回原 hits 原顺序 + console.warn
 *
 * 调用方：
 *   - ipc-handlers.ts::runSimpleChat：hybridSearchMultiQuery 后、构造 context 前
 *   - agent.ts::runAgent：search_kb 的 hybridSearchMulti 后、formatChunkPreview 前
 *   两路都在调用方先把 topK 扩成 fetchTopK=max(topK,20) 拿更多候选，rerank 后再 slice(topK)。
 */
import { chatStream } from './api-client';
import { resolveSummaryProvider } from './document-processor';
import { SecureStore } from './secure-store';
import type { SearchHit } from './vector-store';
import type { Settings, ChatMessage } from '../shared/types';

/** 喂给 LLM 的候选上限（防 prompt 爆；超过的先 slice 前 20） */
const MAX_RERANK_CANDIDATES = 20;
/** preview 长度（字符）——只给 LLM 看片段开头判断相关度，不调 formatChunkPreview 避免带 score/TRUNCATED 标记干扰 */
const PREVIEW_CHARS = 200;
/** v1.3.5 rerank LLM 超时——超时回退 RRF 原顺序。防 Provider 慢卡死（实测 deepseek-v4-flash
 *  非流式 rerank 偶发 12-33s，超时兜底最差 10s 回退）。 */
const RERANK_TIMEOUT_MS = 10_000;

/**
 * 用 LLM 按语义相关度重排检索结果。
 *
 * @param query  用户原始问题（简单模式用 payload.content；agent 模式用 sub_query）
 * @param hits   检索返回的候选（已扩召回，长度可达 20+）
 * @param settings
 * @returns 重排后的 hits（顺序变，score 保留原 RRF norm 值）；任何失败都返回原 hits 原顺序
 */
export async function rerankHits(
  query: string,
  hits: SearchHit[],
  settings: Settings,
): Promise<SearchHit[]> {
  // ≤1 个候选无需重排，省 LLM 调用
  if (hits.length <= 1) return hits;

  // 候选上限：超 20 先取前 20（RRF 顺序，已是相关度较高的）
  const candidates = hits.slice(0, MAX_RERANK_CANDIDATES);
  const tail = hits.slice(MAX_RERANK_CANDIDATES); // 被截掉的尾部，rerank 后原样追加

  const { provider, model } = resolveSummaryProvider(settings);
  const apiKey = await SecureStore.getApiKey(provider.id);
  if (!apiKey) {
    console.warn('[reranker] 缺 Chat Provider API Key，跳过重排');
    return hits;
  }

  const systemPrompt =
    '你是检索结果重排助手。给定用户问题和 N 个文档片段（按编号 #1..#N），按与问题的相关度从高到低重新排序。\n' +
    '规则：\n' +
    '1. 优先语义匹配——片段是否真正回答了问题，而不是被片段长度 / 关键词堆砌误导\n' +
    '2. 含问题所问具体条款 / 章节号 / 实体名的片段优先（如问题问"第十三条前后"，含第十三条附近条款的片段优先）\n' +
    '3. 整章总则 / 概述类片段若不含问题所问具体内容，排在具体条款片段之后\n' +
    '4. 完全无关的片段排最后\n' +
    '5. 严格输出 JSON（不要 Markdown 代码块外其他文字）：\n' +
    '   {"order":[编号按相关度降序，如 3,1,2]}';

  const fragText = candidates
    .map((h, i) => {
      const preview = h.text.slice(0, PREVIEW_CHARS);
      return `#${i + 1} [${h.filename}]\n${preview}`;
    })
    .join('\n\n');

  const userPrompt = `【问题】\n${query}\n\n【片段】\n${fragText}\n\n请输出重排 JSON。`;

  const promptMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  let r;
  const tLlm0 = Date.now();
  try {
    // v1.3.5：改用流式（chatStream）——deepseek-v4-flash 非流式 chatCompletion 实测 10-33s 超时
    // （非流式要等思考链+正文全生成完才返回；流式正文一出就能收，思考链 reasoning_content 边来边丢）。
    // 仍保留 10s 超时兜底；onDelta 传空（rerank 不需要流式给 UI，只要最终 content）。
    r = await Promise.race([
      chatStream(provider, apiKey, model, promptMessages, 0.1, () => {
        /* rerank 不流式输出给 UI，丢弃 delta */
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`rerank 超时 ${RERANK_TIMEOUT_MS}ms`)), RERANK_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    console.warn('[reranker] LLM 调用失败/超时，使用原顺序：', (e as Error).message);
    return hits;
  }
  const llmMs = Date.now() - tLlm0;
  // v1.3.5 诊断：打出 provider/model/prompt 长度/响应长度/耗时，定位 rerank 慢的根因
  const promptChars = systemPrompt.length + userPrompt.length;
  console.log(
    `[reranker] provider=${provider.id} model=${model} ` +
      `candidates=${candidates.length} prompt=${promptChars}字 response=${r.content.length}字 ` +
      `llm=${llmMs}ms finish=${r.finishReason}`,
  );

  const jsonStr = extractFirstJson(r.content);
  if (!jsonStr) {
    console.warn('[reranker] LLM 未返回 JSON，使用原顺序：', r.content.slice(0, 100));
    return hits;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.warn('[reranker] LLM 返回非合法 JSON，使用原顺序：', jsonStr.slice(0, 100));
    return hits;
  }

  const rawOrder = Array.isArray(parsed?.order) ? parsed.order : [];
  // order 是 1-based 编号数组；映射回 candidates 索引，去重 + 跳过越界/非整数
  const orderedIdx: number[] = [];
  const seen = new Set<number>();
  for (const item of rawOrder) {
    if (typeof item !== 'number' || !Number.isFinite(item)) continue;
    const idx = Math.trunc(item) - 1; // 1-based → 0-based
    if (idx < 0 || idx >= candidates.length) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    orderedIdx.push(idx);
  }

  if (orderedIdx.length === 0) {
    console.warn('[reranker] LLM 返回空 order，使用原顺序');
    return hits;
  }

  // 按 LLM order 重排；未列入 order 的候选按原 RRF 顺序追加（保留它们，只是排后面）
  const reranked = orderedIdx.map((idx) => candidates[idx]);
  for (let i = 0; i < candidates.length; i++) {
    if (!seen.has(i)) reranked.push(candidates[i]);
  }
  // 被截掉的尾部（>20 的）原样追加
  reranked.push(...tail);

  const top3 = orderedIdx.slice(0, 3).map((idx) => `#${idx + 1}`).join(',');
  console.log(
    `[reranker] query="${query.slice(0, 30)}..." ${hits.length} hits → reranked ` +
      `(top3: ${top3})`,
  );
  return reranked;
}

/** 从 LLM 输出中抠出第一个 JSON 对象（容忍 ```json fences）。与 query-rewriter 同款，就地复制保持隔离。 */
function extractFirstJson(s: string): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++;
    else if (trimmed[i] === '}') {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}
