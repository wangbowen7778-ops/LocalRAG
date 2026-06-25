# LocalRAG API 文档

> 本文档定义**渲染进程 → 主进程**的 IPC 接口。所有接口通过 `window.api` 暴露（在 `preload.ts` 中通过 `contextBridge.exposeInMainWorld` 注册）。
>
> **当前版本：v1.3.6 (公开版，与内部里程碑号对齐)**——本次随 v1.3.4（闲聊短路 + 会话等待串扰修复）、v1.3.5（检索性能优化：分步耗时日志 + rerank/plan 改流式 + rerank 10s 超时，rerank 实测 33s→3.7s）一并发布。详见 [§18.8 v1.3.5 性能优化](#188-v135-检索性能优化) 与 [§17.9 v1.3.4 闲聊短路](#179-v134-增量闲聊短路)。
> - **Agentic RAG**（v1.2.0 内部里程碑；详见 [§11](#11-agentic-rag-协议类型)）
> - **智能切分**（v1.2.1 内部里程碑；按文件类型分发，token 单位；详见 `src/main/chunkers/`）
> - **查询改写**（v1.2.2 内部里程碑；v1.2.4 删除改写 LLM 调用；v1.2.6 重新引入 always-LLM 消解但只用于检索侧）
> - **长会话上下文**（v1.2.3 内部里程碑；v1.2.4 简化为 `buildHistory` 智能截断；保留跨 session 摘要）
> - **智能 context 截断 + read_chunk 工具**（v1.2.4 内部里程碑；详见 [§14 read_chunk 工具流](#14-read_chunk-工具流v124)）
> - **检索 query 消解**（v1.2.5 → v1.2.6 内部里程碑；v1.2.5 加 `query-resolver.ts` 三件套（stripQuestionTail / isAnaphoric / condenseWithLlm），v1.2.6 删 regex 门控改为 always-LLM；v1.3.0 起由 query-rewriter 替代；详见 [§15 query-resolver（历史）](#15-检索-query-消解query-resolverv125--v126)）
> - **preview 截断硬规则**（v1.2.7 内部里程碑；详见 [§16 preview 截断硬规则](#16-preview-截断硬规则v127)）
> - **混合检索参数调优**（v1.2.8 内部里程碑；topK 5→8 / RRF_K 60→30 / fetchK ×10 / BM25 b 0.75→0.5）
> - **查询理解与重写管线**（v1.3.0 内部里程碑；v1.3.1 加 stripNoise 剥寒暄/语气词；v1.3.4 加闲聊短路 skipSearch；v1.3.5 plan 改流式；详见 [§17 query-rewriter](#17-查询理解与重写管线-query-rewriterv130)）
> - **检索结果 LLM rerank**（v1.3.2 内部里程碑；召回 20 候选 → LLM 语义重排 → 取 topK；v1.3.3 rerank 开时发全文；v1.3.5 改流式 + 10s 超时兜底；详见 [§18 reranker](#18-检索结果-llm-rerankrerankerv132)）
> - **闲聊短路**（v1.3.4 内部里程碑；"你好"等闲聊跳过检索直接主答，省 2-3 次 LLM/API 调用）
> - **检索性能优化**（v1.3.5 内部里程碑；分步耗时日志 + rerank/plan 改流式 + rerank 10s 超时；rerank 实测 33s→3.7s）
> - **公开版版本号对齐**（v1.3.6；package.json + APP_VERSION 1.3.0→1.3.6，与内部里程碑号统一）

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
> **v1.2.2 起**（v1.2.4 已删除）：原"查询改写"逻辑——指代词 + 长度 < 6 的短问句调改写 LLM 补成自包含 query。v1.2.4 起被**智能 context 截断**替代——LLM 直接看到完整 history，指代自然消解，不再需要"改写 query"。
>
> **v1.2.3 起**（v1.2.4 简化）：跨 session 摘要召回 + 周期摘要仍保留。改写 LLM 的 history 压缩 (`buildRewriteHistory`) 被 v1.2.4 的 `buildHistory`（context-builder.ts）替代——按模型 context window 智能截断，64K 模型约 40 turn 内不触发压缩。
>
> **v1.2.4 起**：`buildHistory` 智能 history 截断 + `read_chunk` 工具按需取片段。简单模式（`Settings.enableReadChunkTool` 默认开）检索后只把"索引 + preview"发到 LLM，LLM 按需 `read_chunk(chunk_id)` 拉全文，节省 ~60-80% chunk 相关 token。Agent 模式（`mode='agent'`）的 `AGENT_TOOLS` 永远包含 `read_chunk`。详见 [§14 read_chunk 工具流](#14-read_chunk-工具流v124)。

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
  /** v1.2.4+ 简单模式 read_chunk 工具开关。默认 true。
   *  true：检索后只把"索引 + preview"发到 LLM，LLM 按需调 read_chunk(chunk_id) 拉完整内容，节省 ~60-80% token。
   *  false：退回 v1.2.3 行为（topK 全文塞 LLM），适合 Provider 不支持 function_calling 的情况。
   *  仅对简单模式生效；Agent 模式永远使用 read_chunk。 */
  enableReadChunkTool?: boolean;
  /** v1.3.0+ 查询理解管线开关（query-rewriter）。默认 true。
   *  true：每条 user 消息在检索前先调 LLM 把口语化/短/多意图 query 翻译为 1-3 条可检索 query，
   *       多 query 走 RRF 融合（hybridSearchMultiQuery）后喂给向量库。简单模式 + Agent 模式共享。
   *  false：退化为 v1.2.6 行为（单条原 query → hybridSearch）。
   *  失败时（缺 key / LLM 抛错）自动 fallback 到原 query。 */
  enableQueryRewriter?: boolean;
  /** v1.3.0+ 自定义 rewriter 用 Provider；空则走 Chat Provider。改写任务简单可指定便宜模型 */
  queryRewriterProviderId?: string;
  /** v1.3.0+ 自定义 rewriter 用 Model；空则走 Chat Provider 的 chatModel */
  queryRewriterModel?: string;
  /** v1.3.2+ 检索后 LLM rerank 开关。默认 true。
   *  true：检索召回 20 个候选 → Chat Provider 小 LLM 按语义相关度重排 → 取 topK 喂主答 LLM。
   *       解决「正确答案被 BM25/RRF 排到 topK 外」（长整章 chunk 关键词堆砌压过答案子 chunk）。
   *  false：退化为 RRF 原顺序。
   *  简单模式 + Agent 模式共享。Agent 模式每次 search_kb 多 1 次 LLM 调用。失败时自动回退原顺序。 */
  enableRerank?: boolean;
  /** v1.2.2 字段（v1.2.4 已删除，保留字段定义以兼容老 DB JSON） */
  enableQueryRewrite?: boolean;
  /** v1.2.2 字段（v1.2.4 已删除） */
  rewriterProviderId?: string;
  /** v1.2.2 字段（v1.2.4 已删除） */
  rewriterModel?: string;
  /** v1.2.3+ 周期摘要触发阈值：自上次摘要以来新增的 user turn 数 ≥ 此值时，
   *  fire-and-forget 调 LLM 生成一条 summary 写入 session_summaries 表。
   *  默认 20；设 0 关闭。v1.2.4 起摘要 LLM 复用 Chat Provider/模型（不再支持独立指定） */
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

## 12. ~~查询改写（v1.2.2+）—— v1.2.4 已删除~~

> **v1.2.4 删除**：v1.2.2 引入的"查询改写"机制（`rewriteQuery` / `buildRewriteHistory` / `ANAPHORIC_RE` / `rewriteCache` / `applyQueryRewrite`）在 v1.2.4 全部移除。设计反思：①多轮 RAG 的指代问题**不需要单独 LLM 调用**——只要 LLM 看到完整 history，指代自然消解；②每条 user 消息多 1 次 LLM 调用 + 进程内缓存的复杂度，与"LLM 看到全 history 后偶尔需要脑补"的成本不对称。v1.2.4 引入 `buildHistory`（见 [§13.1](#131-buildhistorycontext-builderts)）直接给 LLM 完整 history。**保留**：`Settings` 的 `enableQueryRewrite` / `rewriterProviderId` / `rewriterModel` 3 字段保留**字段定义**（标记 deprecated），老 DB JSON 里的字段会被忽略。

以下小节保留 v1.2.3 文档原样供历史追溯，**代码已不存在**，仅作设计记录。

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

## 13. 长会话上下文（v1.2.4 重构）

v1.2.4 重新设计了 **history 截断**逻辑：替代 v1.2.3 的 `buildRewriteHistory`（"近 8 条硬切"）+ v1.2.2 的改写 LLM 调用。核心思路：**让 LLM 看到完整 history，指代 / 省略自然消解**；只有 history 真的超出模型 context window 时才截断。

### 13.1 `buildHistory`（context-builder.ts，新）

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

> **v1.2.4 替代方案**：`buildRewriteHistory` 已删除。替代函数 `buildHistory` 在 `src/main/context-builder.ts`：
>
> ```ts
> // src/main/context-builder.ts
> export async function buildHistory(opts: {
>   sessionId: string;
>   currentUserMsgId: string;
>   model: string;            // 用于查 context window 上限
>   excludeRoles?: Message['role'][];
>   promptOverhead?: { sysPrompt?: string; currentUserPrompt?: string; summaryBlock?: string };
>   settings?: Settings;      // 触发 middle 压缩时调 LLM 用
> }): Promise<{
>   history: ChatMessage[];   // 构造好的 history（不含 system + current user）
>   middleSummary?: string;   // 触发了截断时被压缩的中间部分摘要
>   usedTokens: number;
>   truncated: boolean;
> }>
> ```
>
> **截断策略**（3 步）：
> 1. **能塞就全塞**——所有非 `tool` 角色的历史消息算 token 数，能塞进"模型 context window × 80% - overhead"就全塞
> 2. **超了截断**——firstUser（话题锚点）必带 + 末尾尽量多（`takeFromTail` 从尾部累积到 budget 用完） + 中间调 LLM 压缩（`quickCompressMiddle` 输出 200-400 字中文摘要）
> 3. **极端兜底**——session 全是 tool 消息时走 `takeFromTail` 兜底；firstUser + recent budget 都用完时 middle summary 回退到占位文字「（早期对话因 context 限制已被截断）」
>
> **模型 context window**（`MODEL_CONTEXT_WINDOWS`）：gpt-4o / gpt-4o-mini 128K，deepseek-chat 64K，qwen-turbo 1M，gpt-4 8K（容易触发截断），未知模型 32K 保守默认。
>
> **触发截断的粗估**（`avg 1.5K/turn`）：gpt-4o-mini 128K ~80 turn，deepseek-chat 64K ~40 turn，gpt-4 8K ~5 turn 就触发。

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

---

## 14. read_chunk 工具流（v1.2.4）

v1.2.4 解决"chunk 全文塞 LLM context 太长"问题。简单模式（`mode='simple'`）和 Agent 模式（`mode='agent'`）统一走 read_chunk 工具流——**检索后只把"索引 + preview"发到 LLM，LLM 按需 `read_chunk(chunk_id)` 拉完整内容**。

### 14.1 节省 token 原理

| 模式 | 旧行为（v1.2.3） | 新行为（v1.2.4） |
| --- | --- | --- |
| 简单模式 | topK=5 全文塞 LLM context（5×800=4000 token） | 5×200 preview（1000 token）+ LLM 实际读 1-2 段（按需 200-1000 token）= **节省 60-80%** |
| Agent 模式 | `search_kb` 工具响应内嵌 chunk 全文 | `search_kb` 只返回 preview + ID + score，LLM 调 `read_chunk` 取全文 |

### 14.2 `READ_CHUNK_TOOL` schema

`src/shared/constants.ts`：

```ts
export const READ_CHUNK_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'read_chunk',
    description: '按 chunk_id 读取片段完整内容。chunk_id 来自当前对话的【参考资料索引】或上一轮 search_kb 工具响应中的编号。调用前先看预览决定要不要读——避免全部读取浪费 token。',
    parameters: {
      type: 'object',
      properties: {
        chunk_id: { type: 'string', description: '片段编号（数字字符串，如 "1" "2" "3"）' },
      },
      required: ['chunk_id'],
    },
  },
};
```

### 14.3 简单模式 read_chunk 流

`runSimpleChat` 在 `Settings.enableReadChunkTool !== false`（默认开）且 `allHits.length > 0` 时走 read_chunk 工具流：

1. **构造 chunkMap**（`#1 → hit1, #2 → hit2, ...`） + `previewLines`（每条 200 字 preview + score + filename）
2. **chatStream 第一轮**带 `[READ_CHUNK_TOOL]`，期望 LLM 调 `read_chunk(chunk_id)`
3. LLM 返回 `tool_calls` → 主进程查 chunkMap → 追加到 `messages` → chatStream 第二轮出 final
4. LLM 不调 read_chunk 直接答了 → 直接用第一轮 content + 默认 citations 收尾

**退路**（`runSimpleChatLegacy`）：`Settings.enableReadChunkTool === false` 或 chatStream 返回 400/422（Provider 不支持 tools）→ 退化到 v1.2.3 行为，把 topK 全文塞 LLM context。

### 14.4 Agent 模式 read_chunk 流

`AGENT_TOOLS` 永远包含 `READ_CHUNK_TOOL`（v1.2.4 统一）。`search_kb` 工具响应改为只返回 preview + chunk_id：

```
[#1 某文档.pdf | score=0.87]
Preview: 这是文档前 200 字...
（要看完整内容，调 read_chunk(chunk_id) 工具，参数是上面 #N 中的 N）

[#2 另一文档.pdf | score=0.74]
Preview: ...
```

LLM 按需调 `read_chunk(chunk_id)`，主进程查 `chunkMap` 返回完整内容。**引用追踪移到 read_chunk 调用时累计**（v1.2.0 时在 search_kb 内累计）。

### 14.5 已知约束

- 简单模式第一轮 read_chunk 是非流式（避免 tool_calls + stream 的双复杂流）；第二轮才流式
- LLM 不调 read_chunk 直接答了 → `allCitations` 用默认 topK（与 v1.2.3 行为一致）
- 简单模式最多 1 轮 read_chunk（再调就是浪费 token）；Agent 模式由 `agentMaxIterations` 限制
- `Settings.enableReadChunkTool` **仅对简单模式生效**——Agent 模式永远用 read_chunk（`AGENT_TOOLS` 固定）

---

## 12/13 → 14 章节迁移说明（v1.2.4）

| v1.2.3 章节 | v1.2.4 对应 |
| --- | --- |
| §12 查询改写（v1.2.2+） | **已删除**——`buildHistory` 替代 |
| §13.1 `buildRewriteHistory` | §13.1 `buildHistory`（context-builder.ts） |
| §13.2-13.4 周期摘要 | §13.3-13.4 周期摘要（保留，仅触发条件少 1 条） |
| §13.5 历史摘要召回 | §13.2 跨 session 摘要召回（保留） |
| （新增） | §14 read_chunk 工具流（v1.2.4 核心新特性） |

---

## 15. 检索 query 消解 query-resolver（v1.2.5 → v1.2.6）

**问题**：检索系统（向量库 + BM25）是 **stateless** 的——`embedText` + `hybridSearch` 发生在 LLM 看到 history 之前，拿的是裸 query（"第几章？" / "它的限流策略" / "这是哪个文件的内容？"），embedding 和 BM25 不知道历史。即便 LLM 端能消解（看到全 history 后知道指代前文），**也救不回已经被污染的检索 context**。

**v1.2.5 方案**（**已重构**）：`src/main/query-resolver.ts` 三件套——`stripQuestionTail`（cheap regex 剥除"这是哪个文件的内容？"等问句尾巴）+ `isAnaphoric`（cheap regex 命中"第N条/这/那/它/哪条/上条/刚才"等指代）+ `condenseWithLlm`（anaphoric 命中时调小模型凝成 self-contained 检索 query）。**v1.2.6 已删除 regex 门控**——`isAnaphoric` 盖不全开放表达（用户实测："第几章？" 的"几"不在表里 / "原文呢" / "适用范围" / "它的限流策略" / "为什么" 等大量真实指代都漏判）。

**v1.2.6 方案**（**已被 v1.2.7 替代**）：

### 15.1 主流程

`resolveSearchQuery(opts)` 走三步：

1. **cacheKey 命中** → `cache-hit`（同 `(sessionId, currentUserMsgId, currentQuery)` 二次调直接复用）
2. **首轮检测**（除 `currentUserMsgId` 外无 user/assistant 消息）→ `passthrough` 原 query
3. **有 history** → **总是**调 `condenseWithLlm`（v1.2.5 是 anaphoric 命中才调）→ LLM 看完整 history 自行判断"已自包含原样返回 / 否则替换指代"

```ts
// src/main/query-resolver.ts
import { listMessages } from './storage';
import { chatCompletion } from './api-client';
import { resolveSummaryProvider } from './document-processor';
import { SecureStore } from './secure-store';

export async function resolveSearchQuery(
  opts: ResolveSearchQueryOptions,
): Promise<ResolvedQuery> {
  const ck = cacheKey(opts);
  const cached = cache.get(ck);
  if (cached) {
    return { ...cached, steps: ['cache-hit', ...cached.steps] };
  }

  const steps: ResolvedQuery['steps'] = [];
  let searchQuery = opts.currentQuery.trim();
  let usedLlm = false;

  // 首轮检测：除 current 外有没有任何 user/assistant 消息
  const msgs = listMessages(opts.sessionId);
  const hasHistory = msgs.some(
    (m) =>
      m.id !== opts.currentUserMsgId &&
      (m.role === 'user' || m.role === 'assistant') &&
      (m.content ?? '').trim().length > 0,
  );

  if (!hasHistory) {
    steps.push('passthrough');
  } else {
    steps.push('llm-call');
    try {
      const condensed = await condenseWithLlm(msgs, opts.currentUserMsgId, searchQuery, opts.settings);
      if (condensed && condensed.length > 0 && condensed !== searchQuery) {
        searchQuery = condensed;
        usedLlm = true;
        steps.push('llm-condense');
      }
    } catch (e) {
      console.warn('[query-resolver] LLM 消解失败，使用原文：', (e as Error).message);
    }
  }

  const result: ResolvedQuery = { searchQuery, usedLlm, steps };
  cache.set(ck, result);
  return result;
}
```

### 15.2 `condenseWithLlm`（v1.2.6 重构）

**anchor 从"末条 user msg"扩到"最近 6 条 user/assistant"**（v1.2.5 是"末条 user msg"）——LLM 能看到前一轮 assistant 答案里的实体名（条例名 / 文件名 / 章节号），消解质量显著提升。

```ts
async function condenseWithLlm(
  allMessages: ReturnType<typeof listMessages>,
  currentUserMsgId: string,
  currentQuery: string,
  settings: Settings,
): Promise<string | undefined> {
  // 取最近 6 条 user/assistant（按时间顺序）
  const recent = allMessages
    .filter(
      (m) =>
        m.id !== currentUserMsgId &&
        (m.role === 'user' || m.role === 'assistant') &&
        (m.content ?? '').trim().length > 0,
    )
    .slice(-6);
  if (recent.length === 0) return undefined;

  const { provider, model } = resolveSummaryProvider(settings);
  const apiKey = await SecureStore.getApiKey(provider.id);
  if (!apiKey) return undefined; // 缺 key → 返 undefined 触发外层 fallback

  // 把每条压成 "用户/助手：内容" 单行，超 400 字截断
  const historyText = recent
    .map((m) => {
      const role = m.role === 'user' ? '用户' : '助手';
      const c = (m.content ?? '').replace(/\s+/g, ' ').trim();
      const truncated = c.length > 400 ? c.slice(0, 400) + '…' : c;
      return `${role}：${truncated}`;
    })
    .join('\n');

  const promptMessages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是检索 query 消解助手。给定对话历史和本轮用户问题，输出一个**自包含**的检索 query，' +
        '用于喂给向量库 + BM25 做相似度匹配（检索系统看不到对话历史）。\n' +
        '规则：\n' +
        '1. 如果本轮问题已经含足够实体名/具体概念，原样返回\n' +
        '2. 如果含指代（"它"/"那"）、省略（"第几章？"/"为什么？"/"详细说说"/"适用范围"）或' +
        '依赖上文（"对比一下"/"举个例子"），用 history 里具体的实体名（条例名、文件名、' +
        '产品名、章节号、API 名、专有名词）补全\n' +
        '3. 只输出改写后的 query 文本，不要解释、Markdown、JSON、引号、前缀',
    },
    {
      role: 'user',
      content: `【对话历史】\n${historyText}\n\n【本轮问题】\n${currentQuery}\n\n请输出自包含的检索 query。`,
    },
  ];

  const r = await chatCompletion(provider, apiKey, model, promptMessages, 0.1);
  const raw = (r.content || '').trim();
  // 清洗：去首尾引号 + 截第一行（防 LLM 偶尔追加解释尾巴）
  const cleaned = raw
    .replace(/^["「『]+|["」』]+$/g, '')
    .split('\n')[0]
    .trim();
  return cleaned || undefined;
}
```

### 15.3 接入点

**简单模式**（`mode='simple'`）：

```ts
// src/main/ipc-handlers.ts::runSimpleChat
const resolved = await resolveSearchQuery({
  sessionId,
  currentUserMsgId,
  currentQuery: payload.content,
  settings,
});
// resolved.searchQuery 喂 embedText + hybridSearch
// LLM 端 user prompt 仍用 payload.content（LLM 反正看全 history 也能消解）
```

**Agent 模式**（`mode='agent'`）：`query-resolver` 不参与——LLM 自己调 `search_kb` 输出 `sub_query`。v1.2.6 在 `AGENT_SYSTEM_PROMPT` 和 `AGENT_TOOLS.sub_query.description` 显式告诉 LLM "**sub_query 必须自包含**" + 3 个正反例：

```ts
// src/main/agent.ts::AGENT_SYSTEM_PROMPT 顶部警示段
`⚠ 调 search_kb 之前：sub_query 必须自包含
检索系统（向量库 + BM25）**看不到对话历史**，只看 sub_query 这一个字符串做相似度匹配。
用户问题含指代/省略时（"它"/"那"/"第几章"/"为什么"/"详细说说"），必须用对话历史里
具体的实体名（条例名、文件名、产品名、章节号、专有名词）补全后再传 sub_query。

示例：
- 上文聊《北京市殡葬管理条例》第十四条规定殡仪服务人员的职业道德，用户问 "第几章？"
  → sub_query="北京市殡葬管理条例 第十四条"（带条例名 + 条款编号，能命中含该条所属章节的片段）
- 上文聊 OpenAI API，用户问 "它的限流策略呢"
  → sub_query="OpenAI API 限流策略"（用 OpenAI API 替换"它"）
- 用户自包含问 "5G 和 4G 的区别"
  → sub_query="5G 和 4G 的区别"（原样使用）`
```

```ts
// src/shared/constants.ts::AGENT_TOOLS search_kb.sub_query.description
sub_query: {
  type: 'string',
  description:
    '针对当前子问题的精确检索词（去口语化、保留专有名词、错误码、API 名）。' +
    '**必须自包含**：检索系统（向量库 + BM25）看不到对话历史，只看本字符串做相似度匹配。' +
    '用户问题含指代/省略时（"它"/"那"/"第几章"/"为什么"/"详细说说"），' +
    '必须用对话历史里具体的实体名（条例名、文件名、产品名、章节号、专有名词）补全后再传。' +
    '反例："第几章？" / "为什么？" / "它的限流是多少" —— 这种孤立 query 召回必错。',
},
```

### 15.4 类型定义

```ts
// src/main/query-resolver.ts
export interface ResolveSearchQueryOptions {
  sessionId: string;
  currentUserMsgId: string;
  currentQuery: string;
  settings: Settings;
}

export interface ResolvedQuery {
  /** 用于 embedText + hybridSearch 的最终 query */
  searchQuery: string;
  /** 是否触发了 LLM 消解 */
  usedLlm: boolean;
  /** 命中的处理步骤（用于日志/debug） */
  steps: Array<'cache-hit' | 'passthrough' | 'llm-call' | 'llm-condense'>;
}
```

### 15.5 典型端到端

| 用户输入 | 旧行为（v1.2.5） | 新行为（v1.2.6） |
| --- | --- | --- |
| "第几章？"（上文聊《北京市殡葬管理条例》第十四条） | `isAnaphoric` 漏判（"几"不在表里）→ passthrough "第几章？" → embedding 召回全 KB 噪声（中医 / 动物防疫 / 科创中心） | `condenseWithLlm` 把 history 末 6 条喂 LLM → 改写为"北京市殡葬管理条例 第十四条" → embedding 命中该条所属章节的 chunk |
| "它的限流策略呢"（上文聊 OpenAI API） | `isAnaphoric` 命中（"它"在表里）→ 调 LLM 改写为"OpenAI API 限流策略" | 同样调 LLM 改写，结果一致 |
| "5G 和 4G 的区别"（自包含） | `isAnaphoric` 未命中 + 长度 ≥ 6 → passthrough 0 LLM 调用 | `hasHistory=false` 走 passthrough 0 LLM 调用 |
| Agent 模式 + "第几章？" | 旧 prompt 没显式要求 sub_query 自包含 → LLM 直译"第几章？"给 search_kb → 同样噪声 | `AGENT_SYSTEM_PROMPT` ⚠ 警示 + 3 个正反例 → LLM 自动生成 `sub_query="北京市殡葬管理条例 第十四条"` → search_kb 命中正确 chunk |

### 15.6 关键设计取舍

- **always-LLM vs 选择性 LLM**：v1.2.5 的"先 regex 判断再决定调不调"看似省 LLM 调用，但误判率太高（漏的 case 后续会被用户重复触发）——always-LLM 在 multi-turn 会话里总成本更低
- **每条 multi-turn user msg 多 1 次 chatCompletion**（≈200-300 token 小模型，温度 0.1）——与 v1.2.2 的 query rewriting 同档
- **不嵌进 LLM context**：`resolved.searchQuery` 只喂 `embedText` + `hybridSearch`；LLM 端 user prompt 仍用 `payload.content`（LLM 反正自己看全 history 也能消解）
- **回退链**：缺 Chat Provider API Key / LLM 抛错 / 返回空 / 返回同 query → 全部 fallback 原文，**不阻塞**主流程
- **缓存 key 含 `currentUserMsgId`**：避免"同 query 不同 turn 拿到陈旧 resolved"

### 15.7 自检脚本

`scripts/query-resolver-selftest.js` 重写为 **5 组 13 个用例**：

1. **首轮 passthrough**（3 断言）：`hasHistory=false` → `usedLlm=false` + 走 `passthrough` step + 原文返回
2. **有 history 缺 LLM key → fallback**（4 断言）：走 `llm-call` 路径（尝试过）+ 不会标 `llm-condense` + `searchQuery` 原文
3. **cache hit**（2 断言）：同 opts 二次调首个 step 是 `cache-hit` + 结果一致
4. **cache key 隔离**（2 断言）：同 query 同 session 不同 msgId 不共享 cache
5. **空白 history 当首轮 passthrough**（2 断言）：除 current 外只有空白消息 → `passthrough` + 0 LLM 调用

**端到端 LLM 消解用例**需要 Chat Provider API Key（`resolveSummaryProvider` 走 Chat Provider），留给手动跑——在 LocalRAG 内启用 Provider + 真用 chat 触发。

---

## 14 → 15 章节迁移说明（v1.2.6）

| v1.2.5 章节 | v1.2.6 对应 |
| --- | --- |
| §15.1 主流程 | §15.1 主流程（regex 门控删除，always-LLM） |
| §15.2 `condenseWithLlm` | §15.2 `condenseWithLlm`（anchor 扩到 6 条 + system prompt 重写） |
| §15.3 接入点 | §15.3 接入点（agent 模式新增 sub_query 自包含 prompt） |
| §15.4 类型定义 | §15.4 类型定义（删 `'tail-strip'` 步骤） |
| （新增） | §15.5-15.7 端到端 / 设计取舍 / 自检脚本 |


---

## 16. preview 截断硬规则（v1.2.7）

**v1.2.4 引入 read_chunk 工具流后**，检索结果只发"索引 + preview（200 字符）"给 LLM 节省 token。LLM 按需 `read_chunk(chunk_id)` 拉完整内容。**v1.2.4 ~ v1.2.6 三个版本累积**用户实测发现：当源 chunk 是**列举 / 条款 / 编号型**（如"第十三条 (一)~(六)"），200 字符 preview 只能装下前 4-5 条，末尾的省略号 `…` 视觉上像自然结尾，LLM 经常直接基于截断的 preview 答错——用户实测问"条例第二章第十三条前后关于备案事项的完整规定"，AI 答出 (一)~(五) 截止到"变更…"，漏答 (六) "设立分支机构"。

**v1.2.7 三件套**：(1) 新建 `src/main/preview.ts` 抽 `formatChunkPreview` 跨 simple/agent 共享，截断时显式追加 `[TRUNCATED: 共 N 字...]` 标记 + read_chunk 指引；(2) Citation.chunk 改存全文（UI 引用块 + readContext 兜底用真实全文本）；(3) system prompt + tool description 把"列举/条款/编号型内容必须 read_chunk"升级为 hard rule。

### 16.1 `formatChunkPreview(hit, chunkId)`（`src/main/preview.ts`）

```ts
const PREVIEW_MAX_CHARS = 200;

interface ChunkPreviewInput {
  docId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  score: number;
}

function formatChunkPreview(hit: ChunkPreviewInput, chunkId: string): string {
  const previewText = hit.text.slice(0, PREVIEW_MAX_CHARS);
  const isTruncated = hit.text.length > PREVIEW_MAX_CHARS;
  const header = `[#${chunkId} ${hit.filename} | score=${hit.score.toFixed(2)}]`;
  const preview = `Preview: ${previewText}${isTruncated ? '…' : ''}`;
  if (!isTruncated) {
    return `${header}\n${preview}`;
  }
  const truncationNote =
    `[TRUNCATED: 共 ${hit.text.length} 字，仅显示前 ${PREVIEW_MAX_CHARS} 字；` +
    `列举/条款/编号型内容请先 read_chunk(${chunkId}) 取完整内容再引用]`;
  return `${header}\n${preview}\n${truncationNote}`;
}
```

**输出示例**（短文本，150 字）：

```
[#1 北京市地方金融监督管理条例.pdf | score=0.85]
Preview: 第十三条 地方金融组织的下列事项，应当经市地方金融监督管理部门审批，且应当依法办理相关登记、报告或者备案手续。
```

**输出示例**（长文本，280 字）：

```
[#1 北京市地方金融监督管理条例.pdf | score=0.85]
Preview: 第十三条 地方金融组织的下列事项，应当经市地方金融监督管理部门审批，且应当依法办理相关登记、报告或者备案手续。地方金融组织应当依法开展业务，遵守审慎经营原则，建立健全内部控制和风险管理制度，落实各项监管要求。具体包括以下六类事项：
（一）合并、分立；
（二）变更注册资本；
（三）变更业务范围、营业区域等；
（四）变更交易规则、交易品种；
（五）变更持股5%以上的股东，变更董事、监事、高级管理人员；
（六）设立分支机构；
（八）其…
[TRUNCATED: 共 280 字，仅显示前 200 字；列举/条款/编号型内容请先 read_chunk(1) 取完整内容再引用]
```

### 16.2 Citation.chunk 改存全文（v1.2.7）

| 位点 | v1.2.4~v1.2.6 | v1.2.7 |
| --- | --- | --- |
| `runSimpleChat` 的 `allCitations` | `c.text.slice(0, 200)` | `c.text`（存全文） |
| `runSimpleChat` 的 `legacyCitations` | `c.text.slice(0, 200)` | `c.text` |
| `runSimpleChat` 的 provider error fallback | `c.text.slice(0, 200)` | `c.text` |
| `runSimpleChat` 的 dedup 比较 + chunk 字段 | `chunk: c.text.slice(0, 200)` | `chunk: c.text` |
| `runSimpleChat` 的 `finalCitations` | `c.text.slice(0, 200)` | `c.text` |
| `runAgent` 的 dedup 比较 | `chunk.text.slice(0, 200)` | `chunk.text` |
| `runAgent` 的 chunk 字段 | `chunk: chunk.text.slice(0, 200)` | `chunk: chunk.text` |

**意义**：
- **UI 引用块**（用户展开"引用来源"看到的内容）现在显示真实 chunk 全文本（之前是 200 字符 preview，用户看到的就是被截断的内容）
- **readContext 兜底分支**（LLM 拒答时回退用）现在用真实 chunk 全文本（之前是 200 字符 preview，兜底用内容也不完整）
- **UI 配套**：`MessageBubble.tsx` 引用块加 `max-h-40 overflow-auto`（长引用可滚动）+ `whitespace-pre-wrap`（换行正确显示）

### 16.3 system prompt + tool description 硬规则（v1.2.7）

**`SIMPLE_CHAT_SYS_PROMPT`**（`src/main/ipc-handlers.ts:174`）加：
```
- 硬规则（v1.2.7）：preview 末尾出现 [TRUNCATED: 共 N 字...] 标记 且 内容看起来像列举/条款/编号型
  （(一)(二)(三) / 第N条/章/款 / 1.1.2 / A. B. C. / - 列表项 等）
  → **必须先调 read_chunk(N) 拿完整内容再引用**——避免把被截断的 preview 当成完整列表答错
```

**`AGENT_SYSTEM_PROMPT`**（`src/main/agent.ts:521`）同样加硬规则段。

**`READ_CHUNK_TOOL.description`**（`src/shared/constants.ts:71`）加 `**v1.2.7 硬规则**` 段：
```
**v1.2.7 硬规则**：如果 preview 末尾有 [TRUNCATED: 共 N 字...] 标记 且 内容像列举/条款/编号型
  → 引用前**必须**先 read_chunk(N) 拿完整内容——避免把截断的 preview 当成完整列表答错
```

### 16.4 端到端场景（用户实测的"条例第十三条 (一)~(六)"）

**旧行为（v1.2.4~v1.2.6）**：
- 源 chunk 长 280 字符（包含法律序言 + 6 条 (一)~(八)）
- preview 装下 (一)~(五) + "（八）其…"
- LLM 看到末尾 `…` 视觉上像自然结尾
- system prompt 是 soft 引导（"想看具体内容调 read_chunk"），LLM 把它当可选项
- 直接答出 (一)~(五) 截止到"变更…"，漏答 (六) "设立分支机构"

**新行为（v1.2.7）**：
- preview 末尾显式追加 `[TRUNCATED: 共 280 字，仅显示前 200 字；列举/条款/编号型内容请先 read_chunk(1) 取完整内容再引用]`
- system prompt 硬规则命中（"列举型内容" + "TRUNCATED 标记"）
- LLM 调 `read_chunk(1)` 拿完整 6 条
- 答出 (一)~(六) 全部

### 16.5 关键设计取舍

- **soft 引导 → hard rule**：v1.2.4 时 `READ_CHUNK_TOOL.description` 写"想看具体内容调 read_chunk"——LLM 把它当可选项；v1.2.7 改成 hard rule（"必须"）+ 列举 4 种典型列表型格式帮助 LLM 识别截断风险
- **不动 retrieval 逻辑**：preview 仍 200 字符（节省 token）；只改"告诉 LLM 这是截断的方式"
- **Citation.chunk 存全文**：UI 引用块 + readContext 兜底用真实全文本——之前是 200 字符 preview，用户看到的引用 + 系统兜底用内容都不完整
- **跨 simple/agent 共享**：`formatChunkPreview` 抽到 `src/main/preview.ts`，避免 simple 模式 / agent 模式两套格式逻辑漂移

### 16.6 自检脚本（`scripts/citation-preview-selftest.js`）

7 组 21 个用例：
1. **短文本不加 TRUNCATED**（3）：<= 200 字符不加 TRUNCATED 标记 + header 格式 + preview body 完整
2. **长文本加 TRUNCATED**（4）：> 200 字符加 TRUNCATED + 总字数 + 截断位置 + read_chunk 编号
3. **列举型长文本**（5）：用户实战"第十三条 (一)~(六)"场景，验证 (六) 落在 preview body 之外 + 指引出现 read_chunk(1) + 总字数标记
4. **preview body 长度限制**（3）：恰好 201 字符（含末尾省略号）
5. **chunkId 嵌入**（2）：chunkId=5 / chunkId=42 都能正确出现在指引里
6. **边界 200 字不加 TRUNCATED**（2）：恰好 200 字不加 TRUNCATED（200 字符已经全显示）+ 不加省略号
7. **边界 201 字加 TRUNCATED**（2）：201 字加 TRUNCATED + 总字数 201

跑法：`npm run build:main && node scripts/citation-preview-selftest.js`（全部 21/21 通过）。

---

## 15 → 16 章节迁移说明（v1.2.7）

本版本新增 §16 章节专门讲 preview 截断硬规则。§14 read_chunk 工具流的接口（`READ_CHUNK_TOOL` schema、简单/Agent 模式工具流）保持不变——v1.2.7 只是在 §14 的基础上加了三层防护（显式 [TRUNCATED] 标记 + Citation.chunk 全文 + system prompt 硬规则），让 LLM 真正把"列举型 preview 是被截断的"这件事看在眼里。

## 17. 查询理解与重写管线 query-rewriter（v1.3.0）

**v1.2.6 → v1.3.0 变更**：v1.2.6 的 `query-resolver.ts`（v1.2.5 首版 + v1.2.6 改 always-LLM）只做"指代消解"，v1.3.0 升级为完整管线——把口语化/短/多意图 query 翻译为 1-3 条可检索 query，多 query 走 RRF 融合后喂给向量库。`src/main/query-resolver.ts` 和 `scripts/query-resolver-selftest.js` 已删除（v1.2.5 / v1.2.6 段保留为历史记录）。

### 17.1 `QueryPlan` 类型（`src/main/query-rewriter.ts`）

```ts
export type QueryIntent = 'factual' | 'how-to' | 'comparison' | 'summary' | 'definition' | 'other';
export type PlanStep = 'cache-hit' | 'passthrough' | 'llm-call' | 'llm-rewrite' | 'llm-expand' | 'llm-decompose';

export interface QueryPlan {
  /** 1-3 条改写/扩展后的 query，每条都能独立喂给 hybridSearch */
  searchQueries: string[];
  /** 问题意图（log 用，预留给未来 topK 调整） */
  intent: QueryIntent;
  /** 关键实体 / 同义词（暂存，预留给 BM25 term boost） */
  expandedTerms: string[];
  /** 提示"需要更高召回"（列举/对比类），暂时只在 log 体现 */
  needsHighRecall: boolean;
  /** 调试用：命中的处理步骤 */
  steps: PlanStep[];
  /** 是否触发了 LLM 调用 */
  usedLlm: boolean;
}
```

### 17.2 `planSearchQuery(opts)` 主入口

```ts
export interface PlanSearchQueryOptions {
  sessionId: string;
  currentUserMsgId: string;
  currentQuery: string;
  settings: Settings;
}

export async function planSearchQuery(opts: PlanSearchQueryOptions): Promise<QueryPlan>
```

**主流程三步走**（与 v1.2.6 query-resolver 同构）：
1. **cacheKey 命中** → 直接返回（steps 带 cache-hit 前缀）
2. **首轮 passthrough**（无 user/assistant history）→ `{ searchQueries: [rawQuery] }`，不开 LLM 调用
3. **有 history → 总是调 LLM** 产 JSON plan（temperature=0.1）

**失败兜底链**（任何环节失败都退化为 `{ searchQueries: [rawQuery] }` + console.warn）：
- 缺 LLM key → `resolveSummaryProvider` 返回的 Provider 无 key
- LLM 抛错 → catch + warn
- LLM 返回空 / JSON 解析失败 / `searchQueries` 不是非空字符串数组 → undefined

**LLM 输出 schema**（`extractFirstJson` 容忍 ```json fences + 裸 JSON）：
```json
{
  "intent": "factual | how-to | comparison | summary | definition | other",
  "searchQueries": ["q1", "q2", "q3"],
  "expandedTerms": ["term1", "term2"],
  "needsHighRecall": true
}
```

**清洗规则**：
- `searchQueries` 去重 + 截到 3 条 + 过滤非 string + 截 200 字
- `intent` 容错大小写 + 拼写错误 → fallback `'other'`
- `expandedTerms` 截到 10 条

### 17.3 `hybridSearchMultiQuery()`（`src/main/vector-store.ts`）

```ts
export async function hybridSearchMultiQuery(
  kbId: string,
  queryTexts: string[],
  queryVecs: number[][],  // 一一对应
  topK: number,
  options: { enableBm25?: boolean } = {},
): Promise<SearchHit[]>
```

**实现要点**：
- 单 query 退化为 `hybridSearch` fastpath（与 `hybridSearchMulti` 单 KB 走 fastpath 一致）
- 多 query：每路 fetchK = `max(50, 8×topK)`，`Promise.allSettled` 并发跑 `hybridSearch`
- RRF 全局融合：key = `docId|chunkIndex`，每路 rank 独立算 RRF 贡献（RRF_K = 30 与 `hybridSearch` / `hybridSearchMulti` 同步）
- 输出 topK + 归一化 score（`(RRF_K+1)/2 = 15.5` NORMALIZER）
- 任一 query 检索失败不阻塞其他 query（`allSettled`）

**与 `hybridSearchMulti` 跨 KB 检索的区别**：
- `hybridSearchMulti`：输入是「多 KB + 1 query」→ 多 KB 并发后全局融合
- `hybridSearchMultiQuery`：输入是「1 KB + 多 query」→ 多 query 并发后全局融合
- 两者可嵌套（多 KB + 多 query），但 v1.3.0 暂未用——Agent 模式仍用 `hybridSearchMulti`

### 17.4 接入点

**简单模式**（`ipc-handlers.ts::runSimpleChat`）：
```ts
const plan = await planSearchQuery({...});
searchQueries = plan.searchQueries;
const queryVecs = await Promise.all(searchQueries.map(q => embedText(...)));
const rawHits = await hybridSearchMultiQuery(kbId, searchQueries, queryVecs, topK, { enableBm25 });
```

**Agent 模式**（`agent.ts::runAgent`）：
- 循环开始前调一次 `planSearchQuery`
- 把 `plan.searchQueries` 拼到 system prompt 的「⚠ sub_query 必须自包含」段下面作为「已改写候选 query（供参考）」
- LLM 仍可自主调 `search_kb` 输出 sub_query（保持自主决策权），plan 仅作"参考起点"

**Settings 开关**：`Settings.enableQueryRewriter`（默认 true）= false 时退化为 v1.2.6 行为（单条原 query → `hybridSearch`）。

### 17.5 关键设计取舍

- **替换而非叠加 query-resolver**——`query-rewriter` 的 `searchQueries[0]` 已包含指代消解能力，叠加会导致每轮 2 次 LLM 调用 + 收益重叠
- **多 query 融合而非单 query 拼接**——RRF 融合让 LLM 改写结果不一致时仍能兜底，"q1 OR q2 OR q3" 字符串拼接会让 BM25 稀有词淹没
- **Agent 模式预计算 plan 但不强制使用**——LLM 仍可自调 search_kb，plan 仅作"参考起点"
- **不做 HyDE**——成本高（200+ 字生成）+ LLM 幻觉会污染 embedding，留给未来
- **plan 上限 3 条**——太多会拖慢检索（每条都跑 hybridSearch），3 条是经验值
- **`expandedTerms` 字段预留**——暂不接 BM25 term boost，留给未来按需启用

### 17.6 自检脚本（`scripts/query-rewriter-selftest.js`）

13 组 34 个用例（不需要 Chat Provider API Key）全部通过：
1. 首轮（无 history）→ passthrough
2. 有 history 但缺 LLM key → fallback 原 query
3. LLM 抛错 → fallback 原 query
4. LLM 返回非 JSON → fallback 原 query
5. LLM 返回空 searchQueries → fallback 原 query
6. LLM 返回 5 条 → 截断到 3 条
7. LLM 返回 searchQueries 含重复 → 去重
8. LLM 返回 searchQueries 元素非 string → 过滤
9. LLM 返回非标准 intent → fallback 'other'
10. cache hit（同 opts 二次调直接命中）
11. cache key 隔离（不同 msgId 不共享 cache）
12. 仅有空白 history → 当首轮 passthrough
13. LLM 返回合法 JSON → 正确解析 searchQueries / intent / expandedTerms

端到端 LLM 改写用例需要真 Chat Provider API Key，留给手动跑（在 LocalRAG 内启用 Provider + 真用 chat 触发）。

### 17.7 升级说明

v1.2.x 老用户升级：自动切换到 v1.3.0 行为；`Settings.enableQueryRewriter` 默认 undefined → 走代码默认 `true`（除非显式存了 false）；`query-resolver.ts` 删除不影响 DB（无对应 settings 字段）；`Settings.enableQueryRewrite` / `rewriterProviderId` / `rewriterModel` 3 字段（v1.2.2 留下）保留**字段定义**（兼容老 DB JSON，运行时忽略）。

### 17.8 v1.3.1 增量：stripNoise 预处理

v1.3.1 在 `planSearchQuery` 入口加 `stripNoise(query)` 预处理（纯 regex、零 LLM 成本）：

- 剥寒暄开头（`请问一下/麻烦问下/我想了解一下/帮我查一下/您好/你好/哈喽/嗨` 等 20+ 前缀）
- 剥闲聊尾巴（`谢谢/感谢/麻烦了/辛苦了/thanks` 等）
- 剥句末疑问语气词「呢」
- 剥后为空（用户只输入寒暄）→ 退回原文，不送空 query

首轮 passthrough 与多轮 LLM 改写都先过一遍（`originalQuery = stripNoise(opts.currentQuery.trim())`）。`planWithLlm` 的 systemPrompt 加规则 0 显式要求 LLM 先剥离无效词再做指代/扩展/分解判断。

保守防误伤：只剥明确无检索价值的成分，不动指代词（它/那/这——留给多轮 LLM 消解）与实体名；句末语气词只剥「呢」（几乎不可能是术语/实体名合法结尾），不剥「啊/呀/吧」等误伤风险高的。

### 17.9 v1.3.4 增量：闲聊短路（skipSearch）

v1.3.4 给 `QueryPlan` 加 `skipSearch: boolean` 字段——命中闲聊→跳过整个检索直接主答，省 1-3 次 embed API + 1 次 hybridSearch + 1 次 rerank LLM。

```ts
export interface QueryPlan {
  searchQueries: string[];
  intent: QueryIntent;
  expandedTerms: string[];
  needsHighRecall: boolean;
  skipSearch: boolean;   // v1.3.4：true=跳过检索直接主答
  steps: PlanStep[];     // 加 'skip-chitchat'
  usedLlm: boolean;
}
```

**首轮**（无 history，passthrough 不调 LLM）：cheap regex `CHITCHAT_RE`（`query-rewriter.ts`）检测纯问候（"你好/谢谢/在吗/嗨"等 ≤8 字、剥 Noise 后整句就是问候）。极保守——含疑问词/实义内容的不命中，"你好，请问限流策略"stripNoise 后非纯问候也不命中。

**多轮**（有 history，调 LLM）：`planWithLlm` prompt 加规则 6 让 LLM 判断"是否需要检索"返回 `skipSearch`，明确"拿不准一律 false（宁可检索别漏答）"。

**失败兜底**：LLM 抛错/非 JSON/未返回 skipSearch → `skipSearch=false`（宁可不短路别漏答）。

**接入**（`ipc-handlers.ts::runSimpleChat`）：检索段整个 `try` 块包进 `if (!skipSearch)`，闲聊时 allHits/citations/contextText 保持空直接走 chatStream 主答。

**会话等待串扰修复**（`src/renderer/hooks/useChat.ts`，v1.3.4）：加 `streamingSessionRef` 跟踪当前流式 sessionId（send 设/done/catch 清）；`activeSession` 切换时若切到的不是正在流式的会话→重置 streaming 态（新会话干净），切回正在流式的原会话不动（事件订阅按 sessionId 过滤，token/done 仍续上不丢内容）。修复"一个会话提问时其他对话也显示等待"。

## 18. 检索结果 LLM rerank（reranker）（v1.3.2）

### 18.1 背景

v1.2.8/v1.2.9 调了一轮 BM25/RRF 参数（topK 5→8、fetchK=max(50,10×topK)、RRF_K 60→30、b 0.75→0.5）但没根治「正确答案被排到 topK 外」。用户实测复现「北京历史文化名城保护条例 第二章第十三条前后备案事项」：BM25 把正确答案（chunk 7 含第十九-二十二条）排到 rank 12，8 个整章 chunk 的 BM25 分数挤在 10% 区间内（29.97/27.04/26.81/...），区分度极低；RRF 融合后答案落到 rank 6 边缘，topK 切掉，LLM 拿到整章总则 chunk 幻觉出"第四章只有第三十四条"。

根因：BM25 中文 unigram 分词让条例名前缀（每章节 chunk 都以「北京历史文化名城保护条例 第N章」开头）稀释 IDF，8 个整章 chunk tf 命中 query 关键词次数多 → BM25 分高；length norm 力度不够压不住长 chunk。继续调参边际递减——根因是 BM25 对中文长结构化文档区分度本身不够。改用 LLM 语义重排（CLAUDE.md v1.2.8 已预留为"终极方案"）。

### 18.2 `rerankHits()` 主入口（`src/main/reranker.ts`）

```ts
export async function rerankHits(
  query: string,        // 用户原始问题（简单模式 payload.content；agent 模式 sub_query）
  hits: SearchHit[],    // 检索返回的候选（已扩召回，长度可达 20+）
  settings: Settings,
): Promise<SearchHit[]> // 重排后的 hits（顺序变，score 保留原 RRF norm 值）
```

实现要点：

- **resolve**：复用 `resolveSummaryProvider(settings)` 拿 `{provider, model}`；`SecureStore.getApiKey(provider.id)` 取 key，缺 key → 返回原 hits
- **候选上限 20**：`hits.slice(0, 20)`（防 prompt 爆），>20 的尾部 rerank 后原样追加
- **≤1 hit 直接返回**不调 LLM（省 token）
- **prompt**：system「你是检索结果重排助手…优先语义匹配，不要被片段长度/关键词堆砌误导；含问题所问具体条款/章节号/实体的片段优先；整章总则类片段排在具体条款片段之后」+ user「【问题】+【片段 #1..#N preview（200 字）】」。preview 用 `hit.text.slice(0, 200)`，不调 `formatChunkPreview`（避免带 score/TRUNCATED 标记干扰）
- **调用**：`chatCompletion(provider, apiKey, model, messages, 0.1)`（不带 tools，复用 `src/main/api-client.ts`）
- **解析**：LLM 输出 `{"order":[编号降序]}`；order 是 1-based 编号数组，映射回 candidates 索引，去重 + 跳过越界/非整数；按 order 重排，未列入的候选按原 RRF 顺序追加末尾
- **不替换 score**：重排后的 hit 保留原 `h.score`（RRF norm），只调顺序
- **降级链**（全部返回原 hits 原顺序 + console.warn）：缺 key / chatCompletion 抛错 / 返回空 / JSON 解析失败 / order 非非空整数数组

### 18.3 接入点

| 模式 | 文件:函数 | 插入位置 | 扩召回方式 |
| --- | --- | --- | --- |
| 简单模式 | `ipc-handlers.ts::runSimpleChat` | `hybridSearchMultiQuery` 后、构造 context 前 | `fetchTopK = enableRerank ? Math.max(topK, 20) : topK` |
| Agent 模式 | `agent.ts::runAgent` search_kb 段 | `hybridSearchMulti` 后、`formatChunkPreview` 前 | 同上 |

两路都是：检索（传 fetchTopK）→ `rerankHits` → `slice(topK)` → threshold 过滤。rerank 先于 threshold 让 LLM 在更大候选池挑（防低 RRF 分但语义相关的 chunk 被误杀）。不改 `vector-store.ts` 检索签名——扩召回靠调用方传大 topK。

### 18.4 关键设计取舍

- **只重排顺序，不替换 score**——RRF norm score 保留，`citationScoreThreshold` / citation 逻辑零侵入
- **复用 `resolveSummaryProvider`**（走 Chat Provider + chatModel，同 summary/rewriter），无新依赖；不加独立 rerank Provider/Model 配置
- **候选上限 20**——更大的候选池会让 rerank LLM prompt 变长、变慢；20 是经验值
- **不做 cross-encoder**——需本地模型，违背零 native 依赖
- **不改切片策略**——按条切是另一条路（根治 BM25 tf 稀释），影响全库，留后续

### 18.5 自检脚本

`scripts/reranker-selftest.js`（mock `chatCompletion` + `resolveSummaryProvider` + `SecureStore`）8 组 18 用例：

1. hits ≤ 1 → 不调 LLM
2. 缺 key → 返回原 hits 原顺序
3. chatCompletion 抛错 → 返回原 hits
4. LLM 返回非 JSON → 返回原 hits
5. LLM 返回空 order → 返回原 hits
6. 正常重排 order=[3,1,2] → hits 按 [h3,h1,h2] 顺序，score 保留原值
7. order 含越界编号 → 跳过越界，剩余按 order 排，未列入的追加末尾
8. hits > 20 → 前 20 喂 LLM，第 21+ 原样追加

端到端 LLM rerank 用例需要真 Chat Provider API Key，留给手动跑。

### 18.6 升级说明

v1.3.x 老用户升级：自动切换到 v1.3.2 行为；`Settings.enableRerank` 默认 undefined → 走代码默认 `true`（除非显式存了 false）。无 DB 迁移。Agent 模式成本敏感（每次 search_kb +1 次 LLM 调用）可在设置关 `enableRerank`。

### 18.7 v1.3.3 增量：rerank 启用时发全文

**问题**：v1.3.2 rerank 把正确 chunk 搜到了，但简单/agent 模式都走 read_chunk preview 流（v1.2.4）——chunk 全文 > 200 字时只发前 200 字 preview + `[TRUNCATED]` 标记，依赖 LLM 主动调 `read_chunk` 拿全文。v1.2.7 硬规则"列举/条款型必须先 read_chunk"对弱模型无约束力：`runSimpleChatWithTools` line 440 兜底「LLM 没调 tool（`toolCalls.length===0`）就直接用 preview 答」→ 截断错误答案。用户实测「第二章第十三条前后备案事项」：rerank 搜到正确 chunk（第十九-二十二条 400+ 字），LLM 收到 200 字 preview 没调 read_chunk，答"截断，暂不支持拉取"。

**修复**：rerank 启用时跳过 read_chunk preview 流，直接发 topK 全文。

| 模式 | 文件:函数 | 改动 |
| --- | --- | --- |
| 简单模式 | `ipc-handlers.ts::runSimpleChat` | `useToolFlow = useReadChunkTool && allHits.length > 0 && !enableRerank`——rerank 开 → 走 `runSimpleChatLegacy` 全文路径；rerank 关 → read_chunk preview 流 |
| Agent 模式 | `agent.ts::runAgent` search_kb 响应 | rerank 开 → 发 `filtered` 全文（`[#N filename]\n${h.text}`，不调 `formatChunkPreview`）；关 → preview 流；chunkMap 仍建 |

**设计取舍**：
- rerank 已精确挑出 topK 语义最相关 chunk，全文成本可接受（topK=8 约 6.4K token），不再依赖 LLM 主动调工具
- rerank 关闭时保持 read_chunk 流（无 rerank 时 chunk 质量参差，LLM 选择性读省 token 有价值）
- 无新增 Settings 字段（绑定 `enableRerank`）；chunkMap 仍建 + read_chunk 工具仍注册（兜底）

### 18.8 v1.3.5 检索性能优化

**问题**：用户实测简单模式慢。加 分步耗时日志后定位到 **rerank 33 秒**是主凶——deepseek-v4-flash 非流式 `chatCompletion`（`stream:false`）要等思考链+正文全生成完才一次性返回，10-33s 超时。

**修复（三件套）**：

1. **分步耗时日志**（`ipc-handlers.ts::runSimpleChat`）——`timing` 对象记录 plan/embed/search/rerank 各步 ms：
   ```
   [chat] [timing] session=... plan=0ms embed=2037ms search=665ms rerank=10016ms hits=5 "..."
   [chat] [timing] session=... total=15018ms (legacy)
   ```
   闲聊短路时打 `[chat] [timing] session=... skip-search（闲聊短路）`。定位慢在哪步，避免盲改。

2. **rerank/plan 改流式**——`reranker.ts::rerankHits` 和 `query-rewriter.ts::planWithLlm` 的 LLM 调用从 `chatCompletion`（非流式）改成 `chatStream`（流式），onDelta 传空（不流式给 UI，只要最终 content）。流式让服务端不用缓冲整个思考链，正文一出就能收，思考链 reasoning_content 边来边丢。**实测 rerank 33s→3.7s**；plan 4s 没降（4s 是真思考时间，流式省不了）。

3. **rerank 10s 超时兜底**（`reranker.ts` `RERANK_TIMEOUT_MS=10_000`）——`Promise.race` 包 chatStream，超时回退 RRF 原顺序（`return hits`），最差 10s 而不是 33s。

**reranker 诊断日志**：`[reranker] provider=... model=... candidates=N prompt=N字 response=N字 llm=Nms finish=...`

**关键认知**：流式加速 = 省掉服务端缓冲 + 避免思考链憋超时，**不是省"生成时间"**。rerank 33s→3.7s 立竿见影是因为之前 33s 大部分是非流式缓冲/超时浪费；plan 4s 是真思考，流式省不了。

### 18.9 v1.3.6 公开版版本号对齐

`package.json` + `APP_VERSION` 从 `1.3.0` 升至 `1.3.6`，与内部里程碑号对齐（不再维护"内部号 v1.3.x / 公开版 v1.3.0"两套）。`scripts/context-builder-selftest.js` 的 APP_VERSION 断言从硬编码 `'1.2.7'` 改为"非空字符串"，升版本不再挂。

## 16 → 17 章节迁移说明（v1.3.0）

本版本新增 §17 章节专门讲查询理解与重写管线。§15 query-resolver（v1.2.5 → v1.2.6）作为历史记录保留——v1.3.0 升级为更通用的管线（多 query + 扩展 + 分解），实现细节大改。Settings 加 3 字段（`enableQueryRewriter` / `queryRewriterProviderId` / `queryRewriterModel`），默认开。

