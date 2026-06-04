# LocalRAG API 文档

> 本文档定义**渲染进程 → 主进程**的 IPC 接口。所有接口通过 `window.api` 暴露（在 `preload.ts` 中通过 `contextBridge.exposeInMainWorld` 注册）。

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
  stage: 'parsing' | 'embedding' | 'storing' | 'done';
  percent: number; // 0-100
  message?: string;
}
```

### `doc.delete(docId)`
- **参数**：`docId: string`
- **返回**：`void`

### `doc.reindex(docId)`
- **参数**：`docId: string`
- **返回**：`void`

## 5. 对话 API（`chat`）

### `chat.send(payload)`
- **参数**：
```ts
interface ChatSendPayload {
  kbId: string;
  sessionId?: string; // 不传则创建新会话
  content: string;
  providerId: string; // 关联到 provider.id
  model: string;
  temperature?: number;
  topK?: number; // 检索 top-k，默认 5
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
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations?: { docId: string; filename: string; chunk: string; score: number }[];
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
  embeddingModel: string;
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

### `provider.test(payload)`
- **参数**：`{ id: string; apiKey?: string }`
- **返回**：`{ ok: boolean; latencyMs: number; message: string }`

## 7. 设置 API（`setting`）

### `setting.getAll()`
- **返回**：`Settings`
```ts
interface Settings {
  theme: 'light' | 'dark' | 'system';
  defaultProviderId?: string;
  defaultModel?: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
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

| 通道 | 数据 |
| --- | --- |
| `doc:progress` | `DocProgressEvent` |
| `chat:token` | `ChatTokenEvent` |
| `chat:citation` | `Citation` 一次性发出 |
| `chat:done` | `{ sessionId, messageId }` |
| `toast` | `{ level: 'info' \| 'success' \| 'warn' \| 'error'; text: string }` |

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
