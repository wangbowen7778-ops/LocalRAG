/**
 * IPC 处理器注册中心
 * 所有 ipcMain.handle 在此集中管理
 *
 * v1.2.4 改动：
 * - 删 applyQueryRewrite + 全部 v1.2.2 改写逻辑（v1.2.2 改写被 context-builder 替代）
 * - runSimpleChat 改为支持 read_chunk 工具流：先发"索引 + preview"给 LLM，LLM 按需调 read_chunk(chunk_id) 取全文
 * - runSimpleChat 退路：enableReadChunkTool=false / Provider 不支持 tools → 用旧"topK 全文"行为
 * - history 改用 buildHistory 智能构造（替代 slice(-8) 硬切）
 * - maybeSummarizeSession 改用 resolveSummaryProvider（v1.2.4 重命名）
 */
import { ipcMain, BrowserWindow, dialog, app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { IPC, VECTRA, READ_CHUNK_TOOL } from '../shared/constants';
import { ApiError } from '../shared/types';
import {
  listKBs,
  createKB,
  renameKB,
  deleteKB,
  getKB,
  listDocs,
  createDoc,
  getDoc,
  deleteDoc,
  updateKBStats,
  markStuckDocsAsFailed,
  getSettings,
  updateSettings,
  listProviders,
  upsertProvider,
  deleteProviderRow,
  createSession,
  listSessions,
  listMessages,
  addMessage,
  touchSession,
  deleteSession,
  getSession,
  getUserDataDir,
  addSessionSummary,
  getLatestSessionSummary,
  searchSessionSummaries,
} from './storage';
import { SecureStore } from './secure-store';
import {
  deleteDocChunks,
  resolveEmbeddingProvider,
  runOcrSelfTest,
  resolveSummaryProvider,
} from './document-processor';
import { deleteCollection, listChunksByDoc, bm25RebuildFromVectra, hybridSearchMultiQuery, type SearchHit } from './vector-store';
import { UploadQueue } from './upload-queue';
import { chatStream, embedText, summarizeConversation } from './api-client';
import { runAgent, selectKBs } from './agent';
import { buildHistory } from './context-builder';
import { planSearchQuery } from './query-rewriter';
import { rerankHits } from './reranker';
import { formatChunkPreview } from './preview';
import type {
  ProviderConfig,
  ChatTokenEvent,
  ChatMessage,
  Citation,
} from '../shared/types';

type WindowGetter = () => BrowserWindow | null;

function safeHandle<T>(channel: string, fn: (...args: any[]) => Promise<T>) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ApiError) throw { code: err.code, message: err.message, detail: err.detail };
      console.error(`[IPC ${channel}]`, err);
      throw { code: 'E_INTERNAL', message: (err as Error).message };
    }
  });
}

function emit<T>(getWin: WindowGetter, channel: string, data: T) {
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send(channel, data);
}

/**
 * v1.2.3 周期摘要：自上次摘要以来新增的 user turn ≥ summaryTriggerTurns → 触发。
 * fire-and-forget，不阻塞 chat 主流程；失败仅 console.warn。
 * v1.2.4 改动：resolveRewriterProvider → resolveSummaryProvider（统一名字）
 */
async function maybeSummarizeSession(
  sessionId: string,
  currentUserMsgId: string,
  _chatApiKey: string,
  settings: ReturnType<typeof getSettings>,
): Promise<void> {
  const triggerTurns = settings.summaryTriggerTurns ?? 20;
  if (triggerTurns <= 0) return; // 0 = 关闭

  // 1. 找上次摘要的 endMsgId（可能为空 = 第一次）
  const lastSummary = getLatestSessionSummary(sessionId);
  const allMessages = listMessages(sessionId);
  if (allMessages.length === 0) return;

  // 2. 找"自上次摘要结束到当前 user msg"的新增 user 消息
  const startIdx = lastSummary
    ? allMessages.findIndex((m) => m.id === lastSummary.endMsgId) + 1
    : 0;
  const endIdx = allMessages.findIndex((m) => m.id === currentUserMsgId);
  if (endIdx < 0) return;

  const newMessages = allMessages.slice(startIdx, endIdx); // 不含当前 user msg
  const newUserTurns = newMessages.filter((m) => m.role === 'user').length;
  if (newUserTurns < triggerTurns) return;

  // 3. 准备待摘要内容：把每条 msg 压成 "role: content" 单行（去换行）
  //    控制总量：最多 40 条 / 8000 字（防 LLM context 爆）
  const compact = newMessages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-40)
    .map((m) => {
      const c = (m.content ?? '').replace(/\s+/g, ' ').trim();
      return `${m.role === 'user' ? '用户' : '助手'}：${c.length > 600 ? c.slice(0, 600) + '…' : c}`;
    });
  if (compact.length === 0) return;
  const compactStr = compact.join('\n');
  if (compactStr.length > 8000) {
    console.warn(`[chat] [summary] 待摘要内容 ${compactStr.length} 字超 8000，截断`);
  }

  // 4. 调 LLM 生成摘要（v1.2.4：统一用 resolveSummaryProvider，不支持独立 rewriter）
  const { provider: sumProvider, model: sumModel } = resolveSummaryProvider(settings);
  const sumKey = await SecureStore.getApiKey(sumProvider.id);
  if (!sumKey) return;

  const result = await summarizeConversation(
    sumProvider,
    sumKey,
    sumModel,
    compact.map((s) => ({
      role: s.startsWith('用户：') ? ('user' as const) : ('assistant' as const),
      content: s.replace(/^(用户|助手)：/, ''),
    })),
  );
  if (!result || !result.summary) {
    console.warn('[chat] [summary] 摘要生成失败，跳过');
    return;
  }

  // 5. 写入 session_summaries
  const newMessagesForRange = newMessages.filter(
    (m) => m.role === 'user' || m.role === 'assistant',
  );
  if (newMessagesForRange.length === 0) return;
  addSessionSummary({
    id: 'sum_' + Date.now().toString(36),
    sessionId,
    startMsgId: newMessagesForRange[0].id,
    endMsgId: newMessagesForRange[newMessagesForRange.length - 1].id,
    summary: result.summary,
    keyTopics: result.keyTopics,
    keyEntities: result.keyEntities,
  });
  console.log(
    `[chat] [summary] session=${sessionId} 摘要已生成：${newUserTurns} turns, ${result.summary.length} 字`,
  );
}

