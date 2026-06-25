/**
 * 检索 query 理解与重写管线（v1.3.0）
 *
 * 背景：
 *   v1.2.5 / v1.2.6 的 `query-resolver.ts` 只做"指代消解"（"它/那"→ 实体名）——
 *   解决"代词→实体"一种情况。但用户实测的检索盲点不止这一种：
 *     - 口语化 / 模糊 query（「这个怎么用啊」「那个报错怎么办」）：embedding 找不到明确向量
 *     - 短 query（「限流」「价格」）：BM25 没有足够上下文命中
 *     - 多意图 query（「对比 X 和 Y 的区别，以及各自的使用场景」）：一个 query 拉不回两边片段
 *
 * v1.3.0 设计：用一个小 LLM（temperature=0.1）一次性产出 `QueryPlan`：
 *   - `searchQueries: string[]`（1-3 条）：自包含原样 / 指代补全 / 模糊扩展 / 多意图分解
 *   - `intent` / `expandedTerms` / `needsHighRecall`：暂时只在 log 体现，预留给未来 BM25 term boost / topK 调整
 *
 * 调用方：
 *   - `ipc-handlers.ts::runSimpleChat`：把 `searchQueries` 喂给 `hybridSearchMultiQuery`（多 query RRF 融合）
 *   - `agent.ts::runAgent`：把 `searchQueries` 拼进 system prompt 作为"已改写候选"参考，LLM 仍可调 search_kb
 *
 * 缓存：进程内 Map，key = (sessionId, currentUserMsgId, rawQuery.trim())，与 v1.2.6 query-resolver 同结构。
 *   含 lastUserMsgId 是为了避免"同一句指代在 history 变化后拿到陈旧 plan"。
 *
 * 失败兜底链（与 v1.2.6 一致）：
 *   首轮（无 history）                    → passthrough（单条，但先经 stripNoise 剥无效词）
 *   缺 LLM key / chatCompletion 抛错     → 原 query（单条） + console.warn
 *   LLM 返回空 / JSON 解析失败 / 返回不是数组 → 原 query（单条） + console.warn
 *
 * v1.3.1 增量：所有路径入口先过 `stripNoise()`（cheap 正则剥寒暄/尾巴/句末"呢"），
 *   首轮与多轮共享。剥后为空则退回原文。
 */
import { listMessages } from './storage';
import { chatStream } from './api-client';
import { resolveSummaryProvider } from './document-processor';
import { SecureStore } from './secure-store';
import type { Settings, ChatMessage } from '../shared/types';

/** 问题意图分类（用于调试日志 / 未来按 intent 调 topK，预留） */
export type QueryIntent =
  | 'factual' // 事实查找
  | 'how-to' // 操作步骤
  | 'comparison' // 对比
  | 'summary' // 总结
  | 'definition' // 定义 / 解释
  | 'other';

/** 单次 plan 命中的处理步骤（用于日志 / 调试） */
export type PlanStep =
  | 'cache-hit'
  | 'passthrough'
  | 'llm-call'
  | 'llm-rewrite' // 指代 → 实体
  | 'llm-expand' // 模糊 → 同义/相关词扩展
  | 'llm-decompose' // 多意图 → 分解为多条 sub-query
  | 'skip-chitchat'; // v1.3.4 闲聊短路（跳过检索）

export interface QueryPlan {
  /** 1-3 条改写/扩展后的 query，每条都能独立喂给 hybridSearch */
  searchQueries: string[];
  /** 问题意图（log 用，预留给未来 topK 调整） */
  intent: QueryIntent;
  /** 关键实体 / 同义词（暂存，预留给 BM25 term boost） */
  expandedTerms: string[];
  /** 提示"需要更高召回"（列举/对比类），暂时只在 log 体现 */
  needsHighRecall: boolean;
  /** v1.3.4 闲聊短路：true=跳过检索直接主答（问候/闲聊/与知识库无关的问题）。
   *  首轮用 cheap regex 检测，多轮用 LLM 判断。失败兜底=false（宁可不短路别漏答）。 */
  skipSearch: boolean;
  /** 调试用：命中的处理步骤 */
  steps: PlanStep[];
  /** 是否触发了 LLM 调用 */
  usedLlm: boolean;
}

