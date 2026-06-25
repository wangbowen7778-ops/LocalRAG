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

// ===== Agentic RAG + read_chunk 工具 schema（v1.2.0 + v1.2.4）=====
import type { ToolDef } from './types';

/**
 * read_chunk 工具（v1.2.4 新增）。
 * - 简单模式：把 topK chunk 的"索引 + preview + score"发到 LLM context，LLM 按需调本工具拉完整内容
 * - Agent 模式：search_kb 检索后也用本工具取具体片段（替代 v1.2.0 把全文塞进 tool response）
 *
 * 节省 token 原理：topK=5 时，旧行为塞 5×800=4000 token；新行为只塞 5×50=250 token 索引，
 * LLM 实际只读 1-2 段完整内容（按需），平均 200-1000 token。
 */
export const READ_CHUNK_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'read_chunk',
    description:
      '按 chunk_id 读取片段完整内容。chunk_id 来自当前对话的【参考资料索引】或上一轮 search_kb 工具响应中的编号。' +
      '调用前先看预览决定要不要读——避免全部读取浪费 token。' +
      '对每个要引用的片段独立调用一次（可并行调多次）。' +
      '**v1.2.7 硬规则**：如果 preview 末尾有 [TRUNCATED: 共 N 字...] 标记 且 内容像列举/条款/编号型（(一)(二)(三) / 第N条/章/款 / 1.1.2 / A. B. C. / - 列表项）→ 引用前**必须**先 read_chunk(N) 拿完整内容——避免把截断的 preview 当成完整列表答错。',
    parameters: {
      type: 'object',
      properties: {
        chunk_id: {
          type: 'string',
          description: '片段编号（数字字符串，如 "1" "2" "3"），对应参考资料索引或 search_kb 响应中的 #N',
        },
      },
      required: ['chunk_id'],
    },
  },
};

/**
 * Agent 模式下注册给 LLM 的工具集（v1.2.0 + v1.2.4）。
 * - search_kb：在指定（或全部已授权）知识库中检索与子问题相关的文档片段（返回片段索引，不含全文）
 * - read_chunk：按 ID 取片段全文（v1.2.4 新增，替代 v1.2.0 把全文塞进 tool response）
 * - skip_search：声明本问题无需检索（闲聊/常识/数学/代码等）
 */
export const AGENT_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'search_kb',
      description:
        '在指定（或全部已授权）知识库里检索与子问题相关的文档片段。' +
        '工具响应返回 top N 候选片段的【索引 + preview + score】，需要看全文就调 read_chunk(chunk_id)。' +
        '如果根据当前上下文已能回答用户问题，不要再调用本工具。',
      parameters: {
        type: 'object',
        properties: {
          sub_query: {
            type: 'string',
            description:
              '针对当前子问题的精确检索词（去口语化、保留专有名词、错误码、API 名）。' +
              '**必须自包含**：检索系统（向量库 + BM25）看不到对话历史，只看本字符串做相似度匹配。' +
              '用户问题含指代/省略时（"它"/"那"/"第几章"/"为什么"/"详细说说"），' +
              '必须用对话历史里具体的实体名（条例名、文件名、产品名、章节号、专有名词）补全后再传。' +
              '反例："第几章？" / "为什么？" / "它的限流是多少" —— 这种孤立 query 召回必错。',
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
  READ_CHUNK_TOOL,
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
// v1.3.0 内部特性里程碑：检索 query 理解与重写管线（query-rewriter）——
// 用 LLM 把口语化/短/多意图 query 翻译为 1-3 条可检索 query，RRF 融合后喂给向量库。
// 替换 v1.2.5 / v1.2.6 的 query-resolver（仅做指代消解）。Settings 加 3 字段
//（enableQueryRewriter / queryRewriterProviderId / queryRewriterModel），默认开。
// v1.2.0/1/2/3/4/5/6/7/8/9 是 v2.0.0 的 10 个内部特性里程碑，本版本（v1.3.0）继续
// 在 v2.0.0 公开版本下发布——如未来要 bump 公开版本为 2.1.0 再说。
export const APP_VERSION = '1.3.6';

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