/**
 * v1.2.4 检索结果 hit，存进 chunkMap 供 read_chunk 工具查
 */
// RetrievedChunk = SearchHit（避免重复定义）

const SIMPLE_CHAT_SYS_PROMPT = `你是一个严谨的本地知识库助手。
【参考资料】会列出检索到的文档片段，每条格式为 [#N 文件名 | score] + preview（节选，v1.2.7 起被截断时会显式标 [TRUNCATED: 共 N 字...]）。
- preview 足够回答简短问题（如"总结一下"/"什么主题"）；要引用具体细节先调 read_chunk(chunk_id) 拉完整内容
- **硬规则（v1.2.7）**：preview 末尾出现 [TRUNCATED: 共 N 字...] 标记 且 内容看起来像列举/条款/编号型（(一)(二)(三) / 第N条/章/款 / 1.1.2 / A. B. C. / - 列表项 等）→ **必须先调 read_chunk(N) 拿完整内容再引用**——避免把被截断的 preview 当成完整列表答错（用户实测：条例 "(一)~(六) 条款" 漏答 (六) 设立分支机构，就是 LLM 没调 read_chunk 把 preview 当成全部）
- 引用请在末尾用 Markdown 列表标注 [#n]；**不要**在回答里出现 [TRUNCATED...] 标记本身（那是给 LLM 看的）
【历史对话摘要】是同一知识库下其它会话中聊过的相关话题，可以引用但不是当前文档知识的一部分。`;

/**
 * 简单模式 chat（v1.2.4 重构）：
 * - 单 KB 混合检索 → 把 topK chunk 索引（preview）发 LLM
 * - LLM 按需调 read_chunk(chunk_id) 拉完整内容（用 chatStream + tools）
 * - read_chunk 命中的 chunk 累计到 citations
 * - 退路：enableReadChunkTool=false 或 Provider 不支持 tools → 用旧"topK 全文"路径
 * - history 走 buildHistory（context-builder.ts）智能截断
 *
 * 抛出任何错误会冒泡到 CHAT_SEND 调用方。
 */
