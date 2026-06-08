# LocalRAG API 文档

> 本文档定义**渲染进程 → 主进程**的 IPC 接口。所有接口通过 `window.api` 暴露（在 `preload.ts` 中通过 `contextBridge.exposeInMainWorld` 注册）。
>
> **当前版本：v2.0.0**——4 项核心特性合并发布（v1.2.0 / v1.2.1 / v1.2.2 / v1.2.3 是本次发布的 4 个**内部特性里程碑**）：
> - **Agentic RAG**（v1.2.0 内部里程碑；详见 [§11](#11-agentic-rag-协议类型)）
> - **智能切分**（v1.2.1 内部里程碑；按文件类型分发，token 单位；详见 `src/main/chunkers/`）
> - **查询改写**（v1.2.2 内部里程碑；`ANAPHORIC_RE` 跳过 + 进程内缓存；详见 [§12 查询改写](#12-查询改写v122)）
> - **长会话上下文**（v1.2.3 内部里程碑；`buildRewriteHistory` 历史压缩 + 周期摘要 + 历史摘要召回；详见 [§13 长会话上下文](#13-长会话上下文v123)）

## 1. 接口总览

| 命名空间 | 方法 | 说明 |
| --- | --- | --- |
| `kb` | 知识库管理 | 创建/查询/删除知识库 |
| `doc` | 文档管理 | 上传/列表/删除/重新向量化 |
| `chat` | 对话 | 发送消息（流式）、历史记录 |
| `provider` | AI Provider | API Key 增删改查、列表 |
| `setting` | 设置 | 通用设置读写 |
| `app` | 应用 | 打开数据目录、版本号、清理 |
| `event` | 事件订阅 | 主进程主动推送（流式 token、进度） |

调用规范：
- 渲染进程：`await window.api.kb.list()`
- 主进程：`ipcMain.handle('kb:list', async () => ...)`

## 2. 错误码

| 错误码 | 含义 |
| --- | --- |
| `E_NOT_FOUND` | 资源不存在 |
| `E_INVALID_ARG` | 参数错误 |
| `E_NOT_AUTHED` | 缺少 API Key |
| `E_PROVIDER_ERR` | AI Provider 返回错误 |
| `E_IO` | 文件读写失败 |
| `E_INTERNAL` | 未捕获异常 |

错误对象结构：
```ts
interface ApiError {
  code: string;
  message: string;
  detail?: unknown;
}
```

## 3. 知识库 API（`kb`）

### `kb.list()`
- **参数**：无
- **返回**：`KnowledgeBase[]`
```ts
interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  docCount: number;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
}
```

### `kb.create(payload)`
- **参数**：`{ name: string; description?: string }`
- **返回**：`KnowledgeBase`

### `kb.rename(payload)`
- **参数**：`{ id: string; name: string }`
- **返回**：`void`

### `kb.delete(id)`
- **参数**：`id: string`
- **返回**：`void`

### `kb.get(id)`
- **参数**：`id: string`
- **返回**：`KnowledgeBase` 或抛 `E_NOT_FOUND`

## 4. 文档 API（`doc`）

### `doc.list(kbId)`
- **参数**：`kbId: string`
- **返回**：`Document[]`
```ts
interface Document {
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
```

### `doc.upload(kbId, filePath)`
- **参数**：
  - `kbId: string`
  - `filePath: string`
- **返回**：`Document`
- **进度事件**：`event.on('doc:progress', (e) => ...)`
```ts
interface DocProgressEvent {
  docId: string;
  stage: 'parsing' | 'ocr' | 'embedding' | 'storing' | 'done';
  percent: number; // 0-100
  message?: string;
}
```
> v1.1.6 起新增 `ocr` 阶段：扫描件 PDF 在「设置 → 常规」开启「对扫描件 PDF 启用 OCR」时会上报 OCR 进度。

### `doc.delete(docId)`
- **参数**：`docId: string`
- **返回**：`void`

### `doc.reindex(docId)`
- **参数**：`docId: string`
- **返回**：`void`

### `doc.ocrTest()`（v1.1.6+）
- **参数**：无
- **返回**：
```ts
interface OcrTestResult {
  ok: boolean;
  text: string;      // 识别到的文本（最长显示 60 字）
  latencyMs: number; // 总耗时（含首次模型下载）
  modelPath: string; // tesseract 模型缓存目录
  error?: string;
}
```
- **说明**：独立验证 OCR 管线是否可用。在设置页「测试 OCR」按钮处使用，不依赖任何真实 PDF——直接用 `@napi-rs/canvas` 画一张已知文字的测试图丢给 tesseract worker。

## 5. 对话 API（`chat`）

### `chat.send(payload)`
- **参数**：
```ts
interface ChatSendPayload {
  kbId: string;                 // 兼容字段：单 KB 入口（Agent 模式下若 kbIds 未传则用此）
  kbIds?: string[];             // v1.2.0+ Agent 模式可多选 KB（与 kbIds.length>1 + enableKBSelector 时自动走 LLM 自选）
  sessionId?: string;           // 不传则创建新会话
  content: string;
  providerId: string;           // 关联到 provider.id
  model: string;
  temperature?: number;
  topK?: number;                // 简单模式检索 top-k，默认 5
  mode?: 'simple' | 'agent';    // v1.2.0+ 默认由 settings.enableAgent 决定
}
```
- **返回**：`Session`
- **流式事件**：`event.on('chat:token', ...)` 与 `event.on('chat:done', ...)`
```ts
interface ChatTokenEvent {
  sessionId: string;
  delta: string;
  done: boolean;
}
```
> **v1.1.6 起**：检索结果会按 `Settings.citationScoreThreshold`（默认 0.4）过滤；低于阈值的 chunk 不会推送到 `chat:citation` 事件，也不会出现在 LLM 上下文中。全部被过滤时，LLM 会收到「未检索到相关文档」并基于通识回答。
>
> **v1.1.7 起**：默认走「向量 + BM25 混合检索 + RRF 融合」。`Settings.enableBm25 = false` 退化为纯向量检索。
>
> **v1.2.0 起**：`mode='agent'` 时 LLM 通过 `function_calling` 自主决定搜不搜、搜什么、搜几次。订阅 `chat:agent-step` / `chat:agent-phase` 拿 trace 与阶段事件；Provider 不支持 tools（400/422）时自动降级到 `mode='simple'` 重试一次。
>
> **v1.2.1 起**：文档切片单位从 `char` 改为 `token`（cl100k_base 编码）。`Settings.chunkSize` / `chunkOverlap` 默认 800 / 100。切分策略按文件类型自动分发：Markdown 走 `marked.lexer` 结构感知、文本层 PDF 走 pdfjs items 版面感知（自动跳页眉页脚）、DOCX/TXT/OCR-PDF 走 LangChain 风格递归分隔符。详见 `src/main/chunkers/` 模块。
>
> **v1.2.2 起**：用户消息会先经过**查询改写**——指代词（"它/他/她/这/那"）+ 短语（"刚才/那个"）+ 长度 < 6 的短问句，会调用改写 LLM 把"它/哪一章？"补成"《北京国际科技创新中心建设条例》哪一章？"，再去 embedding + 检索。`Settings.enableQueryRewrite` 默认 `true`，可在「设置 → 常规」关闭。
>
> **v1.2.3 起**：改写 LLM 看到的历史不再是「近 8 条消息」，而是经过 `buildRewriteHistory` 智能压缩后的「首条 user 锚定 + 最近 10 条 + assistant 截断 + token 预算 2500」序列。跨 session 的"我们之前聊过 X 吗"问题，会先 `searchSessionSummaries` 命中 top 2 历史摘要，注入到 system prompt。详见 [§13](#13-长会话上下文v123)。

### `chat.sessions(kbId?)`
- **参数**：`kbId?: string`
- **返回**：`Session[]`
```ts
interface Session {
  id: string;
  kbId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}
```

### `chat.messages(sessionId)`
- **参数**：`sessionId: string`
- **返回**：`Message[]`
```ts
interface Message {
  id: string;
  sessionId: string;
  /** v1.2.0 起新增 'tool'——agent 模式 tool role 的消息也存进 DB（用于回放 trace） */
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  citations?: { docId: string; filename: string; chunk: string; score: number }[];
  /** v1.2.0+ Agent 模式持久化：assistant 消息附带的思考过程步骤 */
  agentTrace?: AgentTrace;
  /** v1.2.0+ tool role 消息专用：OpenAI 协议 tool_call_id */
  toolCallId?: string;
  /** v1.2.0+ tool role 消息专用：tool 名称 */
  name?: string;
  createdAt: number;
}
```

### `chat.deleteSession(sessionId)`
- **参数**：`sessionId: string`
- **返回**：`void`

## 6. Provider API（`provider`）

### `provider.list()`
- **返回**：`ProviderConfig[]`
```ts
interface ProviderConfig {
  id: string;            // 内部 ID（如 openai / deepseek / qwen）
  label: string;         // 显示名
  baseUrl: string;
  chatModel: string;
  /** 用于生成向量（/embeddings） */
  embeddingModel: string;
  /** 推理 / 思考模型（可选，用于回答阶段；v1.1.5+ 独立于 embeddingModel） */
  reasoningModel?: string;
  hasApiKey: boolean;
}
```

### `provider.upsert(payload)`
- **参数**：`Omit<ProviderConfig, 'hasApiKey'> & { apiKey?: string }`
- **返回**：`ProviderConfig`（不返回明文 Key）
- **说明**：当 `apiKey` 不为空时通过 keytar 写入。

### `provider.delete(id)`
- **参数**：`id: string`
- **返回**：`void`

### `provider.test(payload)`（v1.1.3+ 改用入参配置直接探活）
- **参数**：
```ts
{
  config: Omit<ProviderConfig, 'hasApiKey'>;
  apiKey?: string;
}
```
- **返回**：`{ ok: boolean; latencyMs: number; message: string }`
- **说明**：使用入参的 config 调 `/chat/completions`（max_tokens=1）做探活，**不再要求 Provider 先入库**——允许在「保存前」测试连通性。

## 7. 设置 API（`setting`）

### `setting.getAll()`
- **返回**：`Settings`
```ts
interface Settings {
  theme: 'light' | 'dark' | 'system';
  defaultProviderId?: string;
  defaultModel?: string;
  /** 用于文档 embedding 与检索向量化的 Provider；留空则用 defaultProviderId。
   *  当 Chat Provider 不支持 embedding（如 DeepSeek 没有 /embeddings 端点）时，
   *  可指定一个支持 embedding 的 Provider。v1.1.5+ */
  embeddingProviderId?: string;
  /** 对扫描件 / 图片型 PDF 自动 fallback 到 OCR（tesseract.js）；默认关闭。v1.1.6+ */
  enableOcr?: boolean;
  /** v1.1.7+ 混合检索：向量 + BM25（RRF 融合）。默认开启。
   *  - 向量擅长语义相似（"忘记密码" ≈ "如何重置密码"）
   *  - BM25 擅长精确术语（错误码、API 名、专有名词）
   *  关闭时退化为纯向量检索 */
  enableBm25?: boolean;
  /** v1.2.0+ 启用 Agentic RAG（function_calling + 多轮迭代 + 跨 KB）。默认关闭，兼容旧行为。
   *  开启后 LLM 可以自主决定：是否检索、用什么子问题检索、检索几次、信息够不够。
   *  需要 Provider 支持 function_calling（OpenAI/DeepSeek/Qwen/SiliconFlow 均支持）。
   *  Agent 模式首问会比简单模式慢 2-5 秒 */
  enableAgent?: boolean;
  /** v1.2.0+ Agent 循环最大次数（plan / search / critique 算一次 iteration）。默认 4 */
  agentMaxIterations?: number;
  /** v1.2.0+ 把 KB 列表（含 description）喂给 LLM 让它自己挑要搜哪些。默认 true */
  enableKBSelector?: boolean;
  /** v1.2.0+ 每次子问题检索召回的片段数（多 KB 融合后取 topK）。默认 5 */
  agentTopKPerQuery?: number;
  /** v1.2.1 起 chunkSize / chunkOverlap 单位从字符改为 token（cl100k_base 编码，与 OpenAI text-embedding-3 同源）
   *  默认 chunkSize=800、chunkOverlap=100；800 token ≈ 600 中文字 / 2400 英文字
   *  老用户设置原样保留但按新单位解读 */
  chunkSize: number;
  chunkOverlap: number;
  /** v1.2.2+ 多轮对话查询改写。检测到指代词（它/他/她/这/那/刚才/那个）或 query 长度 < 6 时，
   *  调一个小 LLM 把"它/哪一章？"补成"《北京国际科技创新中心建设条例》哪一章？"，再 embedding + 检索。
   *  默认 true；关闭时直接用原 query 检索（指代问句大概率命中错） */
  enableQueryRewrite?: boolean;
  /** v1.2.2+ 改写专用的 Provider。空 = 用 defaultProviderId（即 Chat 共用）；
   *  推荐用一个便宜 / 快的模型（gpt-4o-mini / deepseek-chat 即可） */
  rewriterProviderId?: string;
  /** v1.2.2+ 改写专用的模型。空 = 走该 Provider 的 chatModel */
  rewriterModel?: string;
  /** v1.2.3+ 周期摘要触发阈值：自上次摘要以来新增的 user turn 数 ≥ 此值时，
   *  fire-and-forget 调 LLM 生成一条 summary 写入 session_summaries 表。
   *  默认 20；设 0 关闭（仍保留 v1.2.2 的查询改写） */
  summaryTriggerTurns?: number;
  topK: number;
  /** 余弦相似度阈值（0-1，默认 0.4）。检索结果中 score < 此值的 chunk 不进 LLM 上下文、也不展示为引用。
   *  设为 0 关闭过滤；OpenAI text-embedding-3 相关片段通常 0.5+。v1.1.6+ */
  citationScoreThreshold: number;
  temperature: number;
  language: 'zh-CN' | 'en-US';
  autoLaunch: boolean;
}
```

### `setting.update(partial)`
- **参数**：`Partial<Settings>`
- **返回**：`Settings`

## 8. 应用 API（`app`）

### `app.getInfo()`
- **返回**：`{ name: string; version: string; userDataPath: string; indexDir: string; platform: string }`
  - `indexDir`：vectra 向量索引根目录（`%APPDATA%\LocalRAG\index`）

### `app.openDataDir()`
- **返回**：`void`（调起资源管理器）

### `app.clearCache()`
- **返回**：`{ removed: number }`

## 9. 事件订阅（`event`）

通过 `window.api.event.on(channel, listener)` 订阅；返回取消订阅函数。

| 通道 | 数据 | 说明 |
| --- | --- | --- |
| `doc:progress` | `DocProgressEvent` | 文档处理进度（含 `parsing` / `ocr` / `embedding` / `storing` / `done`） |
| `chat:token` | `ChatTokenEvent` | 流式输出 token |
| `chat:citation` | `Citation` 一次性发出 | 检索到的引用列表 |
| `chat:done` | `{ sessionId, messageId }` | 当前回答完成 |
| `chat:agent-step`（v1.2.0+） | `ChatAgentStepEvent` | Agent 模式每步 trace（累积构建 trace 视图） |
| `chat:agent-phase`（v1.2.0+） | `ChatAgentPhaseEvent` | Agent 模式阶段切换（`kb-select` / `planning` / `searching` / `critiquing` / `finalizing`） |
| `toast` | `{ level: 'info' \| 'success' \| 'warn' \| 'error'; text: string }` | UI 提示 |

## 10. 示例代码

```ts
// 渲染进程
async function ask(question: string) {
  const session = await window.api.chat.send({
    kbId: currentKbId,
    content: question,
    providerId: 'openai',
    model: 'gpt-4o-mini',
  });

  const offToken = window.api.event.on('chat:token', (e) => {
    if (e.sessionId !== session.id) return;
    appendDelta(e.delta);
    if (e.done) offToken();
  });
}
```

```ts
// 主进程
ipcMain.handle('chat:send', async (_e, payload: ChatSendPayload) => {
  // 1. 校验 API Key
  const provider = await getProvider(payload.providerId);
  if (!provider.hasApiKey) throw apiError('E_NOT_AUTHED', '请先配置 API Key');

  // 2. Embedding
  const queryVec = await apiClient.embed(provider, payload.content);

  // 3. 检索
  const chunks = await vectorStore.search(payload.kbId, queryVec, payload.topK ?? 5);

  // 4. 组装 prompt 并流式生成
  const session = await chatService.createSession(payload);
  apiClient.streamChat(provider, buildPrompt(chunks, payload), (delta) => {
    sender.send('chat:token', { sessionId: session.id, delta, done: false });
  });

  return session;
});
```

---

## 11. Agentic RAG 协议类型（v1.2.0+）

Agent 模式通过 OpenAI 协议 `function_calling`（`tools` / `tool_calls`）让 LLM 自主决定「搜不搜、搜什么、搜几次、信息够不够」。本节列出所有相关类型。

### 11.1 工具 schema（`AGENT_TOOLS`）

主进程在 `src/shared/constants.ts` 导出，注入到 `chatCompletion` 请求的 `tools` 字段：

| 工具名 | 参数 | 行为 |
| --- | --- | --- |
| `search_kb` | `sub_query: string`（必填），`kb_ids?: string[]`（限定 KB；空 = 全部已授权） | 在指定 KB 中检索相关片段，返回 `[#n filename \| score] + text` |
| `skip_search` | `reason: string` | 声明本问题无需检索（闲聊/数学/代码等），LLM 直接基于通识回答 |

### 11.2 协议类型

```ts
/** OpenAI 协议 tools 字段 */
interface ToolDef {
  type: 'function';
  function: {
    name: string;        // 'search_kb' | 'skip_search'
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** OpenAI 协议 tool_calls 字段（一次响应可包含多个，SSE 累积得到） */
interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };  // arguments 是 JSON 字符串
}

/** ChatCompletions 协议单条消息 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** assistant 消息带 tool_calls（准备执行） */
  tool_calls?: ToolCall[];
  /** tool 消息必填：对应 assistant 消息里的 tool_call.id */
  tool_call_id?: string;
  /** tool 消息必填：tool 名称（'search_kb' | 'skip_search'） */
  name?: string;
}
```

### 11.3 Trace 与阶段事件

```ts
/** Agent 单步 trace——每次 tool_call 执行 / 跳过 / 评判都产生一步 */
type AgentStepKind = 'plan' | 'search' | 'skip' | 'critique';

interface AgentStep {
  kind: AgentStepKind;
  /** LLM 同轮 content 里的「思考」部分（tool_call 阶段通常为空） */
  thought?: string;
  /** 调用的工具名 */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  /** 该步影响的 KB id 列表 */
  kbIds?: string[];
  /** 检索词（去重后） */
  subQueries?: string[];
  /** 召回片段数（过阈值后） */
  hitCount?: number;
  /** 该步耗时 ms */
  latencyMs?: number;
}

/** 整个 Agent 运行的 trace——持久化在 assistant 消息的 Message.agentTrace */
interface AgentTrace {
  steps: AgentStep[];
  /** 总耗时 ms */
  totalLatencyMs: number;
  /** 实际用到的 KB id 列表 */
  kbIds: string[];
  /** 实际循环次数 */
  iterations: number;
  /** 是否走了 LLM 自选 KB 步骤（kbIds.length>1 + enableKBSelector） */
  didKBSelection: boolean;
}
```

### 11.4 实时事件订阅

Agent 模式在主循环里持续 emit 两个事件，渲染端实时构建折叠 trace 视图：

```ts
interface ChatAgentStepEvent {
  sessionId: string;
  step: AgentStep;   // 累积 push 到本地 trace.steps
  iteration: number; // 当前是第几轮（1-based）
}

interface ChatAgentPhaseEvent {
  sessionId: string;
  phase: 'kb-select' | 'kb-select-done' | 'planning' | 'searching' | 'critiquing' | 'finalizing';
  iteration?: number;
  /** kb-select-done 时附带：LLM 选出的 KB 列表 */
  kbIds?: string[];
  /** searching 时附带：本次子问题 */
  subQuery?: string;
}
```

### 11.5 Agent 主循环流程

1. 构造 `messages = [system, ...近 8 条历史, 当前 user]`
2. 循环 `i = 0..maxIterations`：
   - emit `chat:agent-phase`（首次 `planning`，之后 `critiquing`）
   - `chatCompletion(messages, tools=AGENT_TOOLS)`（非流式）
   - 解析响应：
     - **有 `tool_calls`**：
       - push `assistant` 消息（带 `tool_calls`）回 `messages`
       - 对每个 `tool_call`：
         - `search_kb` → `embedText` + `hybridSearchMulti`（去重 `subQueryCache`），构造 `tool` 消息回 `messages`，emit `chat:agent-step`
         - `skip_search` → push `tool` 消息 `content='NO_RESULTS'`，emit `chat:agent-step`
     - **`finish_reason='stop'` + content 非空** → `finalText = content`，跳出循环
3. **兜底**（循环用完 `maxIterations` 还没拿到 final）→ 不带 tools 再调一次 `chatCompletion`，把累积 citations 拼成 context
4. **流式输出**：`chatStream`（不带 tools）流式 emit `chat:token`；末尾追加「引用来源」markdown 列表
5. **持久化**：assistant 消息 + `agentTrace` 入库；emit `chat:done`

### 11.6 降级

- Provider 返回 400/422（不支持 `tools` / `function_calling`）→ `ipc-handlers.ts` catch → 自动降级到 `runSimpleChat`（单轮 embed + 单 KB 检索 + 流式生成），主进程 log warning
- BM25 重建失败 → 静默回退到纯向量检索

### 11.7 已知约束

- 典型一次 chat 5-8 步 × ~200 字节 ≈ 1-2KB/消息（DB TEXT 够用）
- 不存完整 OpenAI `messages` 数组——只存 trace，避免 DB 膨胀 + 跨 Provider schema 兼容
- agent 模式首问慢 2-5 秒（多轮 LLM 调用 + 多次 embed）
- sub_query 短路：`Set<subQuery+'|'+kbIds.join(',')>` 命中直接返回「此子问题已检索过」

---

## 12. 查询改写（v1.2.2+）

多轮对话里用户常发"它是什么？"、"哪一章？"、"那关于 X 的呢？"——这些**指代 / 省略**句直接 embed 得到的向量与上一轮的实体向量偏离很大，导致第二、三轮检索命中率从 90% 跌到 30-50%。v1.2.2 引入**查询改写**机制：把"它 + 上一轮的实体"补成"自包含的 query"再 embedding。

### 12.1 跳过 vs 改写判定

主进程 `ipc-handlers.ts::applyQueryRewrite` 调 `rewriteQuery()`（`src/main/api-client.ts`）。函数先做**本地启发式**判定，不需要 LLM：

```ts
// 跳过改写（直接返回原 query）：
//   1) 长度 ≥ 6
//   2) 且 不含 [它他她这那] 中任一字
//   3) 且 不含「刚才/那个」短语
// → 100% 进程内判断，0 网络
//
// 走 LLM 改写（反之）：
//   - 短问句（"哪一章？" 长度 5）
//   - 含独立指示代词（"它"、"那条款"）
//   - 含「刚才那个」类远指短语
const ANAPHORIC_RE = /[它他她这那]|刚才|那个/;
```

**故意不列的字**：`上`、`的`、`个`、`们`、`此`、`该`、`其`——它们在自包含句里出现频率太高，假阳性爆炸（例如"qwen-turbo 模型的上下文窗口多大？"会被"上"误判成指代句）。

### 12.2 改写 prompt 与输出

走 LLM 改写时，prompt 模板（`REWRITE_PROMPT`）只要求 LLM 输出**改写后的 query 一行**，不附带任何解释。前缀上下文摘要：

```
【最近对话】...
【上一轮用户问题】《北京国际科技创新中心建设条例》第一条的核心内容是什么？
【上一轮助手回答】...
【当前用户问题】哪一章？
→ 把"哪一章？"补成自包含的检索 query
```

LLM 输出：`《北京国际科技创新中心建设条例》共分几章？` → 再去 embedding。

### 12.3 进程内缓存

主进程 `rewriteCache: Map<sessionId, Map<key, string>>`，key = `(lastUserContent + '|' + currentQuery)`。同一 session 同一 query 第二次直接命中缓存，不调 LLM。修改「改写 Provider/模型」设置时调 `clearRewriteCache()` 主动清空。

### 12.4 失败回退

改写 LLM 调失败（Provider 4xx/5xx/网络超时）→ `console.warn` + 返回原 `userContent`，继续走 embedding。不阻塞主流程。

### 12.5 改写与 Agent 模式

`agent.ts` 的 `AgentInput` 字段 `effectiveUserContent?: string` 接 `applyQueryRewrite` 的输出。`messages` 构造时用 `effectiveUserContent ?? userContent`——LLM 看到的是自包含 query，检索也用它。`userContent` 仍保留作 fallback（兜底 chat 用）。

> Simple 模式与 Agent 模式共享同一份 `applyQueryRewrite` 缓存——同一 session 同一 query 在两个模式间切换不会重复调 LLM。

---

## 13. 长会话上下文（v1.2.3+）

v1.2.2 解决了"用户短问句 + 改写"；v1.2.3 解决**长会话**下的两个新问题：
1. **改写 LLM 自己看不完 100 条历史**——10 轮后 history 已经超出 context window
2. **跨 session 的"我们之前聊过 X 吗"**——上一会话 / 上周聊的内容，纯靠改写拿不到

### 13.1 改写历史压缩：`buildRewriteHistory`

`src/main/api-client.ts` 导出：

```ts
const REWRITE_HISTORY = {
  MAX_MESSAGES: 10,                 // 短期记忆：最近 N 条
  ASSISTANT_TRUNCATE_THRESHOLD: 500, // assistant 超此长度才截
  ASSISTANT_TRUNCATE_LENGTH: 300,    // 截到多少字（保留前 300 + …）
  MAX_CHARS: 2500,                   // 送 LLM 的总字符数预算（≈ 2500 token）
} as const;

export function buildRewriteHistory(
  messages: Message[],       // 当前 session 全部消息（含 system/tool/assistant）
  currentMsgId: string,      // 刚写入的"当前 user msg id"——会被排除
): ChatMessage[]             // 给 LLM 看的历史
```

**压缩策略**（4 步）：
1. **过滤**——剔除 `tool` 角色（agent tool 消息不进改写上下文）、剔除 `currentMsgId`（避免 LLM 看见自己）
2. **首条 user 锚定**——`messages[0]`（session 第一条 user 消息）必带，作用是给 LLM 一个"话题基线"
3. **短期记忆**——从尾部取最近 10 条消息
4. **合并去重**——firstUser + recent 拼接，再去重；倒序遍历，**总字符数 ≤ 2500** 时按时间序输出；assistant 消息 > 500 字截到 300 字 + `…`

> **保留 firstUser 的理由**：用户首次发问往往包含完整主题（"我们对比一下 PG 和 Mongo 事务"），后续 assistant 给的是 "PG 事务机制..." 这样的细节。LLM 只看 recent 看不出"我们在对比"，看到 firstUser 就懂了。

### 13.2 周期摘要

主进程在每条 user 消息入库后**异步**（`void maybeSummarizeSession(...)`，不阻塞 chat 主流程）检查是否触发摘要：

```ts
// storage.ts
async function maybeSummarizeSession(
  sessionId: string,
  currentUserMsgId: string,
  chatApiKey: string,
  settings: Settings,
): Promise<void>
```

**触发条件**（**AND 关系**）：
1. `settings.summaryTriggerTurns > 0`（默认 20；设 0 关闭）
2. 自上次摘要以来新增的 **user turn** 数 ≥ `summaryTriggerTurns`
   - user turn = 一对 `user` + `assistant`；只看 user 数（agent 模式会插入 tool 消息，但 user 数仍为 1）
3. 该 session 至少有 2 条 user 消息
4. `settings.enableQueryRewrite !== false`（摘要本质上是"为改写做长程记忆"——关闭改写就不需要摘要）

**摘要内容**（`summarizeConversation` 调改写 LLM，prompt 模板 `SUMMARIZE_PROMPT`）：
- 一段 200-400 字的概要（用户主要问题、助手核心结论、关键引用文档名）
- `keyTopics`: 3-5 个关键词（如 "PG 事务隔离级别"、"Mongo 索引"）
- `keyEntities`: 提到的实体（产品名、错误码、API 名、人名）

落库到 `session_summaries` 表（见下）。

**失败处理**：调 LLM 失败 → `console.warn` + 跳过，下次 user 消息再试；不弹错误、不阻塞 chat。

### 13.3 `session_summaries` 表

`storage.ts` 在 `initStorage()` 幂等创建：

```sql
CREATE TABLE session_summaries (
  id TEXT PRIMARY KEY,           -- 形如 'sum_xxx'
  session_id TEXT NOT NULL,      -- 关联 sessions.id
  start_msg_id TEXT NOT NULL,    -- 摘要覆盖的起始 user msg
  end_msg_id TEXT NOT NULL,      -- 摘要覆盖的结束 user msg
  summary TEXT NOT NULL,         -- LLM 生成的概要
  key_topics TEXT NOT NULL,      -- JSON 数组字符串
  key_entities TEXT NOT NULL,    -- JSON 数组字符串
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_session_summaries_session
  ON session_summaries(session_id, created_at DESC);
```

`Message` 类型（`src/shared/types.ts`）新增 `SessionSummary` 接口（不入 messages 表，独立存）：

```ts
interface SessionSummary {
  id: string;
  sessionId: string;
  startMsgId: string;
  endMsgId: string;
  summary: string;        // "用户对比 PG 和 Mongo 的事务机制..."
  keyTopics: string[];    // ["PG 事务隔离级别", "Mongo 索引", ...]
  keyEntities: string[];  // ["PostgreSQL", "MongoDB", "B+ 树", ...]
  createdAt: number;
}
```

### 13.4 摘要 CRUD（`storage.ts` 导出）

| 函数 | 行为 |
| --- | --- |
| `addSessionSummary(s)` | INSERT 一条摘要 |
| `getLatestSessionSummary(sessionId)` | 取该 session 最新一条（判断"距上次摘要又累积多少 turn"用） |
| `listSessionSummaries(sessionId, limit=50)` | 按时间正序列出（limit 默认 50，DB 端 DESC + JS 端 reverse） |
| `searchSessionSummaries(query, limit=3)` | **跨 session** SQL LIKE 搜索，取 query 里长度 ≥ 2 的 CJK/字母数字串，任一关键词命中即可 |
| `deleteSessionSummaries(sessionId)` | `chat.deleteSession` 时级联删 |

### 13.5 历史摘要召回（注入到 LLM 上下文）

`runSimpleChat` 与 `agent.ts` 在**每次发问时**先调 `searchSessionSummaries(payload.content, 2)`，命中 top 2 摘要后拼成 `summaryBlock` 注入到 system prompt 之前：

```
【历史对话摘要】
[#H1 2026-06-05 14:32] 用户询问 PG 事务隔离级别与 Mongo 文档事务的对比...
[#H2 2026-06-06 09:15] 用户确认使用 bge-m3 作为 embedding 模型...

【参考资料】
[#1 某文档.pdf | score=0.87]
...

【用户问题】
哪一章？
```

**为什么不存向量库而用 SQL LIKE**：
- 摘要的"查询模式"是关键词命中（用户复述"我们之前聊过 PG 事务"），不是语义相似
- SQL LIKE 命中度比向量检索更直接（"PG" 一词就是 key）
- 0 额外依赖、0 额外索引维护

### 13.6 已知约束

- 摘要是**异步生成**——刚结束的 user turn **不会**立刻被检索到；下一条 user 消息发问时才会触发"自上次以来 ≥ 20 turn"判断，然后 fire-and-forget 调 LLM
- 改写 LLM 用的 Provider/模型 即摘要 LLM（同一份 `resolveRewriterProvider`），但单次摘要 token 消耗约 1-2K（输入历史 + 输出 200-400 字 summary）
- `summaryTriggerTurns = 0` 时**关闭摘要但保留改写**——适合只想要"短问句消歧"、不要 LLM 异步调用的场景
- Agent 模式：`AgentInput.effectiveUserContent` 由 ipc-handlers 改写后传入；agent 主循环的 messages 仍以改写后的 query 为准，userContent 作 fallback
