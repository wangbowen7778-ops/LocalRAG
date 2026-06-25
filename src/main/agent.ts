/**
 * Agentic RAG 主循环（v1.2.0 + v1.2.4）
 *
 * 设计要点：
 * - 用 OpenAI 协议 tools（function_calling）—— LLM 调 search_kb / read_chunk / skip_search
 * - plan + critique 不分开：单轮 chatCompletion → 有 tool_calls 就执行再循环，finish_reason='stop' 才出 final
 * - 默认用 chatCompletion（非流式）跑中间步；final 答案用 chatStream 流式输出
 * - 防死循环：相同 subQuery+kbIds 命中短路；maxIterations 强制终止
 * - queryVec 复用：每个 unique sub_query 只 embed 一次
 * - 降级：Provider 不支持 tools（400/422）→ runSimpleChat 重试
 *
 * v1.2.4 改动：
 * - 加 read_chunk 工具：search_kb 只返回 preview（不返回全文），LLM 按需调 read_chunk(chunk_id) 取全文
 * - chunkMap 在主循环内 O(1) 查 chunk（chunk_id 来自 search_kb 响应中的编号）
 * - 引用追踪改在 read_chunk 调用时累计（v1.2.0 时在 search_kb 内）
 * - history 构造从 slice(-8) 改用 buildHistory（context-builder.ts）：放得下就全量，超 budget 智能截断
 * - AGENT_SYSTEM_PROMPT 加上对 read_chunk 的说明
 */
import { IPC, AGENT_TOOLS } from '../shared/constants';
import type {
  AgentStep,
  AgentTrace,
  Citation,
  KnowledgeBase,
  ProviderConfig,
  ChatMessage,
  Settings,
} from '../shared/types';
import { chatStream, chatCompletion, embedText, type ChatDelta } from './api-client';
import { hybridSearchMulti } from './vector-store';
import { resolveEmbeddingProvider } from './document-processor';
import { SecureStore } from './secure-store';
import { addMessage, touchSession, searchSessionSummaries } from './storage';
import { buildHistory } from './context-builder';
import { planSearchQuery } from './query-rewriter';
import { rerankHits } from './reranker';
import { formatChunkPreview } from './preview';

type Emit = (channel: string, data: unknown) => void;

export interface AgentInput {
  sessionId: string;
  userMsgId: string;
  userContent: string;
  /** v1.2.4: 移除 effectiveUserContent 改写（v1.2.2 query rewrite 已删除） */
  kbIds: string[];
  provider: ProviderConfig;
  apiKey: string;
  model: string;
  temperature: number;
  /** 每次子问题检索的 topK（agentTopKPerQuery） */
  topK: number;
  /** Agent 循环最大次数 */
  maxIterations: number;
  /** 相似度阈值（citationScoreThreshold），0 关闭过滤 */
  scoreThreshold: number;
  enableBm25: boolean;
  /** 是否已经走过了 LLM 自选 KB（避免重复算） */
  didKBSelection: boolean;
  /** 供 buildHistory 预算计算 + middle 压缩 */
  settings: Settings;
  /** v1.3.0 是否启用查询理解管线（query-rewriter）。默认开启（与 Settings.enableQueryRewriter 同步） */
  enableQueryRewriter?: boolean;
  /** v1.3.2 是否启用检索后 LLM rerank。默认开启（与 Settings.enableRerank 同步） */
  enableRerank?: boolean;
}

/**
 * v1.2.4 检索结果 hit，存进 chunkMap 供 read_chunk 工具查
 */
interface RetrievedChunk {
  docId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  score: number;
}

/**
 * Agent 主入口。
 * 抛出任何错误会冒泡到 ipc-handlers，ipc-handlers 可以选择 catch 后回退到 simple 模式。
 */