async function runSimpleChat(
  getMainWindow: WindowGetter,
  sessionId: string,
  userMsgId: string,
  payload: {
    content: string;
    model: string;
    temperature?: number;
    topK?: number;
  },
  provider: ProviderConfig,
  apiKey: string,
  settings: ReturnType<typeof getSettings>,
  kbId: string,
) {
  const topK = payload.topK ?? settings.topK;
  const scoreThreshold = settings.citationScoreThreshold ?? 0.4;
  const enableBm25 = settings.enableBm25 !== false;
  const useReadChunkTool = settings.enableReadChunkTool !== false; // 默认开
  const enableQueryRewriter = settings.enableQueryRewriter !== false; // v1.3.0 默认开
  const enableRerank = settings.enableRerank !== false; // v1.3.2 默认开
  // v1.3.2：rerank 时扩召回到 20（不改 vector-store 签名，调用方传大 topK），rerank 后再 slice topK。
  // 让 LLM 在更大候选池里按语义挑，救回被 RRF 排到 topK 外的正确答案。
  const fetchTopK = enableRerank ? Math.max(topK, 20) : topK;

  // v1.3.5：分步耗时打点——定位简单模式慢在哪步（plan/embed/search/rerank/stream）。
  const timing: Record<string, number> = {};
  const tTotal0 = Date.now();

  // ===== 1) 检索（v1.3.0：先 query 理解管线，再多 query RRF 融合）=====
  // 旧 v1.2.6 是单 query 改写（resolveSearchQuery → hybridSearch）。
  // v1.3.0 升级为多 query 改写（planSearchQuery → hybridSearchMultiQuery）——
  // 解决口语化/短 query/多意图 query 召回差的问题。
  // 关闭 enableQueryRewriter 时退化为 v1.2.6 行为（单条原 query）。
  // LLM 端 user prompt 仍用 payload.content（LLM 反正看全 history 自行消解）。
  let searchQueries: string[] = [payload.content];
  let skipSearch = false;
  if (enableQueryRewriter) {
    const tPlan0 = Date.now();
    const plan = await planSearchQuery({
      sessionId,
      currentUserMsgId: userMsgId,
      currentQuery: payload.content,
      settings,
    });
    timing.plan = Date.now() - tPlan0;
    searchQueries = plan.searchQueries;
    skipSearch = plan.skipSearch;
    if (plan.usedLlm && plan.steps.some((s) => s === 'llm-rewrite' || s === 'llm-decompose' || s === 'llm-expand')) {
      console.log(
        `[chat] [query-plan] intent=${plan.intent} queries=${searchQueries.length} ` +
          `steps=[${plan.steps.join(',')}] ` +
          `"${payload.content.slice(0, 30)}..." → ${searchQueries.map((q) => `"${q.slice(0, 30)}..."`).join(', ')}`,
      );
    }
    if (skipSearch) {
      console.log(`[chat] [skip-search] 闲聊短路，跳过检索："${payload.content.slice(0, 30)}..."`);
    }
  }
  const allHits: SearchHit[] = [];
  let allCitations: Citation[] = [];
  let contextText = '（未检索到与本问题相关的文档内容）';

  // v1.3.4：闲聊短路——skipSearch=true 时跳过 embed/检索/rerank，直接走主答（无 context）。
  // 省 1-3 次 embed API + 1 次 hybridSearch + 1 次 rerank LLM 调用。"你好/谢谢/在吗"等纯问候
  // 首轮用 cheap regex 检测，多轮用 planWithLlm 的 LLM 判断。失败兜底 skipSearch=false（宁可不短路别漏答）。
  if (!skipSearch) {
    try {
      const embedProvider = await resolveEmbeddingProvider();
      const embedKey = await SecureStore.getApiKey(embedProvider.id);
      if (!embedKey) throw new Error('embedding Provider 缺少 API Key');
      // v1.3.0：并发 embed 每条 query（最多 3 条，planSearchQuery 上限）
      const tEmbed0 = Date.now();
      const queryVecs: number[][] = await Promise.all(
        searchQueries.map((q) => embedText(embedProvider, embedKey, q)),
      );
      timing.embed = Date.now() - tEmbed0;
      // v1.3.0：多 query RRF 融合（单 query 退化为 hybridSearch fastpath）
      // v1.3.2：fetchTopK 扩召回（rerank 开时 = max(topK,20)），rerank 后再 slice(topK)
      const tSearch0 = Date.now();
      const rawHits = await hybridSearchMultiQuery(kbId, searchQueries, queryVecs, fetchTopK, { enableBm25 });
      timing.search = Date.now() - tSearch0;
      // v1.3.2：LLM rerank 先于 threshold 过滤——让 LLM 在更大候选池里挑，
      // 否则 threshold 会先砍掉低 RRF 分但语义相关的 chunk（本案 chunk 7 norm score 0.89 虽过线，
      // 但更一般场景下正确答案可能 RRF 分偏低被 threshold 误杀）。
      let chunks = rawHits;
      if (enableRerank && chunks.length > 1) {
        const tRerank0 = Date.now();
        chunks = await rerankHits(payload.content, chunks, settings);
        timing.rerank = Date.now() - tRerank0;
      }
      chunks = chunks.slice(0, topK); // rerank 后取 topK
      if (scoreThreshold > 0) chunks = chunks.filter((c) => c.score >= scoreThreshold);
      allHits.push(...chunks);
      // 默认 citations 用 topK 全部（向前兼容；read_chunk 流后再用 LLM 实际读的替换）
      allCitations = chunks.map((c) => ({
        docId: c.docId,
        filename: c.filename,
        chunk: c.text, // v1.2.7 改存全文（之前 .slice(0, 200) 导致 UI 引用来源被截断）
        score: c.score,
      }));
      if (chunks.length > 0) {
        contextText = chunks.map((c, i) => `[#${i + 1} ${c.filename}]\n${c.text}`).join('\n\n');
      }
    } catch (e) {
      console.warn('检索失败，继续无上下文回答', e);
    }
    // v1.3.5：检索段耗时总览（plan/embed/search/rerank 单位 ms）——定位简单模式慢在哪步
    console.log(
      `[chat] [timing] session=${sessionId} ` +
        `plan=${timing.plan ?? 0}ms embed=${timing.embed ?? 0}ms ` +
        `search=${timing.search ?? 0}ms rerank=${timing.rerank ?? 0}ms ` +
        `hits=${allHits.length} "${payload.content.slice(0, 30)}..."`,
    );
  } else {
    console.log(`[chat] [timing] session=${sessionId} skip-search（闲聊短路）`);
  }

  // ===== 2) 跨 session 摘要召回 =====
  const pastSummaries = searchSessionSummaries(payload.content, 2);
  const summaryBlock =
    pastSummaries.length > 0
      ? '【历史对话摘要】\n' +
        pastSummaries
          .map(
            (s, i) =>
              `[#H${i + 1} ${new Date(s.createdAt).toLocaleString('zh-CN')}] ${s.summary}` +
              (s.keyEntities.length > 0
                ? `\n  涉及实体：${s.keyEntities.map((e) => `${e.type}=${e.value}`).join('、')}`
                : ''),
          )
          .join('\n\n')
      : '';

  emit(getMainWindow, IPC.EVT_CHAT_CITATION, { sessionId, citations: allCitations });

  // ===== 3) 构造 history（buildHistory 智能截断）=====
  // 先把 user prompt 拼起来算 overhead；estimate 后才能精确算 budget
  // 但 overhead 本身依赖 history 决策，buildHistory 内部允许「不传 currentUserPrompt」
  // 走「能放就放」+「超了再压缩」路径，足够 80% 场景
  const { history, middleSummary } = await buildHistory({
    sessionId,
    currentUserMsgId: userMsgId,
    model: payload.model,
    excludeRoles: ['tool'],
    settings,
    promptOverhead: { sysPrompt: SIMPLE_CHAT_SYS_PROMPT, summaryBlock },
  });

  // ===== 4) 走哪条路径：read_chunk 工具流 vs 旧 topK 全文 =====
  // v1.3.3：rerank 启用时直接发 topK 全文（走 legacy 路径），不走 read_chunk preview 流——
  //   rerank 已精确挑出语义最相关的 topK，全文成本可接受（8×800≈6.4K token），
  //   且避免 LLM 不调 read_chunk 导致截断（弱模型不遵守 v1.2.7 硬规则的常见问题：
  //   runSimpleChatWithTools line 440 兜底「LLM 没调 tool 就直接用 preview 答」会答出截断内容）。
  //   rerank 关闭时保持 read_chunk 流（无 rerank 时 chunk 质量参差，LLM 选择性读省 token 有价值）。
  const useToolFlow = useReadChunkTool && allHits.length > 0 && !enableRerank;
  if (useToolFlow) {
    await runSimpleChatWithTools(
      getMainWindow,
      sessionId,
      payload,
      provider,
      apiKey,
      settings,
      allHits,
      summaryBlock,
      history,
      middleSummary,
    );
    console.log(`[chat] [timing] session=${sessionId} total=${Date.now() - tTotal0}ms (tool-flow)`);
    return;
  }
  // 退路：把 topK 全文塞给 LLM（老行为）
  await runSimpleChatLegacy(
    getMainWindow,
    sessionId,
    payload,
    provider,
    apiKey,
    settings,
    summaryBlock,
    history,
    middleSummary,
    contextText,
    allCitations,
  );
  console.log(`[chat] [timing] session=${sessionId} total=${Date.now() - tTotal0}ms (legacy)`);
}

