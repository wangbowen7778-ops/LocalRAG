/**
 * 预加载脚本：通过 contextBridge 暴露 IPC 给渲染进程
 * 渲染进程只能访问 window.api 下声明的方法，无法直接访问 Node API
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC } from '../shared/constants';
import type {
  KnowledgeBase,
  Document,
  Session,
  Message,
  ProviderConfig,
  Settings,
  AppInfo,
} from '../shared/types';

// 定义渲染进程可见的 API 形状
const api = {
  kb: {
    list: (): Promise<KnowledgeBase[]> => ipcRenderer.invoke(IPC.KB_LIST),
    create: (payload: { name: string; description?: string }): Promise<KnowledgeBase> =>
      ipcRenderer.invoke(IPC.KB_CREATE, payload),
    rename: (payload: { id: string; name: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.KB_RENAME, payload),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.KB_DELETE, id),
    get: (id: string): Promise<KnowledgeBase> => ipcRenderer.invoke(IPC.KB_GET, id),
  },

  doc: {
    list: (kbId: string): Promise<Document[]> => ipcRenderer.invoke(IPC.DOC_LIST, kbId),
    pick: (): Promise<string | null> => ipcRenderer.invoke(IPC.DOC_PICK),
    upload: (kbId: string, filePath: string): Promise<Document> =>
      ipcRenderer.invoke(IPC.DOC_UPLOAD, { kbId, filePath }),
    delete: (docId: string): Promise<void> => ipcRenderer.invoke(IPC.DOC_DELETE, docId),
    reindex: (docId: string): Promise<void> => ipcRenderer.invoke(IPC.DOC_REINDEX, docId),
  },

  chat: {
    send: (payload: {
      kbId: string;
      sessionId?: string;
      content: string;
      providerId: string;
      model: string;
      temperature?: number;
      topK?: number;
    }): Promise<Session> => ipcRenderer.invoke(IPC.CHAT_SEND, payload),
    sessions: (kbId?: string): Promise<Session[]> => ipcRenderer.invoke(IPC.CHAT_SESSIONS, kbId),
    messages: (sessionId: string): Promise<Message[]> =>
      ipcRenderer.invoke(IPC.CHAT_MESSAGES, sessionId),
    deleteSession: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.CHAT_DELETE_SESSION, sessionId),
  },

  provider: {
    list: (): Promise<ProviderConfig[]> => ipcRenderer.invoke(IPC.PROVIDER_LIST),
    upsert: (payload: Omit<ProviderConfig, 'hasApiKey'> & { apiKey?: string }): Promise<ProviderConfig> =>
      ipcRenderer.invoke(IPC.PROVIDER_UPSERT, payload),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.PROVIDER_DELETE, id),
    test: (payload: {
      config: Omit<ProviderConfig, 'hasApiKey'>;
      apiKey?: string;
    }): Promise<{
      ok: boolean;
      latencyMs: number;
      message: string;
    }> => ipcRenderer.invoke(IPC.PROVIDER_TEST, payload),
  },

  setting: {
    getAll: (): Promise<Settings> => ipcRenderer.invoke(IPC.SETTING_GET),
    update: (partial: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke(IPC.SETTING_UPDATE, partial),
  },

  app: {
    getInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.APP_INFO),
    openDataDir: (): Promise<void> => ipcRenderer.invoke(IPC.APP_OPEN_DATA_DIR),
    clearCache: (): Promise<{ removed: number }> => ipcRenderer.invoke(IPC.APP_CLEAR_CACHE),
  },

  event: {
    /** 订阅事件，返回取消订阅函数 */
    on: (channel: string, listener: (data: unknown) => void) => {
      const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    },
  },
};

contextBridge.exposeInMainWorld('api', api);

// 类型提示：在 window.api 上声明的类型由 src/renderer/types/index.d.ts 提供
export type ElectronApi = typeof api;
