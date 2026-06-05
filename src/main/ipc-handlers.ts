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
  updateDocStatus,
  getDoc,
  deleteDoc,
  updateKBStats,
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
} from './storage';
import { SecureStore } from './secure-store';
import { processAndIndexDoc, deleteDocChunks, resolveEmbeddingProvider, runOcrSelfTest } from './document-processor';
import { vectorSearch, deleteCollection } from './vector-store';
import { chatStream, embedText } from './api-client';
import type { ProviderConfig, DocProgressEvent, ChatTokenEvent, Citation } from '../shared/types';

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

export function registerIpcHandlers(getMainWindow: WindowGetter) {
  // initStorage() 已在 main.ts 的 app.whenReady 中预先 await，此处不再调用

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
      title: '选择文档',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '支持格式', extensions: ['pdf', 'docx', 'md', 'markdown', 'txt'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  safeHandle(IPC.DOC_LIST, async (kbId: string) => listDocs(kbId));

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
    createDoc({
      id: docId,
      kbId,
      filename: path.basename(filePath),
      size: stat.size,
      mimeType: mime,
      status: 'processing',
    });

    // 异步处理：通过事件回传进度
    (async () => {
      const emitProgress = (stage: DocProgressEvent['stage'], percent: number, message?: string) => {
        emit<DocProgressEvent>(getMainWindow, IPC.EVT_DOC_PROGRESS, { docId, stage, percent, message });
      };
      try {
        const chunkCount = await processAndIndexDoc({
          docId,
          kbId,
          filePath,
          mimeType: mime,
          onProgress: emitProgress,
        });
        updateDocStatus(docId, 'ready', chunkCount);
        updateKBStats(kbId, 1, chunkCount);
        emitProgress('done', 100);
      } catch (e) {
        updateDocStatus(docId, 'failed', 0, (e as Error).message);
        emitProgress('done', 100, (e as Error).message);
      }
    })();

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
      sessionId?: string;
      content: string;
      providerId: string;
      model: string;
      temperature?: number;
      topK?: number;
    }) => {
      // 1. 校验 Provider & Key
      const providers = listProviders();
      const provider = providers.find((p) => p.id === payload.providerId);
      if (!provider) throw new ApiError('E_INVALID_ARG', '未找到 Provider');
      const apiKey = await SecureStore.getApiKey(payload.providerId);
      if (!apiKey) throw new ApiError('E_NOT_AUTHED', '请先配置 API Key');

      // 2. 创建/获取会话
      const session = payload.sessionId
        ? getSession(payload.sessionId) ?? createSession(payload.kbId, payload.content.slice(0, 30))
        : createSession(payload.kbId, payload.content.slice(0, 30));

      // 3. 写入用户消息
      const userMsgId = 'msg_' + Date.now().toString(36);
      addMessage({ id: userMsgId, sessionId: session.id, role: 'user', content: payload.content });
      touchSession(session.id);

      // 4. Embedding + 检索（embedding 用专门的 embeddingProvider，可能与 chat 不同）
      const settings = getSettings();
      const topK = payload.topK ?? settings.topK;
      // 引用分数阈值：低于此分的 chunk 既不进 LLM 上下文、也不展示给用户。
      // 解决「3 个相似文档都被引用」问题——只把真正相关的喂给 LLM。
      const scoreThreshold = settings.citationScoreThreshold ?? 0.4;
      let citations: Citation[] = [];
      let contextText = '';

      try {
        const embedProvider = await resolveEmbeddingProvider();
        const embedKey = await SecureStore.getApiKey(embedProvider.id);
        if (!embedKey) throw new Error('embedding Provider 缺少 API Key');
        const qvec = await embedText(embedProvider, embedKey, payload.content);
        const rawChunks = await vectorSearch(payload.kbId, qvec, topK);
        // 阈值过滤（threshold=0 时不过滤）
        const chunks =
          scoreThreshold > 0 ? rawChunks.filter((c) => c.score >= scoreThreshold) : rawChunks;
        citations = chunks.map((c) => ({
          docId: c.docId,
          filename: c.filename,
          chunk: c.text.slice(0, 200),
          score: c.score,
        }));
        if (chunks.length > 0) {
          contextText = chunks
            .map((c, i) => `[#${i + 1} ${c.filename}]\n${c.text}`)
            .join('\n\n');
        } else {
          // 全部被阈值过滤掉——明确告诉 LLM 没找到相关上下文，让它走通识回答，
          // 而不是把所有低分 chunk 塞进去污染回答。
          contextText = '（未检索到与本问题相关的文档内容）';
        }
      } catch (e) {
        console.warn('检索失败，继续无上下文回答', e);
      }

      // 推送引用
      emit(getMainWindow, IPC.EVT_CHAT_CITATION, { sessionId: session.id, citations });

      // 5. 组装 prompt 并流式生成
      const sysPrompt = `你是一个严谨的本地知识库助手。优先基于【参考资料】回答；如果资料不足，请明确说明并基于通识回答。回答末尾用 Markdown 列表形式列出引用的编号。`;
      const userPrompt = `【参考资料】\n${contextText || '（未检索到相关文档）'}\n\n【用户问题】\n${payload.content}`;

      const messages = [
        { role: 'system' as const, content: sysPrompt },
        // 简单注入最近 4 条历史
        ...listMessages(session.id)
          .slice(-8, -1) // 排除刚加入的 user
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
          (delta) => {
            fullText += delta;
            emit<ChatTokenEvent>(getMainWindow, IPC.EVT_CHAT_TOKEN, {
              sessionId: session.id,
              delta,
              done: false,
            });
          },
        );
      } catch (e) {
        emit<ChatTokenEvent>(getMainWindow, IPC.EVT_CHAT_TOKEN, {
          sessionId: session.id,
          delta: `\n\n[错误] ${(e as Error).message}`,
          done: true,
        });
        throw new ApiError('E_PROVIDER_ERR', (e as Error).message);
      }

      // 6. 写入 assistant 消息
      addMessage({
        id: assistantMsgId,
        sessionId: session.id,
        role: 'assistant',
        content: fullText,
        citations,
      });
      touchSession(session.id);

      emit<ChatTokenEvent>(getMainWindow, IPC.EVT_CHAT_TOKEN, {
        sessionId: session.id,
        delta: '',
        done: true,
      });
      emit(getMainWindow, IPC.EVT_CHAT_DONE, { sessionId: session.id, messageId: assistantMsgId });

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