/**
 * read_chunk 工具流（v1.2.4）：
 * 1. 把"索引 + preview"发到 LLM
 * 2. LLM 调 read_chunk(chunk_id) → 本地查 chunkMap → 追加完整内容到 messages
 * 3. 最多 1 轮 read_chunk（多了浪费 token），之后强制 chatStream 出 final
 * 4. 任何 400/422 → 降级到 runSimpleChatLegacy（用同一份 allHits + contextText）
 */
async function runSimpleChatWithTools(
  getMainWindow: WindowGetter,
  sessionId: string,
  payload: {
    content: string;
    model: string;
    temperature?: number;
  },
  provider: ProviderConfig,
  apiKey: string,
  settings: ReturnType<typeof getSettings>,
  allHits: SearchHit[],
  summaryBlock: string,
  history: ChatMessage[],
  middleSummary: string | undefined,
) {
  // 构造 chunkMap（chunk_id → hit）
  const chunkMap = new Map<string, SearchHit>();
  const previewLines: string[] = [];
  allHits.forEach((h, idx) => {
    const chunkId = String(idx + 1); // #1, #2, ...
    chunkMap.set(chunkId, h);
    previewLines.push(formatChunkPreview(h, chunkId));
  });

  const sysPrompt = SIMPLE_CHAT_SYS_PROMPT + (middleSummary ? '\n\n【早期对话摘要】' + middleSummary : '');
  const userPrompt =
    (summaryBlock ? summaryBlock + '\n\n' : '') +
    `【参考资料】\n${previewLines.join('\n\n')}\n\n` +
    `（要看完整内容，调 read_chunk(chunk_id)，chunk_id 即 #N 中的 N）\n\n` +
    `【用户问题】\n${payload.content}`;
  const messages: ChatMessage[] = [
    { role: 'system', content: sysPrompt },
    ...history,
    { role: 'user', content: userPrompt },
  ];

  // 第一轮：chatStream 带 tools，期望 LLM 调用 read_chunk
  let firstTurn;
  try {
    firstTurn = await chatStream(
      provider,
      apiKey,
      payload.model,
      messages,
      payload.temperature ?? settings.temperature,
      (d) => {
        if (!d.content) return;
        emit<ChatTokenEvent>(getMainWindow, IPC.EVT_CHAT_TOKEN, {
          sessionId,
          delta: d.content,
          done: false,
        });
      },
      { tools: [READ_CHUNK_TOOL], toolChoice: 'auto' },
    );
  } catch (e) {
    const msg = (e as Error).message;
    if (/function_calling|tools|400|422/i.test(msg)) {
      console.warn('[chat] Provider 不支持 tools，降级到 topK 全文路径：', msg);
      // 走 legacy（用 previewLines 拼的「不包含 preview 提示」的版本）
      const contextText = allHits.map((c, i) => `[#${i + 1} ${c.filename}]\n${c.text}`).join('\n\n');
      const legacyCitations: Citation[] = allHits.map((c) => ({
        docId: c.docId,
        filename: c.filename,
        chunk: c.text, // v1.2.7 改存全文
        score: c.score,
      }));
      await runSimpleChatLegacy(
        getMainWindow,
        sessionId,
        payload,
        provider,
        apiKey,
        settings,
        summaryBlock,
        history,
        middleSummary,
        contextText,
        legacyCitations,
      );
      return;
    }
    throw e;
  }

  let finalText = firstTurn.content;

  // LLM 没调 read_chunk 直接答了 → 收尾
  if (firstTurn.toolCalls.length === 0) {
    finalizeAssistantMsg(
      getMainWindow,
      sessionId,
      finalText,
      allHits.map((c) => ({
        docId: c.docId,
        filename: c.filename,
        chunk: c.text, // v1.2.7 改存全文
        score: c.score,
      })),
    );
    return;
  }

  // LLM 调了 read_chunk：执行并追加 messages
  messages.push({
    role: 'assistant',
    content: firstTurn.content || null,
    tool_calls: firstTurn.toolCalls,
  });
  const readChunkCitations: Citation[] = [];
  for (const tc of firstTurn.toolCalls) {
    if (tc.function.name !== 'read_chunk') {
      // 简单模式只注册了 read_chunk；其他 tool 一律忽略
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function.name,
        content: '（简单模式不支持此工具）',
      });
      continue;
    }
    const args = safeJsonParse(tc.function.arguments);
    const chunkId = String(args?.chunk_id ?? '').trim();
    const hit = chunkMap.get(chunkId);
    if (!hit) {
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: 'read_chunk',
        content: `（未找到 chunk #${chunkId}，可能编号错误）`,
      });
      continue;
    }
    // 累计到 citations（去重）——v1.2.7 chunk 改存全文
    if (!readChunkCitations.some((c) => c.docId === hit.docId && c.chunk === hit.text)) {
      readChunkCitations.push({
        docId: hit.docId,
        filename: hit.filename,
        chunk: hit.text, // v1.2.7 改存全文
        score: hit.score,
      });
    }
    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      name: 'read_chunk',
      content: hit.text,
    });
  }

  // 第二轮：再调 chatStream（不带 tools）让 LLM 出 final
  // 显式把已经读过的片段拼成 context 注入（保险 LLM 没正确用 tool_call 信息）
  const readContext = readChunkCitations
    .map((c, i) => `[#R${i + 1} ${c.filename}]\n${c.chunk}`)
    .join('\n\n');
  const secondUserPrompt =
    (readContext ? `【已读取的片段】\n${readContext}\n\n` : '') +
    `【用户问题】\n${payload.content}\n\n请基于已读取的片段给出最终回答。`;
  const secondMessages: ChatMessage[] = [
    ...messages,
    { role: 'user', content: secondUserPrompt },
  ];

  let secondText = '';
  try {
    await chatStream(
      provider,
      apiKey,
      payload.model,
      secondMessages,
      payload.temperature ?? settings.temperature,
      (d) => {
        if (!d.content) return;
        secondText += d.content;
        emit<ChatTokenEvent>(getMainWindow, IPC.EVT_CHAT_TOKEN, {
          sessionId,
          delta: d.content,
          done: false,
        });
      },
    );
  } catch (e) {
    emit<ChatTokenEvent>(getMainWindow, IPC.EVT_CHAT_TOKEN, {
      sessionId,
      delta: `\n\n[错误] ${(e as Error).message}`,
      done: true,
    });
    throw new ApiError('E_PROVIDER_ERR', (e as Error).message);
  }
  finalText = secondText || finalText;
  // 用 LLM 实际 read 的 chunks 作为 citations（更准确反映"用户能看到哪些引用"）
  const finalCitations = readChunkCitations.length > 0 ? readChunkCitations : allHits.map((c) => ({
    docId: c.docId,
    filename: c.filename,
    chunk: c.text, // v1.2.7 改存全文
    score: c.score,
  }));
  // 如果 citations 变了（用 readChunkCitations 替换了 allHits 的），重新推送一次让 UI 同步
  emit(getMainWindow, IPC.EVT_CHAT_CITATION, { sessionId, citations: finalCitations });
  finalizeAssistantMsg(getMainWindow, sessionId, finalText, finalCitations);
}

