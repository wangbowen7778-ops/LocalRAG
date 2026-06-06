# LocalRAG API 文档

> 本文档定义**渲染进程 → 主进程**的 IPC 接口。所有接口通过 `window.api` 暴露（在 `preload.ts` 中通过 `contextBridge.exposeInMainWorld` 注册）。
>
> **当前版本：v1.2.0**——新增 Agentic RAG（function_calling + 多轮迭代 + 跨 KB + LLM 自选 KB）。文档末尾的 [§11 Agentic RAG 协议](#11-agentic-rag-协议类型) 列出所有 Agent 相关的类型与事件。

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
  chunkSize: number;
  chunkOverlap: number;
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
