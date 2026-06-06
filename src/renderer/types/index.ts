/**
 * 渲染进程类型：与 preload 暴露的 window.api 形状保持一致
 */
import type {
  KnowledgeBase,
  Document,
  Session,
  Message,
  ProviderConfig,
  Settings,
  AppInfo,
  DocProgressEvent,
  ChatTokenEvent,
  ChatAgentStepEvent,
  ChatAgentPhaseEvent,
  Citation,
  AgentTrace,
  AgentStep,
  ToolDef,
  ToolCall,
} from '../../shared/types';

export type {
  KnowledgeBase,
  Document,
  Session,
  Message,
  ProviderConfig,
  Settings,
  AppInfo,
  DocProgressEvent,
  ChatTokenEvent,
  ChatAgentStepEvent,
  ChatAgentPhaseEvent,
  Citation,
  AgentTrace,
  AgentStep,
  ToolDef,
  ToolCall,
};

export interface ElectronApi {
  kb: {
    list(): Promise<KnowledgeBase[]>;
    create(p: { name: string; description?: string }): Promise<KnowledgeBase>;
    rename(p: { id: string; name: string }): Promise<void>;
    delete(id: string): Promise<void>;
    get(id: string): Promise<KnowledgeBase>;
  };
  doc: {
    list(kbId: string): Promise<Document[]>;
    chunks(kbId: string, docId: string): Promise<{ chunkIndex: number; text: string }[]>;
    pick(): Promise<string[] | null>;
    upload(kbId: string, filePath: string): Promise<Document>;
    delete(docId: string): Promise<void>;
    reindex(docId: string): Promise<void>;
    ocrTest(): Promise<{
      ok: boolean;
      text: string;
      latencyMs: number;
      modelPath: string;
      error?: string;
    }>;
  };
  chat: {
    send(p: {
      kbId: string;
      kbIds?: string[]; // agent 模式可多选
      sessionId?: string;
      content: string;
      providerId: string;
      model: string;
      temperature?: number;
      topK?: number;
      mode?: 'simple' | 'agent';
    }): Promise<Session>;
    sessions(kbId?: string): Promise<Session[]>;
    messages(sessionId: string): Promise<Message[]>;
    deleteSession(sessionId: string): Promise<void>;
  };
  provider: {
    list(): Promise<ProviderConfig[]>;
    upsert(p: Omit<ProviderConfig, 'hasApiKey'> & { apiKey?: string }): Promise<ProviderConfig>;
    delete(id: string): Promise<void>;
    test(p: {
      config: Omit<ProviderConfig, 'hasApiKey'>;
      apiKey?: string;
    }): Promise<{ ok: boolean; latencyMs: number; message: string }>;
  };
  setting: {
    getAll(): Promise<Settings>;
    update(p: Partial<Settings>): Promise<Settings>;
  };
  app: {
    getInfo(): Promise<AppInfo>;
    openDataDir(): Promise<void>;
    clearCache(): Promise<{ removed: number }>;
  };
  event: {
    on(channel: string, listener: (data: any) => void): () => void;
  };
}

declare global {
  interface Window {
    api: ElectronApi;
  }
}

export {};