/**
 * 旧"topK 全文"路径（v1.2.4 退路）：
 * - enableReadChunkTool=false / Provider 不支持 tools / 检索 0 hit 时走
 * - 把 topK 全文塞 user prompt，单轮 chatStream 出 final
 */
async function runSimpleChatLegacy(
  getMainWindow: WindowGetter,
  sessionId: string,
  payload: {
    content: string;
    model: string;
    temperature?: number;
  },
  provider: ProviderConfig,
  apiKey: string,
  settings: ReturnType<typeof getSettings>,
  summaryBlock: string,
  history: ChatMessage[],
  middleSummary: string | undefined,
  contextText: string,
  citations: Citation[],
) {
  const sysPrompt = `你是一个严谨的本地知识库助手。优先基于【参考资料】回答；如果资料不足，请明确说明并基于通识回答。
【历史对话摘要】包含同一知识库下其它会话中聊过的相关话题，可以引用（例如"我们之前讨论过..."），但不是当前文档知识的一部分。回答末尾用 Markdown 列表形式列出引用的编号。`;
  const fullSysPrompt = sysPrompt + (middleSummary ? '\n\n【早期对话摘要】' + middleSummary : '');
  const userPrompt =
    (summaryBlock ? summaryBlock + '\n\n' : '') +
    `【参考资料】\n${contextText}\n\n【用户问题】\n${payload.content}`;
  const messages: ChatMessage[] = [
    { role: 'system', content: fullSysPrompt },
    ...history,
    { role: 'user', content: userPrompt },
  ];

  let fullText = '';
  try {
    await chatStream(
      provider,
      apiKey,
      payload.model,
      messages,
      payload.temperature ?? settings.temperature,
      (d) => {
        if (!d.content) return;
        fullText += d.content;
        emit<ChatTokenEvent>(getMainWindow, IPC.EVT_CHAT_TOKEN, {
          sessionId,
          delta: d.content,
          done: false,
        });
      },
    );
  } catch (e) {
    emit<ChatTokenEvent>(getMainWindow, IPC.EVT_CHAT_TOKEN, {
      sessionId,
      delta: `\n\n[错误] ${(e as Error).message}`,
      done: true,
    });
    throw new ApiError('E_PROVIDER_ERR', (e as Error).message);
  }

  finalizeAssistantMsg(getMainWindow, sessionId, fullText, citations);
}