export interface PlanSearchQueryOptions {
  sessionId: string;
  currentUserMsgId: string;
  currentQuery: string;
  settings: Settings;
}

/** searchQueries 上限：1-3 条。LLM 返回更多时截断；返回更少时退化为单条原 query */
const MAX_SEARCH_QUERIES = 3;

/**
 * cheap 预处理：剥离会污染检索的"无效词句"——寒暄开头 / 闲聊尾巴 / 句末疑问语气词"呢"。
 * 纯 regex、零 LLM 成本，passthrough 前与 LLM 改写前都先过一遍。
 *
 * 设计原则（保守）：
 *   - 只剥「明确无检索价值」的成分，不动指代词（它/那/这——留给多轮 LLM 消解）与实体名；
 *   - 句末语气词只剥「呢」（几乎不可能是术语/实体名的合法结尾），不剥「啊/呀/吧」等
 *     误伤风险更高的词；
 *   - 剥离后若 query 变空（用户只输入了寒暄），退回原文，避免空 query 送检索。
 *
 * 例：「请问一下，OpenAI 的限流策略是什么？」→「OpenAI 的限流策略是什么？」
 *     「麻烦问下，第三章讲了什么，谢谢」→「第三章讲了什么」
 *     「我想了解一下 RAG 是什么呢」→「RAG 是什么」
 */
// 寒暄 / 客套开头（长前缀在 alternation 里必须排在短前缀之前，否则短前缀先吃掉）
const NOISE_LEADING =
  /^(请问一下|请问下|请问您|请问|麻烦问一下|麻烦问下|麻烦问|我想问一下|我想了解一下|我想了解|我想问|帮我查一下|帮我查|帮我看一下|帮我看下|帮我看看|帮我问一下|帮我问下|帮我|咨询一下|咨询|能不能告诉我|可以告诉我|能告诉我|问一下|问下|您好|你好|哈喽|嗨)[，,。、\s:：]*/i;
// 闲聊尾巴（"谢谢/麻烦了/辛苦了" 等，可带句末标点）
const NOISE_TRAILING =
  /[，,。、\s]*(谢谢|感谢|多谢|麻烦了|麻烦您了|辛苦了|thanks|thank you|thx)[。！？!?.、\s]*$/i;
// 句末疑问语气词"呢"（可带句末标点）——"是什么呢？" → "是什么"
const NOISE_PARTICLE = /呢[。！？!?.]?$/;

function stripNoise(query: string): string {
  let q = query;
  q = q.replace(NOISE_LEADING, '');
  q = q.replace(NOISE_TRAILING, '');
  q = q.replace(NOISE_PARTICLE, '');
  q = q.trim();
  // 剥离后为空（用户只输入了寒暄/尾巴）→ 退回原文，避免空 query 送检索
  return q.length > 0 ? q : query.trim();
}

/**
 * v1.3.4 闲聊短路（首轮 cheap 检测，零 LLM 成本）：
 *   首轮（无 history）passthrough 不调 LLM，但闲聊高发在首轮——"你好/谢谢/在吗"这类
 *   不需要检索。这里用 regex 命中明确问候/客套/感谢，命中则 skipSearch=true 跳过整个检索。
 *
 * 设计原则（极保守，宁可漏短路也别误伤真问题）：
 *   - 只命中「整句就是问候/客套/感谢」的极短输入（剥 Noise 后 ≤ 8 字且无标点歧义）；
 *   - 不命中任何含疑问词（什么/怎么/哪/为什么/吗）或实义内容的句子——那些走检索；
 *   - 多轮不靠 regex（首轮才有），多轮靠 planWithLlm 的 LLM 判断。
 *
 * 例：「你好」「谢谢」「在吗」「嗨」「您好」「感谢感谢」→ 命中
 *     「你好，请问限流策略」→ 剥 Noise 后「限流策略」不含问候词主体，不命中（走检索）
 *     「这个怎么用」→ 含「怎么」，不命中
 */
