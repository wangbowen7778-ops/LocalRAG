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
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  citations?: Citation[];
  /** Agent 模式下持久化的思考过程步骤（仅 assistant 消息有） */
  agentTrace?: AgentTrace;
  /** tool role 消息专用 */
  toolCallId?: string;
  name?: string;
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

/**
 * 对话摘要（v1.2.3）：长 session 每 N 轮生成一次，存 SQLite 供后续轮注入 LLM 上下文。
 * 不嵌向量库——本地 SQLite 全文 LIKE 检索够用，避免再加一路融合。
 */
export interface SessionSummary {
  id: string;
  sessionId: string;
  /** 本段摘要覆盖的起始 msg id（包含）；用于增量判断"自上次摘要以来又有多少新消息" */
  startMsgId: string;
  /** 本段摘要覆盖的结束 msg id（包含） */
  endMsgId: string;
  /** 摘要正文（200-400 字中文） */
  summary: string;
  /** 关键主题（JSON 数组：["条例", "第一章", "总则"]） */
  keyTopics: string[];
  /** 关键实体（JSON 数组：[{type, value}]，type ∈ regulation/person/file/term） */
  keyEntities: Array<{ type: string; value: string }>;
  createdAt: number;
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

// ===== Agentic RAG 协议类型 =====

/** OpenAI 协议 tools 字段 */
export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** OpenAI 协议 tool_calls 字段（SSE 累积） */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** ChatCompletions 协议单条消息（兼容 tool role + tool_calls） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** Agent 单步 trace */
export type AgentStepKind = 'plan' | 'search' | 'skip' | 'critique';

export interface AgentStep {
  kind: AgentStepKind;
  /** LLM 同轮 content 里"思考"部分（tool_call 阶段通常为空） */
  thought?: string;
  /** 调用的工具名 */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  /** 该步影响的 KB id 列表 */
  kbIds?: string[];
  /** 检索词（去重后） */
  subQueries?: string[];
  /** 召回片段数 */
  hitCount?: number;
  /** 该步耗时 ms */
  latencyMs?: number;
}

export interface AgentTrace {
  steps: AgentStep[];
  /** 总耗时 ms */
  totalLatencyMs: number;
  /** 实际用到的 KB id 列表 */
  kbIds: string[];
  /** 实际循环次数 */
  iterations: number;
  /** 是否走了 LLM 自选 KB 步骤 */
  didKBSelection: boolean;
}

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  defaultProviderId?: string;
  defaultModel?: string;
  /** 用于文档 embedding 与检索向量化的 Provider；留空则用 defaultProviderId。
   *  当 Chat Provider 不支持 embedding（如 DeepSeek）时，可指定一个支持 embedding 的 Provider。 */
  embeddingProviderId?: string;
  /** 对扫描件 / 图片型 PDF 自动 fallback 到 OCR（tesseract.js）；默认关闭。 */
  enableOcr?: boolean;
  /** 启用 Agentic RAG（function_calling + 多轮迭代 + 跨 KB）。默认关闭，兼容旧行为。
   *  开启后 LLM 可以自主决定：是否检索、用什么子问题检索、检索几次、信息够不够。
   *  需要 Provider 支持 function_calling（OpenAI/DeepSeek/Qwen/SiliconFlow 均支持）。
   *  Agent 模式首问会比简单模式慢 2-5 秒。 */
  enableAgent?: boolean;
  /** Agent 循环最大次数（plan / search / critique 算一次 iteration）。默认 4 */
  agentMaxIterations?: number;
  /** 把 KB 列表（含 description）喂给 LLM 让它自己挑要搜哪些。默认 true */
  enableKBSelector?: boolean;
  /** 每次子问题检索召回的片段数（多 KB 融合后取 topK）。默认 5 */
  agentTopKPerQuery?: number;
  /** 混合检索：向量 + BM25（RRF 融合）。默认开启。
   *  - 向量擅长语义相似（"忘记密码" ≈ "如何重置密码"）
   *  - BM25 擅长精确术语（错误码、API 名、专有名词）
   *  关闭时退化为纯向量检索 */
  enableBm25?: boolean;
  /** v1.2.2 query rewrite 字段（v1.2.4 已删除，保留字段定义以兼容老 DB JSON） */
  enableQueryRewrite?: boolean;
  /** v1.2.2 query rewrite 字段（v1.2.4 已删除） */
  rewriterProviderId?: string;
  /** v1.2.2 query rewrite 字段（v1.2.4 已删除） */
  rewriterModel?: string;
  /** v1.2.4：是否启用 read_chunk 工具（simple 模式）。默认开启。
   *  - true：检索 topK chunk 后只把"索引 + preview"发到 LLM context，LLM 按需调 read_chunk(chunk_id) 拉完整内容。
   *         节省 ~60-80% chunk 相关 token。
   *  - false：退回老行为，把 topK 全文发到 LLM context（适合 Provider 不支持 function_calling 的情况）。
   *  仅对简单模式生效。Agent 模式永远使用 read_chunk（v1.2.4 统一）。 */
  enableReadChunkTool?: boolean;
  /** v1.3.0 查询理解管线（query-rewriter）：默认开启。
   *  - true：每条 user 消息在检索前先调 LLM 把 raw query 改写/扩展/分解为 1-3 条可检索 query，
   *         多 query 走 RRF 融合后喂给向量库（hybridSearchMultiQuery）。解决 v1.2.6 之前
   *         「口语化/短 query/多意图 query 召回差」的问题。
   *  - false：退化为 v1.2.6 行为（单 query → hybridSearch，跳过改写）。
   *  简单模式 + Agent 模式都受益。失败时（缺 key / LLM 抛错）自动 fallback 到原 query。 */
  enableQueryRewriter?: boolean;
  /** v1.3.0 自定义 rewriter 用 Provider；空则走 Chat Provider（v1.2.2 query rewrite 字段同档）
   *  改写 LLM 可独立配置便宜模型（如 Qwen-Turbo / gpt-4o-mini），主答继续用 GPT-4 / DeepSeek-Reasoner */
  queryRewriterProviderId?: string;
  /** v1.3.0 自定义 rewriter 用 Model；空则走 Chat Provider 的 chatModel */
  queryRewriterModel?: string;
  /** v1.3.2 检索后 LLM rerank：默认开启。
   *  - true：检索召回 20 个候选 → Chat Provider 小 LLM 按语义相关度重排 → 取 topK 喂主答 LLM。
   *         解决「正确答案被 BM25/RRF 排到 topK 外」（长整章 chunk 关键词堆砌压过答案子 chunk）。
   *  - false：退化为 RRF 原顺序。
   *  简单模式 + Agent 模式都受益。Agent 模式每次 search_kb 多 1 次 LLM 调用。失败时自动回退原顺序。 */
  enableRerank?: boolean;
  /** v1.2.3 长 session 周期摘要触发：自上次摘要以来新增的 user turn 数 ≥ 此值时生成一次摘要。默认 20。0 关闭。 */
  summaryTriggerTurns?: number;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  /** 相似度阈值。检索结果中分数 < 此值的 chunk 不进 LLM 上下文、也不展示为引用。
   *  设为 0 关闭过滤。
   *  纯向量模式：cosine similarity，0.4 含义与一般认知一致（OpenAI 通常 0.5+）
   *  混合模式（向量+BM25, RRF 融合）：score 已归一化到 [0,1]（1.0=top of both lists, 0.5=top of one list only）
   *    → 0.4 ≈ "在至少一路里进 top 1-2"。想更严格就调到 0.5，想更宽松调到 0.2 */
  citationScoreThreshold: number;
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
  stage: 'parsing' | 'ocr' | 'embedding' | 'storing' | 'done';
  percent: number;
  message?: string;
}

export interface ChatTokenEvent {
  sessionId: string;
  delta: string;
  done: boolean;
}

/** Agent 模式步骤事件（主进程 → 渲染进程） */
export interface ChatAgentStepEvent {
  sessionId: string;
  step: AgentStep;
  iteration: number;
}

/** Agent 模式阶段事件（主进程 → 渲染进程） */
export interface ChatAgentPhaseEvent {
  sessionId: string;
  phase: 'kb-select' | 'kb-select-done' | 'planning' | 'searching' | 'critiquing' | 'finalizing';
  iteration?: number;
  kbIds?: string[];
  subQuery?: string;
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