/** 收尾：持久化 + EVT_CHAT_DONE。
 *  注意：text 不要再拼 "**引用来源**" markdown tail——UI 的 MessageBubble
 *  会从 message.citations 字段单独渲染引用来源，重复会双显示。 */
function finalizeAssistantMsg(
  getMainWindow: WindowGetter,
  sessionId: string,
  text: string,
  citations: Citation[],
) {
  const assistantMsgId = 'msg_' + (Date.now() + 1).toString(36);
  addMessage({
    id: assistantMsgId,
    sessionId,
    role: 'assistant',
    content: text,
    citations,
  });
  touchSession(sessionId);

  emit<ChatTokenEvent>(getMainWindow, IPC.EVT_CHAT_TOKEN, {
    sessionId,
    delta: '',
    done: true,
  });
  emit(getMainWindow, IPC.EVT_CHAT_DONE, { sessionId, messageId: assistantMsgId });
}

function safeJsonParse(s: string | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function registerIpcHandlers(getMainWindow: WindowGetter) {
  // initStorage() 已在 main.ts 的 app.whenReady 中预先 await，此处不再调用
  const uploadQueue = new UploadQueue(() => getMainWindow());

  // 启动恢复：上次没跑完的 pending/processing 文档标 failed（filePath 未落盘，无法重跑）
  const stuck = markStuckDocsAsFailed('上次未完成（应用关闭/崩溃）');
  if (stuck > 0) {
    console.log(`[startup] 标记 ${stuck} 个未完成文档为 failed`);
  }

  // 启动恢复：为没有 BM25 索引的 KB 自动从 vectra + chunks.json 重建
  // （v1.1.7 之前的数据没有 bm25.docs.json；新上传的文档会同步建好）
  void (async () => {
    try {
      const kbs = listKBs();
      for (const kb of kbs) {
        const n = await bm25RebuildFromVectra(kb.id);
        if (n > 0) {
          console.log(`[startup] [bm25] 为 KB「${kb.name}」回填 ${n} 个分块`);
        }
      }
    } catch (e) {
      console.warn('[startup] [bm25] 回填失败', e);
    }
  })();

  // ===== App =====
  safeHandle(IPC.APP_INFO, async () => ({
    name: app.getName(),
    version: app.getVersion(),
    userDataPath: getUserDataDir(),
    indexDir: path.join(getUserDataDir(), VECTRA.INDEX_DIR),
    platform: process.platform,
  }));

  safeHandle(IPC.APP_OPEN_DATA_DIR, async () => {
    shell.openPath(getUserDataDir());
  });

  safeHandle(IPC.APP_CLEAR_CACHE, async () => {
    const cache = path.join(getUserDataDir(), 'cache');
    if (!fs.existsSync(cache)) return { removed: 0 };
    const files = fs.readdirSync(cache);
    for (const f of files) fs.rmSync(path.join(cache, f), { recursive: true, force: true });
    return { removed: files.length };
  });

  // ===== KB =====
  safeHandle(IPC.KB_LIST, async () => listKBs());
  safeHandle(IPC.KB_GET, async (id: string) => {
    const kb = getKB(id);
    if (!kb) throw new ApiError('E_NOT_FOUND', `知识库 ${id} 不存在`);
    return kb;
  });
  safeHandle(IPC.KB_CREATE, async (payload: { name: string; description?: string }) => {
    if (!payload?.name?.trim()) throw new ApiError('E_INVALID_ARG', '名称不能为空');
    return createKB(payload.name.trim(), payload.description);
  });
  safeHandle(IPC.KB_RENAME, async (payload: { id: string; name: string }) => {
    if (!payload.name.trim()) throw new ApiError('E_INVALID_ARG', '名称不能为空');
    renameKB(payload.id, payload.name.trim());
  });
  safeHandle(IPC.KB_DELETE, async (id: string) => {
    deleteKB(id);
    // 删除整个知识库的向量索引
    await deleteCollection(id);
  });

  // ===== Doc =====
  safeHandle(IPC.DOC_PICK, async () => {
    const win = getMainWindow();
    const res = await dialog.showOpenDialog(win!, {
      title: '选择文档（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '支持格式', extensions: ['pdf', 'docx', 'md', 'markdown', 'txt'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths;
  });

  safeHandle(IPC.DOC_LIST, async (kbId: string) => listDocs(kbId));

  safeHandle(
    IPC.DOC_CHUNKS,
    async (payload: { kbId: string; docId: string }) =>
      listChunksByDoc(payload.kbId, payload.docId),
  );

  safeHandle(IPC.DOC_UPLOAD, async ({ kbId, filePath }: { kbId: string; filePath: string }) => {
    if (!fs.existsSync(filePath)) throw new ApiError('E_NOT_FOUND', '文件不存在');
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = ({
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.md': 'text/markdown',
      '.markdown': 'text/markdown',
      '.txt': 'text/plain',
    } as Record<string, string>)[ext] ?? 'application/octet-stream';

    const docId = 'doc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    // 立即写一条 pending 记录，立刻返回——用户选 1000 个文件也能秒级看到全部出现在列表里
    createDoc({
      id: docId,
      kbId,
      filename: path.basename(filePath),
      size: stat.size,
      mimeType: mime,
      status: 'pending',
    });

    // 真正的解析 / OCR / Embedding / 写向量交给后台队列（全局限并发 3）
    uploadQueue.enqueue({ docId, kbId, filePath, mimeType: mime });

    return getDoc(docId)!;
  });

  safeHandle(IPC.DOC_DELETE, async (docId: string) => {
    const doc = getDoc(docId);
    if (!doc) throw new ApiError('E_NOT_FOUND', '文档不存在');
    deleteDocChunks(doc.kbId, docId);
    deleteDoc(docId);
    // docCount / chunkCount 只在上传成功时 +1（见 DOC_UPLOAD 成功分支）。
    // 如果 doc 状态为 failed / processing，chunkCount=0，从未为 docCount 做过贡献，
    // 删除时再 -1 就会把计数拉到负数。这里只在 chunkCount>0 时回退 docCount。
    updateKBStats(doc.kbId, doc.chunkCount > 0 ? -1 : 0, -doc.chunkCount);
  });

  safeHandle(IPC.DOC_REINDEX, async (_docId: string) => {
    // TODO: 重新解析 + 删除旧向量 + 写入新向量
    throw new ApiError('E_INTERNAL', '尚未实现');
  });

  safeHandle(IPC.DOC_OCR_TEST, async () => runOcrSelfTest());

  // ===== Chat =====
  safeHandle(
    IPC.CHAT_SEND,
    async (payload: {
      kbId: string;
      kbIds?: string[]; // agent 模式可多选
      sessionId?: string;
      content: string;
      providerId: string;
      model: string;
      temperature?: number;
      topK?: number;
      mode?: 'simple' | 'agent'; // 默认由 settings.enableAgent 决定
    }) => {
      // 1. 校验 Provider & Key
      const providers = listProviders();
      const provider = providers.find((p) => p.id === payload.providerId);
      if (!provider) throw new ApiError('E_INVALID_ARG', '未找到 Provider');
      const apiKey = await SecureStore.getApiKey(payload.providerId);
      if (!apiKey) throw new ApiError('E_NOT_AUTHED', '请先配置 API Key');

      // 2. 创建/获取会话（session 仍绑在第一个 KB——兼容旧 schema）
      const session = payload.sessionId
        ? getSession(payload.sessionId) ?? createSession(payload.kbId, payload.content.slice(0, 30))
        : createSession(payload.kbId, payload.content.slice(0, 30));

      // 3. 写入用户消息
      const userMsgId = 'msg_' + Date.now().toString(36);
      addMessage({ id: userMsgId, sessionId: session.id, role: 'user', content: payload.content });
      touchSession(session.id);

      const settings = getSettings();
      const mode = payload.mode ?? (settings.enableAgent ? 'agent' : 'simple');

      // 3.5) v1.2.3 后台触发周期摘要：fire-and-forget，不阻塞主流程
      //      失败 console.warn 后跳过；下次 user 消息再试
      void maybeSummarizeSession(session.id, userMsgId, apiKey, settings);

      // 4. 解析候选 KB 列表（白名单校验）
      const allKBs = listKBs();
      const candidateKbIds = (payload.kbIds && payload.kbIds.length > 0 ? payload.kbIds : [payload.kbId])
        .filter((id) => allKBs.some((k) => k.id === id));
      if (candidateKbIds.length === 0) {
        throw new ApiError('E_INVALID_ARG', '没有可用的知识库');
      }

      // 5. agent 模式下多 KB 时走 LLM 自选
      // v1.2.4：删 effectiveUserContent 改写（v1.2.2 query rewrite 已删，
      //   agent 模式下 LLM 看到的是 buildHistory 拼出的完整 history，指代 / 省略自然消解）
      let didKBSelection = false;
      let activeKbIds = candidateKbIds;
      if (mode === 'agent' && settings.enableKBSelector !== false && candidateKbIds.length > 1) {
        emit(getMainWindow, IPC.EVT_CHAT_AGENT_PHASE, {
          sessionId: session.id,
          phase: 'kb-select',
        });
        activeKbIds = await selectKBs(
          payload.content,
          allKBs,
          candidateKbIds,
          provider,
          apiKey,
          payload.model,
        );
        didKBSelection = true;
        emit(getMainWindow, IPC.EVT_CHAT_AGENT_PHASE, {
          sessionId: session.id,
          phase: 'kb-select-done',
          kbIds: activeKbIds,
        });
      }

      // 6. 路由：agent / simple
      if (mode === 'agent') {
        try {
          await runAgent(
            (ch, d) => emit(getMainWindow, ch, d),
            {
              sessionId: session.id,
              userMsgId,
              userContent: payload.content,
              kbIds: activeKbIds,
              provider,
              apiKey,
              model: payload.model,
              temperature: payload.temperature ?? settings.temperature,
              topK: settings.agentTopKPerQuery ?? 5,
              maxIterations: settings.agentMaxIterations ?? 4,
              scoreThreshold: settings.citationScoreThreshold ?? 0.4,
              enableBm25: settings.enableBm25 !== false,
              didKBSelection,
              settings,
              // v1.3.0：与简单模式共享 enableQueryRewriter 开关
              enableQueryRewriter: settings.enableQueryRewriter !== false,
              // v1.3.2：与简单模式共享 enableRerank 开关
              enableRerank: settings.enableRerank !== false,
            },
          );
        } catch (e) {
          // Provider 不支持 tools / 其他 agent 错误 → 降级到 simple 模式重试一次
          const msg = (e as Error).message;
          if (/function_calling|tools|400|422/i.test(msg)) {
            console.warn('[chat] agent 模式失败，降级到 simple 模式：', msg);
            await runSimpleChat(
              getMainWindow,
              session.id,
              userMsgId,
              payload,
              provider,
              apiKey,
              settings,
              candidateKbIds[0],
            );
          } else {
            throw e;
          }
        }
      } else {
        await runSimpleChat(
          getMainWindow,
          session.id,
          userMsgId,
          payload,
          provider,
          apiKey,
          settings,
          candidateKbIds[0],
        );
      }

      return getSession(session.id)!;
    },
  );

  safeHandle(IPC.CHAT_SESSIONS, async (kbId?: string) => listSessions(kbId));
  safeHandle(IPC.CHAT_MESSAGES, async (sessionId: string) => listMessages(sessionId));
  safeHandle(IPC.CHAT_DELETE_SESSION, async (sessionId: string) => deleteSession(sessionId));

  // ===== Provider =====
  safeHandle(IPC.PROVIDER_LIST, async () => {
    const list = listProviders();
    return Promise.all(
      list.map(async (p) => ({ ...p, hasApiKey: await SecureStore.hasApiKey(p.id) })),
    );
  });

  safeHandle(
    IPC.PROVIDER_UPSERT,
    async (payload: Omit<ProviderConfig, 'hasApiKey'> & { apiKey?: string }) => {
      upsertProvider({
        id: payload.id,
        label: payload.label,
        baseUrl: payload.baseUrl,
        chatModel: payload.chatModel,
        embeddingModel: payload.embeddingModel,
        reasoningModel: payload.reasoningModel,
      });
      if (payload.apiKey) {
        await SecureStore.setApiKey(payload.id, payload.apiKey);
      }
      const list = listProviders();
      const target = list.find((p) => p.id === payload.id)!;
      return { ...target, hasApiKey: await SecureStore.hasApiKey(payload.id) };
    },
  );

  safeHandle(IPC.PROVIDER_DELETE, async (id: string) => {
    deleteProviderRow(id);
    await SecureStore.deleteApiKey(id);
  });

  safeHandle(
    IPC.PROVIDER_TEST,
    async (payload: {
      config: Omit<ProviderConfig, 'hasApiKey'>;
      apiKey?: string;
    }): Promise<{ ok: boolean; latencyMs: number; message: string }> => {
      // 直接使用入参配置测试，不必先入库——允许在「保存前」也能测试连通性
      const provider: ProviderConfig = {
        id: payload.config.id,
        label: payload.config.label,
        baseUrl: payload.config.baseUrl,
        chatModel: payload.config.chatModel,
        embeddingModel: payload.config.embeddingModel,
        hasApiKey: false,
      };
      const key = payload.apiKey || (await SecureStore.getApiKey(payload.config.id));
      if (!key) throw new ApiError('E_NOT_AUTHED', '缺少 API Key');

      const t0 = Date.now();
      try {
        // 用 chat completions 试连（/chat/completions 比 /embeddings 通用），
        // 对所有 OpenAI 兼容服务都能跑通
        const c = axios.create({
          baseURL: provider.baseUrl.replace(/\/+$/, ''),
          timeout: 30_000,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        });
        await c.post('/chat/completions', {
          model: provider.chatModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        });
        return { ok: true, latencyMs: Date.now() - t0, message: '连接成功' };
      } catch (e) {
        return { ok: false, latencyMs: Date.now() - t0, message: (e as Error).message };
      }
    },
  );

  // ===== Setting =====
  safeHandle(IPC.SETTING_GET, async () => getSettings());
  safeHandle(IPC.SETTING_UPDATE, async (partial: any) => updateSettings(partial));
}