const CHITCHAT_RE =
  /^(你好|您好|哈喽|嗨|hi|hello|hey|早上好|上午好|中午好|下午好|晚上好|早安|晚安|谢谢|感谢|多谢|thx|thanks|thank you|ok|好的|收到|嗯|哦|在吗|在不在|有人吗)[。！？!?.~]*/i;

/** 判断（剥 Noise 后的）query 是否是纯闲聊——首轮 cheap 检测用 */
function isChitchat(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  // 太长的几乎不会是纯问候（保守上限 8 字）
  if (q.length > 8) return false;
  return CHITCHAT_RE.test(q);
}

const cache = new Map<string, QueryPlan>();

export function clearRewriteCache(): void {
  cache.clear();
}

function cacheKey(opts: PlanSearchQueryOptions): string {
  return `${opts.sessionId}::${opts.currentUserMsgId}::${opts.currentQuery.trim()}`;
}

/**
 * 主入口：返回用于检索的 QueryPlan。
 *
 *   cache hit              → 直接返回（steps 带 cache-hit 前缀）
 *   首轮（无 user/assistant history）→ passthrough 单条原 query
 *   有 history             → 总是调 LLM 产出 plan
 *
 * 失败兜底：任何 LLM 错误都退化为 `{ searchQueries: [rawQuery], intent: 'other', ... }`。
 */
export async function planSearchQuery(
  opts: PlanSearchQueryOptions,
): Promise<QueryPlan> {
  const ck = cacheKey(opts);
  const cached = cache.get(ck);
  if (cached) {
    return { ...cached, steps: ['cache-hit', ...cached.steps] };
  }

  // v1.3.1：先过 cheap 正则剥「寒暄开头 / 闲聊尾巴 / 句末"呢"」等无效词句——
  // 首轮 passthrough 与多轮 LLM 改写都受益（首轮原本原样送检索，"请问一下…"
  // 这类寒暄会稀释 embedding 向量、干扰 BM25 命中）。剥后为空则退回原文。
  const originalQuery = stripNoise(opts.currentQuery.trim());
  const steps: PlanStep[] = [];
  let searchQueries: string[] = [originalQuery];
  let intent: QueryIntent = 'other';
  let expandedTerms: string[] = [];
  let needsHighRecall = false;
  let skipSearch = false;
  let usedLlm = false;

  // 首轮检测：除当前 user msg 外有没有任何 user/assistant 消息
  const msgs = listMessages(opts.sessionId);
  const hasHistory = msgs.some(
    (m) =>
      m.id !== opts.currentUserMsgId &&
      (m.role === 'user' || m.role === 'assistant') &&
      (m.content ?? '').trim().length > 0,
  );

  if (!hasHistory) {
    // 首轮：passthrough（不开 LLM 调用，省 token）
    steps.push('passthrough');
    // v1.3.4：首轮 cheap regex 闲聊检测——"你好/谢谢/在吗"等纯问候直接跳检索
    // （首轮不调 LLM，regex 零成本兜底；保守只命中明确问候，真问题绝不命中）
    if (isChitchat(originalQuery)) {
      skipSearch = true;
      steps.push('skip-chitchat');
    }
  } else {
    steps.push('llm-call');
    try {
      const plan = await planWithLlm(msgs, opts.currentUserMsgId, originalQuery, opts.settings);
      if (plan && plan.searchQueries.length > 0) {
        searchQueries = plan.searchQueries;
        intent = plan.intent;
        expandedTerms = plan.expandedTerms;
        needsHighRecall = plan.needsHighRecall;
        skipSearch = plan.skipSearch;
        usedLlm = true;
        if (skipSearch) {
          // v1.3.4：LLM 判断为闲聊/与 KB 无关 → 跳检索
          steps.push('skip-chitchat');
        } else if (searchQueries.length > 1) {
          // 多条 query：可能是分解或扩展
          // 简单启发：分解的特征是 searchQueries 包含不同主题；扩展是同主题不同表述
          // 这里无法精确区分，记 'llm-decompose'（覆盖大多数情况）
          steps.push('llm-decompose');
        } else if (searchQueries[0] !== originalQuery) {
          // 单条且内容变了：rewrite（指代消解 / 表达优化）
          steps.push('llm-rewrite');
        } else {
          // 单条且没变：llm-call 命中但 LLM 决定保持原样
          steps.push('llm-rewrite');
        }
      }
      // 否则：LLM 返回空 / 不合法 → 保持 passthrough 行为（searchQueries: [rawQuery]）
    } catch (e) {
      console.warn(
        '[query-rewriter] LLM 改写失败，使用原文：',
        (e as Error).message,
      );
    }
  }

  const result: QueryPlan = {
    searchQueries,
    intent,
    expandedTerms,
    needsHighRecall,
    skipSearch,
    steps,
    usedLlm,
  };
  cache.set(ck, result);
  return result;
}

