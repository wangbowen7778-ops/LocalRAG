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
  DOC_CHUNKS: 'doc:chunks', // 列出某文档的所有分块（用于 UI 验证向量化结果 / 排查「截断」问题）
  DOC_OCR_TEST: 'doc:ocrTest', // 测试 OCR 管线（独立于 PDF 传不传）

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
  /** Agent 模式：推送单个 step（流式 build trace） */
  EVT_CHAT_AGENT_STEP: 'chat:agent-step',
  /** Agent 模式：推送阶段切换（planning / searching / critiquing / finalizing 等） */
  EVT_CHAT_AGENT_PHASE: 'chat:agent-phase',
  EVT_TOAST: 'toast',
} as const;

// ===== Agentic RAG：工具 schema =====
import type { ToolDef } from './types';

/**
 * Agent 模式下注册给 LLM 的工具集。
 * - search_kb：在指定（或全部已授权）知识库中检索与子问题相关的文档片段
 * - skip_search：声明本问题无需检索（闲聊/常识/数学/代码等）
 */
export const AGENT_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'search_kb',
      description:
        '在指定（或全部已授权）知识库里检索与子问题相关的文档片段。' +
        '如果需要更精确的信息可再次调用本工具（改写 sub_query 后重搜）。' +
        '如果根据当前上下文已能回答用户问题，不要再调用本工具。',
      parameters: {
        type: 'object',
        properties: {
          sub_query: {
            type: 'string',
            description: '针对当前子问题的精确检索词（去口语化、保留专有名词、错误码、API 名）',
          },
          kb_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '限定要检索的 KB id 列表；为空或不传则检索全部已授权 KB',
          },
        },
        required: ['sub_query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skip_search',
      description:
        '表示本问题无需检索（闲聊/问候/常识/数学/代码等）。' +
        '调用后直接基于通识回答。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '为什么不需要检索（简短）' },
        },
        required: ['reason'],
      },
    },
  },
];

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
// v2.0.0 统一对外版本号。v1.2.0/1/2/3 是本次发布的 4 个内部特性里程碑
// （Agentic RAG / 智能切分 / 查询改写 / 长会话上下文），仍保留在代码注释与开发历史中
export const APP_VERSION = '2.0.0';

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
