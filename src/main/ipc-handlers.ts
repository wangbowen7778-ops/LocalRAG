/**
 * IPC 处理器注册中心
 * 所有 ipcMain.handle 在此集中管理
 */
import { ipcMain, BrowserWindow, dialog, app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { IPC, VECTRA } from '../shared/constants';
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
import { deleteDocChunks, resolveEmbeddingProvider, runOcrSelfTest } from './document-processor';
import { hybridSearch, deleteCollection, listChunksByDoc, bm25RebuildFromVectra } from './vector-store';
import { UploadQueue } from './upload-queue';
import { chatStream, embedText, rewriteQuery, summarizeConversation } from './api-client';
import { runAgent, selectKBs } from './agent';
import type { ProviderConfig, ChatTokenEvent, Citation } from '../shared/types';
import { resolveRewriterProvider } from './document-processor';

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
 * v1.2.2 查询改写：把"哪一章？" / "它" / "刚才那个"补成自包含 query。
 * 返回改写后的 query；改写关闭 / 失败时返回原 userContent。
 * 用 sessionId 缓存：同一 session 同一 (lastUserKey, currentQuery) 不重写。
 */
async function applyQueryRewrite(
  sessionId: string,
  userMsgId: string,
  chatApiKey: string,
  settings: ReturnType<typeof getSettings>,
  userContent: string,
): Promise<string> {
  if (settings.enableQueryRewrite === false) return userContent;
  try {
    const { provider: rwProvider, model: rwModel } = resolveRewriterProvider(settings);
    // 用户指定了独立 rewriterProviderId 才取独立 key；否则复用 chat provider 的 key
    const rwKey = settings.rewriterProviderId
      ? (await SecureStore.getApiKey(rwProvider.id)) ?? chatApiKey
      : chatApiKey;
    if (!rwKey) {
      console.warn('[chat] [rewrite] 改写 Provider 缺少 API Key，回退原 query');
      return userContent;
    }
    const historyMessages = listMessages(sessionId);
    const rewritten = await rewriteQuery(
      rwProvider,
      rwKey,
      rwModel,
      historyMessages,
      userMsgId,
      userContent,
      sessionId,
    );
    if (rewritten !== userContent) {
      console.log(`[chat] [rewrite] "${userContent}" → "${rewritten}"`);
    }
    return rewritten;
  } catch (e) {
    console.warn('[chat] [rewrite] 改写失败，用原 query:', (e as Error).message);
    return userContent;
  }
}

/**
 * v1.2.3 周期摘要：自上次摘要以来新增的 user turn ≥ summaryTriggerTurns → 触发。
 * fire-and-forget，不阻塞 chat 主流程；失败仅 console.warn。
 */
async function maybeSummarizeSession(
  sessionId: string,
  currentUserMsgId: string,
  chatApiKey: string,
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
  const compactStr = compact.join('\n');
  if (compactStr.length > 8000) {
    console.warn(`[chat] [summary] 待摘要内容 ${compactStr.length} 字超 8000，截断`);
  }

  // 4. 调 LLM 生成摘要
  const { provider: rwProvider, model: rwModel } = resolveRewriterProvider(settings);
  const rwKey = settings.rewriterProviderId
    ? (await SecureStore.getApiKey(rwProvider.id)) ?? chatApiKey
    : chatApiKey;
  if (!rwKey) return;

  const result = await summarizeConversation(
    rwProvider,
    rwKey,
    rwModel,
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
 * 简单模式 chat：单轮 embed → 单 KB 混合检索 → 流式生成。
 * 从原 CHAT_SEND 抽出，便于 agent 模式失败时降级调用。
 */
async function runSimpleChat(
  getMainWindow: WindowGetter,
  sessionId: string,
  _userMsgId: string,
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
  let citations: Citation[] = [];
  let contextText = '';

  // v1.2.2 查询改写：把"哪一章？" / "它" / "刚才那个"补成自包含 query
  const effectiveQuery = await applyQueryRewrite(
    sessionId,
    _userMsgId,
    apiKey,
    settings,
    payload.content,
  );

  try {
    const embedProvider = await resolveEmbeddingProvider();
    const embedKey = await SecureStore.getApiKey(embedProvider.id);
    if (!embedKey) throw new Error('embedding Provider 缺少 API Key');
    const qvec = await embedText(embedProvider, embedKey, effectiveQuery);
    const rawHits = await hybridSearch(kbId, effectiveQuery, qvec, topK, { enableBm25 });
    const chunks = scoreThreshold > 0 ? rawHits.filter((c) => c.score >= scoreThreshold) : rawHits;
    citations = chunks.map((c) => ({
      docId: c.docId,
      filename: c.filename,
      chunk: c.text.slice(0, 200),
      score: c.score,
    }));
    contextText =
      chunks.length > 0
        ? chunks.map((c, i) => `[#${i + 1} ${c.filename}]\n${c.text}`).join('\n\n')
        : '（未检索到与本问题相关的文档内容）';
  } catch (e) {
    console.warn('检索失败，继续无上下文回答', e);
  }

  // v1.2.3 历史对话摘要召回：跨 session 用 SQL LIKE 搜摘要表，按 query 关键词命中 top 2
  //   用户问"我们之前聊过 X 吗" / "上次讨论的 Y 是什么"时自动注入到 LLM 上下文
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

  emit(getMainWindow, IPC.EVT_CHAT_CITATION, { sessionId, citations });

  const sysPrompt = `你是一个严谨的本地知识库助手。优先基于【参考资料】回答；如果资料不足，请明确说明并基于通识回答。
【历史对话摘要】包含同一知识库下其它会话中聊过的相关话题，可以引用（例如"我们之前讨论过..."），但不是当前文档知识的一部分。回答末尾用 Markdown 列表形式列出引用的编号。`;
  const userPrompt =
    (summaryBlock ? summaryBlock + '\n\n' : '') +
    `【参考资料】\n${contextText}\n\n【用户问题】\n${payload.content}`;
  const messages = [
    { role: 'system' as const, content: sysPrompt },
    ...listMessages(sessionId)
      .slice(-8, -1)
      .map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: userPrompt },
  ];

  const assistantMsgId = 'msg_' + (Date.now() + 1).toString(36);
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

  addMessage({
    id: assistantMsgId,
    sessionId,
    role: 'assistant',
    content: fullText,
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
      // v1.2.2：与 runSimpleChat 一致，agent 路径的 userContent 也走查询改写
      //   （用 applyQueryRewrite 同一份 helper，sessionId 缓存会让 simple/agent 不会重复调 LLM）
      let effectiveUserContent = payload.content;
      if (mode === 'agent') {
        effectiveUserContent = await applyQueryRewrite(
          session.id,
          userMsgId,
          apiKey,
          settings,
          payload.content,
        );
      }
      let didKBSelection = false;
      let activeKbIds = candidateKbIds;
      if (mode === 'agent' && settings.enableKBSelector !== false && candidateKbIds.length > 1) {
        emit(getMainWindow, IPC.EVT_CHAT_AGENT_PHASE, {
          sessionId: session.id,
          phase: 'kb-select',
        });
        activeKbIds = await selectKBs(
          effectiveUserContent,
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
              effectiveUserContent,
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