export async function runAgent(
  emit: Emit,
  input: AgentInput,
): Promise<{ assistantMsgId: string; finalText: string; trace: AgentTrace }> {
  const t0 = Date.now();
  const sess = input.sessionId;
  const log = (...args: unknown[]) => console.log('[agent]', `session=${sess}`, ...args);

  // 1) 构造历史：用 buildHistory（context-builder.ts）智能截断
  //    v1.2.4 改动：从 slice(-8) 改为 buildHistory，能放得下就全量，超 budget 截断
  const sysPrompt = AGENT_SYSTEM_PROMPT;
  const userContent = input.userContent;
  const { history: histFromBuilder, middleSummary } = await buildHistory({
    sessionId: sess,
    currentUserMsgId: input.userMsgId,
    model: input.model,
    excludeRoles: ['tool'],
    settings: input.settings,
    // promptOverhead 在 agent 流里无法精确预算（tool 响应会增加）—— 传 sysPrompt 让 builder 知道 system 占位
    promptOverhead: { sysPrompt },
  });

  // 1.5) v1.3.0：query 理解管线 — 产出一组「已改写候选 query」注入到 system prompt，
  //      作为 LLM 调 search_kb 时的子问题参考。LLM 仍可自行分解（保持自主权），
  //      但有了更好的起点，减少「指代 / 模糊 / 多意图 query」直接 search_kb 召回差的情况。
  //      关闭 enableQueryRewriter 时跳过该步（与简单模式行为一致）。
  let planHint = '';
  if (input.enableQueryRewriter !== false) {
    const plan = await planSearchQuery({
      sessionId: sess,
      currentUserMsgId: input.userMsgId,
      currentQuery: userContent,
      settings: input.settings,
    });
    if (plan.usedLlm && plan.searchQueries.length > 0) {
      // 仅在「改写后与原 query 不同 / 出现多 query」时打印 log（passthrough 时不刷屏）
      const differs = plan.searchQueries.length > 1 || plan.searchQueries[0] !== userContent.trim();
      if (differs) {
        log(
          `query-plan intent=${plan.intent} queries=${plan.searchQueries.length} ` +
            `steps=[${plan.steps.join(',')}] ` +
            `"${userContent.slice(0, 30)}..." → ${plan.searchQueries.map((q) => `"${q.slice(0, 30)}..."`).join(', ')}`,
        );
        planHint =
          '\n\n【已改写候选 query（v1.3.0 query-rewriter 产出，供参考；sub_query 仍由你自主决定）】\n' +
          plan.searchQueries.map((q, i) => `- ${i + 1}. ${q}`).join('\n');
      }
    }
  }

  // 注入跨 session 摘要到第一条 user 消息（与 simple 模式一致：searchSessionSummaries 命中 top 2）
  const pastSummariesInit = searchSessionSummaries(userContent, 2);
  const summaryBlockInit =
    pastSummariesInit.length > 0
      ? '【历史对话摘要】\n' +
        pastSummariesInit
          .map(
            (s, i) =>
              `[#H${i + 1} ${new Date(s.createdAt).toLocaleString('zh-CN')}] ${s.summary}`,
          )
          .join('\n\n') +
        '\n\n'
      : '';

  let messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        sysPrompt +
        planHint +
        (middleSummary ? '\n\n【早期对话摘要】' + middleSummary : ''),
    },
    ...histFromBuilder,
    { role: 'user', content: summaryBlockInit + userContent },
  ];

  // 2) 准备 embedding provider（Agent 模式下会按需调 embedText）
  const embedProvider = await resolveEmbeddingProvider();
  const embedKey = await SecureStore.getApiKey(embedProvider.id);
  if (!embedKey) {
    throw new Error('embedding Provider 缺少 API Key');
  }

  // 3) 循环
  const steps: AgentStep[] = [];
  const allCitations: Citation[] = [];
  const subQueryCache = new Set<string>(); // "subQuery|kbIds.join(',')" 去重
  const queryVecCache = new Map<string, number[]>(); // subQuery → vec
  const chunkMap = new Map<string, RetrievedChunk>(); // chunkId → chunk（v1.2.4: 供 read_chunk 工具查）
  let chunkIdCounter = 0;
  let finalText = '';
  let iteration = 0;

  while (iteration < input.maxIterations) {
    iteration++;
    const isFirst = iteration === 1;
    emit(IPC.EVT_CHAT_AGENT_PHASE, {
      sessionId: sess,
      phase: isFirst ? 'planning' : 'critiquing',
      iteration,
    });
    log(`iter=${iteration} phase=${isFirst ? 'planning' : 'critiquing'}`);

    const tStep0 = Date.now();
    const result = await chatCompletion(
      input.provider,
      input.apiKey,
      input.model,
      messages,
      input.temperature,
      { tools: AGENT_TOOLS, toolChoice: 'auto' },
    );
    log(
      `iter=${iteration} finish_reason=${result.finishReason} ` +
        `content_len=${result.content.length} tool_calls=${result.toolCalls.length}`,
    );

    // 终止条件 1：模型给最终答案（finish_reason=stop 且有 content 或没 tool_calls）
    if (result.toolCalls.length === 0) {
      if (result.content) {
        finalText = result.content;
        steps.push({
          kind: 'critique',
          thought: result.content,
          latencyMs: Date.now() - tStep0,
        });
        emit(IPC.EVT_CHAT_AGENT_STEP, { sessionId: sess, step: steps[steps.length - 1], iteration });
        break;
      }
      // 都没内容也都没 tool_calls —— break 走兜底
      break;
    }

    // 终止条件 2：把 assistant 消息（含 tool_calls）回填到 messages
    messages.push({
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls,
    });

    // 终止条件 3：执行每个 tool_call
    for (const tc of result.toolCalls) {
      const args = safeJsonParse(tc.function.arguments);
      const stepBase: AgentStep = {
        kind: 'search',
        thought: result.content || undefined,
        toolName: tc.function.name,
        toolArgs: args ?? undefined,
      };

      if (tc.function.name === 'search_kb') {
        const sub = String(args?.sub_query ?? userContent).trim();
        // 限定检索 KB：参数 kb_ids 非空且与允许集相交 → 用它；否则用全部 kbIds
        const requestedKbIds = Array.isArray(args?.kb_ids) ? (args!.kb_ids as string[]) : [];
        const validRequested = requestedKbIds.filter((id) => input.kbIds.includes(id));
        const targets = validRequested.length > 0 ? validRequested : input.kbIds;

        // 重复 subQuery+kbIds 短路
        const cacheKey = sub + '|' + targets.slice().sort().join(',');
        if (subQueryCache.has(cacheKey)) {
          log(`sub_query repeated: "${sub}" (kbIds=${targets.join(',')}) → 短路`);
          steps.push({
            ...stepBase,
            kind: 'search',
            subQueries: [sub],
            kbIds: targets,
            hitCount: 0,
            latencyMs: 0,
          });
          emit(IPC.EVT_CHAT_AGENT_STEP, { sessionId: sess, step: steps[steps.length - 1], iteration });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: 'search_kb',
            content: '（此子问题已检索过，未发现新内容）',
          });
          continue;
        }
        subQueryCache.add(cacheKey);

        emit(IPC.EVT_CHAT_AGENT_PHASE, {
          sessionId: sess,
          phase: 'searching',
          iteration,
          subQuery: sub,
        });
        const tSearch0 = Date.now();
        let qvec = queryVecCache.get(sub);
        if (!qvec) {
          qvec = await embedText(embedProvider, embedKey, sub);
          queryVecCache.set(sub, qvec);
        }
        // v1.3.2：rerank 开时扩召回到 max(topK,20)，rerank 后再 slice topK
        const enableRerank = input.enableRerank !== false;
        const fetchTopK = enableRerank ? Math.max(input.topK, 20) : input.topK;
        const rawHits = await hybridSearchMulti(targets, sub, qvec, fetchTopK, {
          enableBm25: input.enableBm25,
        });
        // v1.3.2：LLM rerank 先于 threshold 过滤（与简单模式一致），救回被 RRF 排到 topK 外的正确答案
        let filtered = rawHits;
        if (enableRerank && filtered.length > 1) {
          filtered = await rerankHits(sub, filtered, input.settings);
        }
        filtered = filtered.slice(0, input.topK);
        if (input.scoreThreshold > 0) filtered = filtered.filter((h) => h.score >= input.scoreThreshold);
        const searchLatency = Date.now() - tSearch0;
        log(
          `search sub="${sub}" kbIds=[${targets.join(',')}] hits=${rawHits.length} ` +
            `after_rerank_threshold=${filtered.length} (${searchLatency}ms)`,
        );

        // v1.2.4：把检索结果灌进 chunkMap + 返回 preview 索引（不返回全文，LLM 按需 read_chunk）
        // v1.3.3：rerank 启用时直接发全文（同简单模式），避免 LLM 不调 read_chunk 导致截断。
        //   rerank 已精确挑出语义最相关的 filtered，全文成本可接受；chunkMap 仍建（read_chunk 兜底）。
        //   rerank 关闭时保持 preview 流（无 rerank 时 chunk 质量参差，LLM 选择性读省 token）。
        const contentLines: string[] = [];
        for (const h of filtered) {
          const chunkId = String(++chunkIdCounter);
          chunkMap.set(chunkId, {
            docId: h.docId,
            filename: h.filename,
            chunkIndex: h.chunkIndex,
            text: h.text,
            score: h.score,
          });
          if (enableRerank) {
            // rerank 开：发全文（不截断、无 TRUNCATED 标记，LLM 直接拿到完整内容）
            contentLines.push(`[#${chunkId} ${h.filename}]\n${h.text}`);
          } else {
            // rerank 关：发 preview（v1.2.7 formatChunkPreview，200 字截断 + TRUNCATED 标记）
            contentLines.push(formatChunkPreview(h, chunkId));
          }
        }
        const toolContent =
          contentLines.length > 0
            ? contentLines.join('\n\n') +
              (enableRerank
                ? '' // 全文模式无需提示调 read_chunk
                : '\n\n（要看完整内容，调 read_chunk(chunk_id) 工具，参数是上面 #N 中的 N）')
            : '（未检索到与该子问题相关的内容）';

        steps.push({
          ...stepBase,
          subQueries: [sub],
          kbIds: targets,
          hitCount: filtered.length,
          latencyMs: searchLatency,
        });
        emit(IPC.EVT_CHAT_AGENT_STEP, { sessionId: sess, step: steps[steps.length - 1], iteration });

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: 'search_kb',
          content: toolContent,
        });
      } else if (tc.function.name === 'read_chunk') {
        // v1.2.4：按 chunk_id 取完整内容 + 累计到 citations（v1.2.0 时 citations 累计在 search_kb）
        const chunkId = String(args?.chunk_id ?? '').trim();
        const chunk = chunkMap.get(chunkId);
        if (!chunk) {
          log(`read_chunk 未知 chunk_id: ${chunkId}`);
          steps.push({
            ...stepBase,
            kind: 'search',
            thought: `read_chunk(${chunkId}) - 未知 ID（可能 LLM 调了已被清理的 chunk）`,
            latencyMs: 0,
          });
          emit(IPC.EVT_CHAT_AGENT_STEP, { sessionId: sess, step: steps[steps.length - 1], iteration });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: 'read_chunk',
            content: `（未找到 chunk #${chunkId}，可能该 chunk 已不在当前上下文）`,
          });
          continue;
        }
        // 累计到 citations（去重）——v1.2.7 chunk 改存全文
        if (
          !allCitations.some(
            (c) => c.docId === chunk.docId && c.chunk === chunk.text,
          )
        ) {
          allCitations.push({
            docId: chunk.docId,
            filename: chunk.filename,
            chunk: chunk.text, // v1.2.7 改存全文
            score: chunk.score,
          });
        }
        steps.push({
          ...stepBase,
          kind: 'search',
          thought: `read_chunk(${chunkId}) - 已读完整内容`,
          latencyMs: 0,
        });
        emit(IPC.EVT_CHAT_AGENT_STEP, { sessionId: sess, step: steps[steps.length - 1], iteration });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: 'read_chunk',
          content: chunk.text,
        });
      } else if (tc.function.name === 'skip_search') {
        const reason = String(args?.reason ?? '').trim();
        steps.push({
          ...stepBase,
          kind: 'skip',
          thought: reason || undefined,
        });
        emit(IPC.EVT_CHAT_AGENT_STEP, { sessionId: sess, step: steps[steps.length - 1], iteration });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: 'skip_search',
          content: 'NO_RESULTS',
        });
      } else {
        // 未知 tool：回个错误让 LLM 知道
        log(`unknown tool: ${tc.function.name}`);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: `（错误：未知工具 ${tc.function.name}）`,
        });
      }
    }
    // 继续下一轮
  }

  // 4) 兜底：循环结束还没拿到 finalText（maxIter 用完 / 模型罢工）
  if (!finalText) {
    log(`fallback: no final after iter=${iteration}, forcing final via plain chatCompletion`);
    emit(IPC.EVT_CHAT_AGENT_PHASE, { sessionId: sess, phase: 'finalizing', iteration });
    // 用已经读过的 citations 拼 context（v1.2.4：allCitations 仅含 LLM 实际 read_chunk 的）
    const contextText =
      allCitations.length > 0
        ? allCitations.map((c, i) => `[#${i + 1} ${c.filename}]\n${c.chunk}`).join('\n\n')
        : '（未检索到相关文档）';
    const pastSummaries = searchSessionSummaries(userContent, 2);
    const summaryBlock =
      pastSummaries.length > 0
        ? '【历史对话摘要】\n' +
          pastSummaries
            .map(
              (s, i) =>
                `[#H${i + 1} ${new Date(s.createdAt).toLocaleString('zh-CN')}] ${s.summary}`,
            )
            .join('\n\n') +
          '\n\n'
        : '';
    const finalUserPrompt =
      summaryBlock +
      `【已收集的参考资料】\n${contextText}\n\n【用户问题】\n${userContent}\n\n` +
      `请基于以上资料直接给出最终回答（不要再调用工具）。`;
    const fallback = await chatCompletion(
      input.provider,
      input.apiKey,
      input.model,
      [...messages, { role: 'user', content: finalUserPrompt }],
      input.temperature,
    );
    finalText = fallback.content;
  }

  // 5) 流式输出 finalText（不带 tools）
  emit(IPC.EVT_CHAT_AGENT_PHASE, { sessionId: sess, phase: 'finalizing', iteration });
  // v1.2.3 历史对话摘要
  const pastSummaries = searchSessionSummaries(userContent, 2);
  const summaryBlock =
    pastSummaries.length > 0
      ? '【历史对话摘要】\n' +
        pastSummaries
          .map(
            (s, i) =>
              `[#H${i + 1} ${new Date(s.createdAt).toLocaleString('zh-CN')}] ${s.summary}`,
          )
          .join('\n\n') +
        '\n\n'
      : '';
  const finalStreamMessages: ChatMessage[] = [
    { role: 'system', content: sysPrompt },
    // 复用 messages 里非 tool 的对话历史 + 累积的所有 citations 拼成 context user
    ...messages.filter((m) => m.role !== 'tool'),
    {
      role: 'user',
      content:
        allCitations.length > 0
          ? summaryBlock +
            `【参考资料】\n${allCitations
              .map((c, i) => `[#${i + 1} ${c.filename}]\n${c.chunk}`)
              .join('\n\n')}\n\n【用户问题】\n${userContent}\n\n请基于以上资料回答。`
          : summaryBlock + userContent,
    },
  ];

  let streamed = '';
  await chatStream(
    input.provider,
    input.apiKey,
    input.model,
    finalStreamMessages,
    input.temperature,
    (d: ChatDelta) => {
      if (d.content) {
        streamed += d.content;
        emit(IPC.EVT_CHAT_TOKEN, { sessionId: sess, delta: d.content, done: false });
      }
    },
  );
  if (streamed) finalText = streamed;

  // 6) 持久化（v1.2.4 修复：不再把 "**引用来源**" markdown 拼到 finalText，
  //    UI 的 MessageBubble 会从 message.citations 字段单独渲染引用来源——重复会双显示）
  const assistantMsgId = 'msg_' + (Date.now() + 1).toString(36);
  const trace: AgentTrace = {
    steps,
    totalLatencyMs: Date.now() - t0,
    kbIds: input.kbIds,
    iterations: iteration,
    didKBSelection: input.didKBSelection,
  };
  addMessage({
    id: assistantMsgId,
    sessionId: sess,
    role: 'assistant',
    content: finalText,
    citations: allCitations,
    agentTrace: trace,
  });
  touchSession(sess);

  emit(IPC.EVT_CHAT_TOKEN, { sessionId: sess, delta: '', done: true });
  emit(IPC.EVT_CHAT_DONE, { sessionId: sess, messageId: assistantMsgId });

  return { assistantMsgId, finalText, trace };
}

function safeJsonParse(s: string | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * v1.2.0 引入：多 KB 模式下让 LLM 自己挑要搜哪些 KB（基于 KB name + description）。
 * 用户问"代码里怎么调 X"→ LLM 看到代码库的 description → 只挑 code KB。
 * 失败兜底：返回原 candidateKbIds（不阻塞主流程）。
 */
export async function selectKBs(
  userContent: string,
  allKBs: KnowledgeBase[],
  candidateKbIds: string[],
  provider: ProviderConfig,
  apiKey: string,
  model: string,
): Promise<string[]> {
  const candidates = allKBs.filter((k) => candidateKbIds.includes(k.id));
  if (candidates.length <= 1) return candidateKbIds;

  const kbList = candidates
    .map((k) => `- ${k.id} | ${k.name}${k.description ? ` | ${k.description}` : ''}`)
    .join('\n');
  const sysPrompt = `你是一个知识库路由助手。给定用户问题和候选 KB 列表（含 id / 名称 / 描述），输出用户最可能需要的 KB id 列表。
要求：
- 严格输出 JSON 数组：["kb_id_1", "kb_id_2"]，id 必须在候选列表中
- 至少 1 个，最多全部；不相关的不要选
- 用户问"代码"就选 description 含"代码"/"code"/"API"的 KB
- 用户问"文档"就选 description 含"文档"/"文档"/"手册"/"规范"的 KB
- 不要解释，不要 Markdown`;
  const userPrompt = `【候选知识库】\n${kbList}\n\n【用户问题】\n${userContent}\n\n请输出 JSON 数组。`;

  try {
    const r = await chatCompletion(provider, apiKey, model, [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt },
    ], 0);
    // 抠 JSON 数组
    const m = r.content.match(/\[[\s\S]*?\]/);
    if (!m) return candidateKbIds;
    const ids = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(ids)) return candidateKbIds;
    const valid = ids.filter((x): x is string => typeof x === 'string' && candidateKbIds.includes(x));
    return valid.length > 0 ? valid : candidateKbIds;
  } catch (e) {
    console.warn('[agent] selectKBs 失败，回退到全部候选 KB：', (e as Error).message);
    return candidateKbIds;
  }
}

/** 路由 KB 选择用——只用到 id / name / description */
// KnowledgeBaseLite 接口已合并到 shared/types.KnowledgeBase

const AGENT_SYSTEM_PROMPT = `你是一个严谨的本地知识库助手（Agentic RAG 模式）。

⚠ 调 search_kb 之前：sub_query 必须自包含
检索系统（向量库 + BM25）**看不到对话历史**，只看 sub_query 这一个字符串做相似度匹配。
用户问题含指代/省略时（"它"/"那"/"第几章"/"为什么"/"详细说说"），必须用对话历史里
具体的实体名（条例名、文件名、产品名、章节号、专有名词）补全后再传 sub_query。

示例：
- 上文聊《北京市殡葬管理条例》第十四条规定殡仪服务人员的职业道德，用户问 "第几章？"
  → sub_query="北京市殡葬管理条例 第十四条"（带条例名 + 条款编号，能命中含该条所属章节的片段）
- 上文聊 OpenAI API，用户问 "它的限流策略呢"
  → sub_query="OpenAI API 限流策略"（用 OpenAI API 替换"它"）
- 用户自包含问 "5G 和 4G 的区别"
  → sub_query="5G 和 4G 的区别"（原样使用）

工具：
- search_kb(sub_query, kb_ids?): 检索候选片段。响应返回【索引 + preview + score】列表，**不包含完整内容**。v1.2.7 起被截断的 preview 末尾会显式标 [TRUNCATED: 共 N 字...]。
- read_chunk(chunk_id): 按 search_kb 响应中的 #N 编号读取完整内容。**v1.2.7 硬规则**：preview 末尾出现 [TRUNCATED: 共 N 字...] 标记 且 内容像列举/条款/编号型（(一)(二)(三) / 第N条/章/款 / 1.1.2 / A. B. C. / - 列表项）→ **必须**调 read_chunk 拿完整内容再引用——避免把被截断的 preview 当成完整列表答错（用户实测：条例 "(一)~(六) 条款" 漏答 (六) 设立分支机构，就是 LLM 把 preview 当成全部）。短问题（"总结一下"/"什么主题"）可以基于 preview 直答。
- skip_search(reason): 闲聊/常识/数学/代码等无需检索的场景；或【对话历史已含充分答案、无需新检索】时也可用。

工作流：
1. 拿到 search_kb 响应后判断：信息足够就直接回答（不要再调工具）；不够就调 read_chunk 读必要的片段
2. 多次 search_kb 可以叠加（不同 sub_query），用 kb_ids 限定范围
3. 回答时引用请在末尾用 Markdown 列表标注 [#n]（n 是 read_chunk 调用的 chunk_id 或 search_kb 响应中的编号）
4. **不要**在回答里出现 [TRUNCATED...] 标记本身（那是给 LLM 看的内部信号）

v1.3.0：system prompt 末尾可能由 query-rewriter 注入一段「已改写候选 query」——
那是检索侧已经基于 history 改写/扩展/分解过的 1-3 条参考 query，**仅作参考**。
你仍可基于 user content 自主决定 sub_query（如果觉得改写版不好可以无视）。开启「设置 → 常规 →
查询改写 / 扩展」开关可关闭该注入。`;
