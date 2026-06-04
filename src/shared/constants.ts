/**
 * 跨主进程与渲染进程共享的常量
 */

// IPC 通道名集中定义，避免硬编码散落
export const IPC = {
  // 知识库
  KB_LIST: 'kb:list',
  KB_CREATE: 'kb:create',
  KB_RENAME: 'kb:rename',
  KB_DELETE: 'kb:delete',
  KB_GET: 'kb:get',

  // 文档
  DOC_LIST: 'doc:list',
  DOC_UPLOAD: 'doc:upload',
  DOC_DELETE: 'doc:delete',
  DOC_REINDEX: 'doc:reindex',
  DOC_PICK: 'doc:pick', // 打开文件选择对话框

  // 对话
  CHAT_SEND: 'chat:send',
  CHAT_SESSIONS: 'chat:sessions',
  CHAT_MESSAGES: 'chat:messages',
  CHAT_DELETE_SESSION: 'chat:deleteSession',

  // Provider
  PROVIDER_LIST: 'provider:list',
  PROVIDER_UPSERT: 'provider:upsert',
  PROVIDER_DELETE: 'provider:delete',
  PROVIDER_TEST: 'provider:test',

  // 设置
  SETTING_GET: 'setting:get',
  SETTING_UPDATE: 'setting:update',

  // 应用
  APP_INFO: 'app:info',
  APP_OPEN_DATA_DIR: 'app:openDataDir',
  APP_CLEAR_CACHE: 'app:clearCache',

  // 事件（主进程 → 渲染进程）
  EVT_DOC_PROGRESS: 'doc:progress',
  EVT_CHAT_TOKEN: 'chat:token',
  EVT_CHAT_CITATION: 'chat:citation',
  EVT_CHAT_DONE: 'chat:done',
  EVT_TOAST: 'toast',
} as const;

// keytar 凭据统一前缀，便于卸载时清理
export const KEYTAR_SERVICE = 'LocalRAG';

// Vectra 本地向量库配置
// 每个知识库在 userData/index/<kbId> 下有一份 LocalIndex
export const VECTRA = {
  INDEX_DIR: 'index', // 相对 userData 的子目录
  BATCH_ADD: 50, // 单次 addItem 批量（避免锁文件）
};

// 文本分块默认值
export const CHUNK = {
  DEFAULT_SIZE: 500,
  DEFAULT_OVERLAP: 50,
  MIN_SIZE: 100,
  MAX_SIZE: 2000,
};

// 检索默认 top-k
export const DEFAULT_TOP_K = 5;

// 应用名称
export const APP_NAME = 'LocalRAG';
export const APP_VERSION = '1.1.5';

// Provider 预设
export const PROVIDER_PRESETS = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    chatModel: 'gpt-4o-mini',
    embeddingModel: 'text-embedding-3-small',
    reasoningModel: 'o1-mini',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    chatModel: 'deepseek-chat',
    // DeepSeek 无原生 embedding 接口，预留 text-embedding-3-small 作占位，
    // 用户如需上传文档请将 baseUrl 切到 OpenAI 或新增一个 OpenAI Provider
    embeddingModel: 'text-embedding-3-small',
    reasoningModel: 'deepseek-reasoner',
  },
  qwen: {
    id: 'qwen',
    label: '通义千问（阿里云 DashScope）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatModel: 'qwen-turbo',
    embeddingModel: 'text-embedding-v3',
    reasoningModel: 'qwq-plus',
  },
  siliconflow: {
    id: 'siliconflow',
    label: '硅基流动（SiliconFlow）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    // 硅基流动模型名格式为「作者/模型名」
    chatModel: 'Qwen/Qwen2.5-7B-Instruct',
    embeddingModel: 'BAAI/bge-m3',
    reasoningModel: 'Qwen/QwQ-32B-Preview',
  },
} as const;

export type ProviderId = keyof typeof PROVIDER_PRESETS;

// 支持的文档格式
export const SUPPORTED_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
};
