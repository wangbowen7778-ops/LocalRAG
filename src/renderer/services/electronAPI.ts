/**
 * 对 window.api 做轻量封装：
 * - 统一错误处理（toast）
 * - 提供常用语义化方法
 */
import type {
  KnowledgeBase,
  Document,
  Session,
  Message,
  ProviderConfig,
  Settings,
  AppInfo,
} from '../types';

export const api = {
  // KB
  listKBs: () => window.api.kb.list(),
  createKB: (name: string, description?: string) => window.api.kb.create({ name, description }),
  renameKB: (id: string, name: string) => window.api.kb.rename({ id, name }),
  deleteKB: (id: string) => window.api.kb.delete(id),
  getKB: (id: string) => window.api.kb.get(id),

  // Doc
  listDocs: (kbId: string) => window.api.doc.list(kbId),
  pickAndUpload: async (kbId: string): Promise<Document | null> => {
    const fp = await window.api.doc.pick();
    if (!fp) return null;
    return window.api.doc.upload(kbId, fp);
  },
  uploadDoc: (kbId: string, filePath: string) => window.api.doc.upload(kbId, filePath),
  deleteDoc: (id: string) => window.api.doc.delete(id),
  ocrTest: () => window.api.doc.ocrTest(),

  // Chat
  sendChat: window.api.chat.send,
  listSessions: (kbId?: string) => window.api.chat.sessions(kbId),
  listMessages: (sessionId: string) => window.api.chat.messages(sessionId),
  deleteSession: (sessionId: string) => window.api.chat.deleteSession(sessionId),

  // Provider
  listProviders: () => window.api.provider.list(),
  upsertProvider: window.api.provider.upsert,
  deleteProvider: (id: string) => window.api.provider.delete(id),
  testProvider: (
    config: Omit<ProviderConfig, 'hasApiKey'>,
    apiKey?: string,
  ) => window.api.provider.test({ config, apiKey }),

  // Settings
  getSettings: () => window.api.setting.getAll(),
  updateSettings: (s: Partial<Settings>) => window.api.setting.update(s),

  // App
  getAppInfo: () => window.api.app.getInfo(),
  openDataDir: () => window.api.app.openDataDir(),
  clearCache: () => window.api.app.clearCache(),

  // Events
  on: window.api.event.on,
};

// 简单的 toast 事件总线
type ToastLevel = 'info' | 'success' | 'warn' | 'error';
type ToastHandler = (level: ToastLevel, text: string) => void;
const toastHandlers: ToastHandler[] = [];
export function onToast(h: ToastHandler) {
  toastHandlers.push(h);
  return () => {
    const i = toastHandlers.indexOf(h);
    if (i >= 0) toastHandlers.splice(i, 1);
  };
}
export function toast(level: ToastLevel, text: string) {
  toastHandlers.forEach((h) => h(level, text));
}

/** 带错误提示的 IPC 包装 */
export async function safeCall<T>(fn: () => Promise<T>, errMsg = '操作失败'): Promise<T | null> {
  try {
    return await fn();
  } catch (e: any) {
    const msg = e?.message || errMsg;
    toast('error', `${errMsg}：${msg}`);
    return null;
  }
}

export type {
  KnowledgeBase,
  Document,
  Session,
  Message,
  ProviderConfig,
  Settings,
  AppInfo,
};