/**
 * 用最近 6 条 user/assistant 作为 anchor（≈3 轮），把当前 query 喂给小模型，
 * 让它产出 QueryPlan JSON。
 *
 * 返回 undefined 的情况：
 *   - history 里没 user/assistant（不应该走到这里，调用方已检查）
 *   - 缺 LLM key
 *   - LLM 返回空 / JSON 解析失败 / searchQueries 不是非空字符串数组
 */
async function planWithLlm(
  allMessages: ReturnType<typeof listMessages>,
  currentUserMsgId: string,
  currentQuery: string,
  settings: Settings,
): Promise<Omit<QueryPlan, 'steps' | 'usedLlm'> | undefined> {
  // 取最近 6 条 user/assistant（按时间顺序）
  const recent = allMessages
    .filter(
      (m) =>
        m.id !== currentUserMsgId &&
        (m.role === 'user' || m.role === 'assistant') &&
        (m.content ?? '').trim().length > 0,
    )
    .slice(-6);
  if (recent.length === 0) return undefined;

  const { provider, model } = resolveSummaryProvider(settings);
  const apiKey = await SecureStore.getApiKey(provider.id);
  if (!apiKey) return undefined;

  // 把每条压成 "用户/助手：内容" 单行，超 400 字截断（防 prompt 爆）
  const historyText = recent
    .map((m) => {
      const role = m.role === 'user' ? '用户' : '助手';
      const c = (m.content ?? '').replace(/\s+/g, ' ').trim();
      const truncated = c.length > 400 ? c.slice(0, 400) + '…' : c;
      return `${role}：${truncated}`;
    })
    .join('\n');

  const systemPrompt =
    '你是检索 query 规划助手。给定对话历史和本轮用户问题，输出 1-3 条高质量检索 query，' +
    '用于喂给向量库 + BM25 做相似度匹配（检索系统看不到对话历史）。\n' +
    '规则：\n' +
    '0. 先剥离无效词句：去掉寒暄开头（"请问一下/麻烦问下/我想了解一下/帮我查一下/您好" 等）、' +
    '闲聊尾巴（"谢谢/麻烦了/辛苦了" 等）、句末疑问语气词"呢"——这些词没有检索价值，会稀释向量、' +
    '干扰关键词命中。剥离后再做下面的判断。\n' +
    '1. 自包含问题（含具体实体 / 不依赖上文）→ searchQueries 保留 1 条原样\n' +
    '2. 含指代（"它/那/这个"）/ 省略（"第几章？/为什么？/详细说说"）→ 用 history 里的具体实体名（条例名、文件名、' +
    '产品名、章节号、API 名、专有名词）替换指代\n' +
    '3. 口语化 / 模糊问题（"这个怎么用"/"那个报错怎么办"）→ 扩展 2-3 条同义/相关 query 增加召回\n' +
    '4. 多意图问题（"对比 X 和 Y 的区别以及使用场景"）→ 分解为 2-3 条 sub-query 各自命中对应文档\n' +
    '5. searchQueries 必须是 1-3 条非空字符串，去重；超长截到 200 字内\n' +
    '6. v1.3.4 闲聊短路：判断本轮问题是否需要检索知识库——' +
    '纯问候 / 闲聊 / 客套 / 感谢 / 与文档无关的常识问题（"你好""谢谢""你是谁""今天天气怎样"）' +
    '→ skipSearch=true（跳过检索直接回答）。任何含具体实体 / 疑问 / 需要文档内容支撑的问题 → skipSearch=false。' +
    '拿不准时一律 false（宁可检索也别漏答）。\n' +
    '7. 严格输出 JSON（不要 Markdown 代码块外其他文字）：\n' +
    '   {"intent":"factual|how-to|comparison|summary|definition|other",' +
    '"searchQueries":["..."],' +
    '"expandedTerms":["实体/同义词，预留"],' +
    '"needsHighRecall":true|false,' +
    '"skipSearch":true|false}';

  const userPrompt =
    `【对话历史】\n${historyText}\n\n` +
    `【本轮问题】\n${currentQuery}\n\n` +
    `请输出 QueryPlan JSON。`;

  const promptMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  // v1.3.5：改用流式（chatStream）——与 rerank 同因：deepseek-v4-flash 非流式 chatCompletion
  // 实测多轮 plan 调用 4s+（非流式要等思考链+正文全生成完）。流式正文一出就能收。
  const r = await chatStream(provider, apiKey, model, promptMessages, 0.1, () => {
    /* query-plan 不流式输出给 UI，丢弃 delta */
  });
  const jsonStr = extractFirstJson(r.content);
  if (!jsonStr) return undefined;

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.warn('[query-rewriter] LLM 返回非 JSON：', r.content.slice(0, 100));
    return undefined;
  }

  // 解析 + 清洗 searchQueries
  const rawQueries = Array.isArray(parsed?.searchQueries) ? parsed.searchQueries : [];
  const cleaned: string[] = [];
  for (const q of rawQueries) {
    if (typeof q !== 'string') continue;
    const trimmed = q.trim();
    if (!trimmed) continue;
    // 截长（防止 LLM 偶尔输出完整段落当 query）
    const capped = trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed;
    if (!cleaned.includes(capped)) cleaned.push(capped);
    if (cleaned.length >= MAX_SEARCH_QUERIES) break;
  }
  if (cleaned.length === 0) return undefined;

  // 解析 intent（容错：LLM 偶尔写 "factual " 带空格 / "Factual" 大小写不一致）
  const validIntents: QueryIntent[] = [
    'factual',
    'how-to',
    'comparison',
    'summary',
    'definition',
    'other',
  ];
  const rawIntent = typeof parsed?.intent === 'string' ? parsed.intent.trim().toLowerCase() : '';
  const intent: QueryIntent = (validIntents as string[]).includes(rawIntent)
    ? (rawIntent as QueryIntent)
    : 'other';

  // 解析 expandedTerms
  const rawTerms = Array.isArray(parsed?.expandedTerms) ? parsed.expandedTerms : [];
  const expandedTerms = rawTerms
    .filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t: string) => t.trim())
    .slice(0, 10);

  // 解析 needsHighRecall
  const needsHighRecall = parsed?.needsHighRecall === true;

  // v1.3.4 解析 skipSearch（闲聊短路）。严格 true 才短路，其余（false/缺失/非布尔）都不短路
  const skipSearch = parsed?.skipSearch === true;

  return { searchQueries: cleaned, intent, expandedTerms, needsHighRecall, skipSearch };
}

/** 从 LLM 输出中抠出第一个 JSON 对象（容忍 ```json fences） */
function extractFirstJson(s: string): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  // 尝试 ```json ... ``` 代码块
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // 否则找第一个完整的 { ... } 块
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  // 简单括号匹配（LLM 输出通常 < 1KB，不需要复杂 parser）
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
