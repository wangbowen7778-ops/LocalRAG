/**
 * 跨进程共享的 TypeScript 类型
 * 主进程和渲染进程都引用此文件
 */

export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  docCount: number;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Document {
  id: string;
  kbId: string;
  filename: string;
  size: number;
  mimeType: string;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  chunkCount: number;
  errorMessage?: string;
  createdAt: number;
}

export interface Citation {
  docId: string;
  filename: string;
  chunk: string;
  score: number;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations?: Citation[];
  createdAt: number;
}

export interface Session {
  id: string;
  kbId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface ProviderConfig {
  id: string;
  label: string;
  baseUrl: string;
  chatModel: string;
  /** 用于生成向量（/embeddings） */
  embeddingModel: string;
  /** 推理 / 思考模型（可选，用于回答阶段） */
  reasoningModel?: string;
  hasApiKey: boolean;
}

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  defaultProviderId?: string;
  defaultModel?: string;
  /** 用于文档 embedding 与检索向量化的 Provider；留空则用 defaultProviderId。
   *  当 Chat Provider 不支持 embedding（如 DeepSeek）时，可指定一个支持 embedding 的 Provider。 */
  embeddingProviderId?: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  temperature: number;
  language: 'zh-CN' | 'en-US';
  autoLaunch: boolean;
}

export interface AppInfo {
  name: string;
  version: string;
  userDataPath: string;
  indexDir: string;
  platform: string;
}

export interface DocProgressEvent {
  docId: string;
  stage: 'parsing' | 'embedding' | 'storing' | 'done';
  percent: number;
  message?: string;
}

export interface ChatTokenEvent {
  sessionId: string;
  delta: string;
  done: boolean;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  detail?: unknown;
}

export class ApiError extends Error {
  code: string;
  detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
