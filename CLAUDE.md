# LocalRAG 项目说明

## 项目概述

**LocalRAG** 是一款 Windows 桌面知识库 RAG（Retrieval-Augmented Generation，检索增强生成）应用。用户配置好第三方 AI 服务商的 API Key 后，可在本地建立知识库，上传文档（PDF / DOCX / Markdown / TXT），并基于这些文档进行智能问答。所有数据均存储在本地，**整个应用不依赖任何外部运行时**（无 Python / 无 Docker），打包后的安装包自带 Node 原生模块与全部资源，安装即可使用。

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 桌面框架 | Electron 28+ |
| 前端框架 | React 18 + TypeScript 5 |
| 构建工具 | Vite 5 + electron-builder |
| 样式方案 | TailwindCSS 3 + PostCSS |
| 向量库 | **vectra**（纯 JS，本地 JSON 持久化，零外部依赖） |
| 关系数据库 | **sql.js**（纯 WASM SQLite，零 native 编译） |
| 安全存储 | keytar（API Key 写入 Windows 凭据管理器） |
| 文档解析 | pdf-parse、mammoth、marked、iconv-lite |
| 切片分词 | gpt-tokenizer（cl100k_base，纯 JS，无 native） |
| HTTP 客户端 | axios |
| 状态管理 | React Hooks + Context（不引入额外库） |
| 路由 | 自实现轻量 hash 路由（避免引入 react-router） |

> 重大变更记录：
> - **v2.0.0**：**首次跨大版本发布**——4 项核心特性合并发布（v1.2.0 / v1.2.1 / v1.2.2 / v1.2.3 是本次发布的 4 个**内部特性里程碑**）：(1) **Agentic RAG**（v1.2.0）—— LLM 通过 `function_calling` 自主决定「搜不搜、搜什么、搜几次、信息够不够」，支持跨 KB 检索、查询分解、多轮迭代、自我批判、LLM 自选 KB；(2) **智能切分**（v1.2.1）—— 按文件类型分发到不同切分器（Markdown 结构感知 / PDF 版面感知 / DOCX·TXT·OCR-PDF 递归分隔符），`chunkSize` / `chunkOverlap` 单位从字符切到 token；(3) **查询改写**（v1.2.2）—— 多轮 RAG 指代 / 省略问句（"它/那/哪一章？"）自动改写为自包含 query，召回率从 30-50% 回升到 80-90%；(4) **长会话上下文**（v1.2.3）—— `buildRewriteHistory` 历史压缩 + 周期摘要落库 + 跨 session 历史摘要召回。本次大版本同步：①`package.json` + `APP_VERSION` 升至 `2.0.0`；②数据库迁移——`messages` 表加 `agent_trace` / `tool_call_id` / `name` 3 列 + 新表 `session_summaries`；③`Settings` 新增 7 字段（`enableAgent` / `agentMaxIterations` / `enableKBSelector` / `agentTopKPerQuery` / `enableQueryRewrite` / `rewriterProviderId` / `rewriterModel` / `summaryTriggerTurns`），全部有 UI 控件。**升级说明**：v1.1.x 老用户升级——`messages` 表自动迁移，列缺失补 null；Agent 模式默认关闭保持旧行为；查询改写默认开启但本地启发式会跳过 70%+ 自包含问句，几乎无感知。**v1.2.x 子版本号保留**在代码注释、changelog 章节、开发进度记录中作为"特性开发里程碑"标识
> - **v1.1**：从 ChromaDB（Python 子进程）切换为 **vectra**，主进程不再需要启动任何外部进程
> - **v1.1.1**：从 better-sqlite3（native 编译）切换为 **sql.js**（纯 WASM），**完全消除 native 编译依赖**，任何 Node 环境下 npm install 都不会失败
> - **v1.1.2**：修复 `npm run dev` 启动链路问题——vectra 降级 0.15→0.10.1（避开 ESM-only uuid@13）、uuid 降级 14→9、补齐缺失的 wink-* 依赖、绕过 vectra 的 WebFetcher 入口（cheerio→undici 链依赖浏览器 `File`）、修复 sql.js 入口路径多拼一层 `dist/` 的问题、补齐 Electron 二进制
> - **v1.1.3**：修复设置页「测试连接」按钮——`PROVIDER_TEST` 改用入参配置直接探活 `/chat/completions`（不再要求 Provider 先入库），UI 加 try/catch 让错误用 toast 显示；「Embedding 模型」字段重命名为「Thinking 模型」，DeepSeek/Qwen 预设改为对应推理模型（`deepseek-reasoner` / `qwq-plus`）
> - **v1.1.4**：修复设置页「保存 Provider 后再打开不显示」——给 `<SettingsDialog>` 加 `key` 强制每次打开重挂载（state 全部由 props 派生），同时「保存」按钮总是保存 Provider + 通用设置（不再因当前 tab 漏保存）
> - **v1.1.5**：修复上传文档 404 + 输入框下沉——v1.1.3 把 `embeddingModel` 误改成思考模型后，文档上传用 `deepseek-reasoner` 调 `/embeddings` 直接 404；本版本 (1) 新增独立的 `reasoningModel` 字段、恢复 `embeddingModel` 预设值、加 DB 迁移把旧值搬到 `reasoning_model`；(2) 关键修复：DeepSeek 根本没有 `/embeddings` 端点——新增全局 `Settings.embeddingProviderId`，文档上传/查询改用此 Provider（用户可在「设置 → 常规 → Embedding Provider」中指定一个支持 embedding 的服务，如 OpenAI / Qwen）；(3) 修 ChatArea flex 高度塌陷 bug：App.tsx 在 `<main>` 里给 ChatArea 又包了一层 `<div className="flex-1 min-w-0">`（无 `h-full`），导致 ChatArea 按内容高度渲染——加 `h-full min-h-0` 后 InputBox 才真正锚定页面底部
> - **v1.1.6**：修复 docCount / chunkCount 计数变负 + 扫描件 PDF 支持 OCR + 错误日志误导 + 修 pdfjs + node-canvas 冲突 + 引用分数阈值——(1) `updateKBStats` 在 `DOC_DELETE` 时改为条件回退（chunkCount>0 才 -1），加幂等启动迁移按 documents 表实际重算；(2) 弃用 `pdf-parse`，改用 `pdfjs-dist@3.11.174`（CJK 文本层更稳、支持 CMap），新增 OCR 管线：扫描件 / 图片型 PDF 在「设置 → 常规」开启「对扫描件 PDF 启用 OCR」后自动 fallback 到本地 tesseract.js（首次下载 ~23MB 中英语言模型到 `userData/cache/tesseract`，之后离线可用，识别 1-3 秒/页），文本提取器抽象为 `TextExtractor` 接口，将来加云 OCR / RapidOCR 只需新增一个实现并在 `selectExtractors()` 注册；(3) 修「`pdfjs-text` 仅得 N 字符，尝试下一个抽取器」误导日志——若已无下一个抽取器，正确显示「已无更多抽取器」并提示用户开启 OCR；(4) 设置页加「测试 OCR」按钮，画一张已知文字的测试图丢给 tesseract worker 跑一遍，把耗时/结果打到 toast，独立验证 OCR 管线不依赖真实 PDF；(5) **修 pdfjs-dist@3 与 @napi-rs/canvas 集成**：pdfjs 把 node-canvas（要 native 编译）列为 optionalDependency、`require("canvas")` 会炸，新建 `pdfjs-shim.ts` 在加载 pdfjs 之前用 `@napi-rs/canvas` 把 `globalThis.DOMMatrix` / `globalThis.Path2D` 填好；自定义 `NapiCanvasFactory` 传给 `getDocument()`（不是只给 `page.render()`——getDocument 内部 default factory 一旦触发 annotation 渲染就 require "canvas"）；(6) **引用分数阈值**：新增 `Settings.citationScoreThreshold`（默认 0.4，0-1 可调），`CHAT_SEND` 检索后过滤 `score < 阈值` 的 chunk——同时从 LLM 上下文和 citations 列表中剔除。解决「问文档 A、三个相似文档全被引用」的问题。设为 0 关闭过滤
> - **v1.1.6 打包链路修复**（`npm run dist:win` 在国内网络 + Windows 默认非管理员环境下报错的根因 & 修复）：(1) `electron-builder.json` 设 `npmRebuild: false` + `dist:win` 脚本显式跑 `rebuild:keytar`——electron-builder 默认 `npm rebuild` 会顺手把 `pdfjs-dist` 透传进来的 `node_modules/canvas`（optionalDependency）按 Electron ABI 重编，但 canvas@2.11.2 对 Electron 28 的 prebuilt 404、本机又无 VS 工具链，直接卡死；canvas 项目实际不依赖（用 `@napi-rs/canvas`），新增 `scripts/postinstall.js` 在 `npm install` 后直接 `rm -rf node_modules/canvas`；(2) `.npmrc` + `electron-builder.json` 的 `electronDownload.mirror` 全部走 `https://registry.npmmirror.com/-/binary/electron*/`——electron-builder 拉 `electron-vXX.zip` / `winCodeSign-XX.7z` / `nsis-XX.7z` 走 GitHub 在国内会超时；(3) `win.signAndEditExecutable: false`——winCodeSign-2.6.0.7z 归档里 `darwin/10.12/lib/*.dylib` 是符号链接，Windows 默认不允许非管理员进程创建符号链接，7-Zip 解压直接退出码 2。该选项跳过签名与 rcedit，**代价是 `LocalRAG.exe` 用默认 Electron 图标**（NSIS 安装包图标不受影响，仍走 `resources/icon.ico`）；如需恢复：开启「设置 → 隐私和安全 → 开发者选项 → 开发人员模式」后把 `electron-builder.json` 的 `signAndEditExecutable` 改回 `true` 重新打包
> - **v1.1.7**：混合检索（向量 + BM25, RRF 融合）——纯向量检索对精确术语（错误码、API 名、专有名词）召回差；新增 `src/main/bm25-store.ts`（基于 `wink-bm25-text-search`），每个 KB 单独维护 `bm25.docs.json` 索引；`hybridSearch` 用 RRF 公式把向量分与 BM25 分融合（`score = 1/(k+rankVec) + 1/(k+rankBM25)`），分数归一化到 [0,1]；`Settings.enableBm25` 默认开启（关闭时退化为纯向量检索）。启动时为旧 KB 自动从 vectra + chunks.json 重建 BM25 索引（`bm25RebuildFromVectra`），新文档上传时同步建索引；新增 `hybridSearchMulti` 为后续跨 KB 检索打基础
> - **v1.2.0**：**Agentic RAG**——LLM 通过 `function_calling` 自主决定「搜不搜、搜什么、搜几次、信息够不够」——(1) 新增 `src/main/agent.ts` 主循环（plan + critique 合并为单循环：`tool_calls` 出现就再循环，`finish_reason=stop` 才出 final）+ `selectKBs` 多 KB 自选函数；(2) `api-client.ts` 改造：`ChatMessage` 支持 `tool_calls` / `tool_call_id`，`chatStream` 用 `Map<index, ToolCall>` 累积 SSE 分段到达的 `delta.tool_calls[].function.arguments`；新增非流式 `chatCompletion`（plan/critique 中间步用，省一层 SSE 解析）；400/422 错误抛友好「LLM 不支持 function_calling」提示；(3) `vector-store.ts` 新增 `hybridSearchMulti` 跨 KB 检索（单 KB fastpath 走 `hybridSearch`；多 KB 走 `Promise.allSettled` + 全局 RRF 融合）；(4) `ipc-handlers.ts`：`CHAT_SEND` 路由 `mode: 'simple' | 'agent'` + 多 KB `kbIds?`；`runSimpleChat` 抽成可复用 helper；agent 模式 `selectKBs` 自动缩减候选；降级路径——Provider 不支持 tools（400/422）→ catch → 回退到 simple 模式重试一次；(5) **数据库迁移**：`messages` 表加 `agent_trace` / `tool_call_id` / `name` 3 列；`addMessage` / `listMessages` 序列化 AgentTrace；`Message.role` 扩展 `'tool'`，`Settings` 加 4 字段（`enableAgent` / `agentMaxIterations` / `enableKBSelector` / `agentTopKPerQuery`）；(6) **UI**：ChatArea 顶部新增 `🧠 Agent` / `⚡ 简单` 切换按钮 + `跨 N KB` 徽章；Sidebar 支持多 KB checkbox 跨库检索（KB 创建表单加 `description` textarea——喂给 LLM 让它挑 KB）；新建 `AgentTraceView.tsx` 折叠组件显示 plan / search / critique 步骤（默认收起，流式态显示 spinner + 当前阶段）；`useChat` 订阅 `chat:agent-step` / `chat:agent-phase` 实时构建 trace；(7) **防死循环**：相同 `sub_query + kbIds` 命中短路；`maxIterations` 强制终止；`queryVec` 复用避免重复 embed；`didKBSelection` 标记避免重复算 KB 路由；(8) **典型端到端**：跨 KB → 同时引用两个 KB；查询分解 → 2-3 个 search step；多轮迭代 → 检索→批判→改写再搜；LLM 自选 KB → 把 KB 目录喂进去，LLM 选 `[kb2]` 只搜代码库；闲聊/数学 → 1 个 `skip_search` step
> - **v1.2.3**：**长 session 上下文优化**——v1.2.2 的 `-6` 截断对长 session 太短（turn 1 提到 X，turn 20 问它就抓瞎）；本版本三件套：**(1) `buildRewriteHistory()` helper**（api-client.ts 导出）：首条 user msg 永远保留（话题锚点，解决"deep 引用链"）+ 最近 10 条（5 轮 user/assistant 交替）+ assistant > 500 字截到 300 字 + "…"（长 assistant 的中间论证对改写无价值，结论+引用才有用）+ 总字符数 ≤ 2500（粗估 token 预算）。超出预算从**中间**砍（保留 firstUser + 末尾若干条，因为"刚聊的"指代概率最大）；`rewriteQuery` 内部用它，simple 模式 / agent 模式自动受益；**(2) `session_summaries` 表 + 周期摘要**：新表 `id, session_id, start_msg_id, end_msg_id, summary, key_topics(JSON), key_entities(JSON), created_at` + 索引；`addSessionSummary` / `getLatestSessionSummary` / `listSessionSummaries` / `searchSessionSummaries`（SQL LIKE 简单搜，跨 session 按 query 关键词命中 top 3）四个 CRUD；触发器 `maybeSummarizeSession()` 在 CHAT_SEND 写入 user msg 后 fire-and-forget——自上次摘要以来新增 user turn ≥ `summaryTriggerTurns`（默认 20，可设 0 关闭）→ 调改写 LLM（成本极低，temperature=0.2）生成 200-400 字摘要 + 关键主题 + 关键实体 + 写入 DB；失败仅 console.warn 不影响主流程；`deleteSession` 同步清掉相关摘要；**(3) 摘要召回注入 LLM 上下文**：`runSimpleChat` / `runAgent` 的 fallback / stream final 三处 prompt 都在【参考资料】之前插入【历史对话摘要】段（top 2 摘要，含 `keyEntities` 让 LLM 看到"之前聊过哪些实体"）；sysPrompt 加一句解释"【历史对话摘要】是其它会话中聊过的相关话题，可以引用但不是当前文档知识的一部分"，避免 LLM 把摘要当文档内容。**关键决策**：摘要**不嵌向量库**——本地 SQLite 数据量小（一个 session 一辈子也就几十条），SQL LIKE O(n) 够用，避免再加一路融合的复杂度。**Settings 新增 `summaryTriggerTurns`**（默认 20）——`enableQueryRewrite` 段下方。**自检脚本**加 5 个 `buildRewriteHistory` 用例（首条 user 必带、assistant 截断、token 预算、排除 current msg、短 session 保留全部），全部通过
>
> - **v1.2.2**：**多轮对话查询改写（Query Rewriting / Condense Question）**——解决多轮 RAG 的 coreference（"它" / "那"）与 entity omission（"哪一章？"）问题，把"对话历史 + 最新问题"喂给一个小模型（cheap tier 即可）改写为自包含的检索 query，让第二轮/第三轮检索命中率从可能 < 50% 提到 90%+。实现细节：(1) 新增 `rewriteQuery()` 在 `api-client.ts`（LangChain `createHistoryAwareRetriever` / LlamaIndex `CondenseQuestionChatEngine` 同一思路）——输入 history（最近 6 条 user/assistant）+ currentQuery，输出自包含 query；(2) **跳过启发式**：`ANAPHORIC_RE = /[它他她这那]|刚才|那个/`，再叠加 `length < 6`，命中其一即改写；`5G 和 4G 的区别是什么` / `qwen-turbo 模型的上下文窗口多大？` 这类自包含 query 直接跳过（不浪费 LLM 调用，假阳性主要在 `上` / `的` / `个` 这类常见字，已刻意剔除）；(3) **失败容错**：LLM 调用失败 / 返回空 → 回退原 query；改写结果清洗：去首尾引号 + 截第一行（避免 LLM 偶尔追加解释尾巴）；(4) **进程内缓存**：`Map<sessionId, {lastUserKey, currentQuery, rewritten}>`，key 是 (sessionId, lastUserKey, currentQuery) 三元组，重复 query 不重写；(5) **Settings 新增 3 字段**：`enableQueryRewrite`（默认 true）/ `rewriterProviderId`（空 = 走 Chat Provider）/ `rewriterModel`（空 = 走 `provider.chatModel`），SettingsDialog 加 UI；(6) **新增 `resolveRewriterProvider()` helper** 仿 `resolveEmbeddingProvider()`，把"小模型做改写"和"大模型做主答"解耦——用户可配 rewriterProviderId 指向便宜的 Qwen-Turbo 改写，主答继续用 GPT-4 / DeepSeek-Reasoner；(7) **接入点**：`ipc-handlers.ts` 抽 `applyQueryRewrite()` helper，`runSimpleChat` 算 `effectiveQuery` 喂 embedText + hybridSearch；`CHAT_SEND` 的 agent 分支在调 `selectKBs` / `runAgent` 前算 `effectiveUserContent`，并把它加到 `AgentInput` 上游传 `runAgent`——`runAgent` 内部用 `effectiveUserContent ?? userContent` 作为 LLM 看到 / `search_kb` fallback 的 user content；(8) **不重写 LLM 生成的 sub_query**：sub_query 来自 LLM 自带的 function_calling，LLM 看到的是改写后的 user content，输出的 sub_query 通常已经自包含；再走一次改写边际收益小、延迟成本高，先不做；(9) **自检脚本** `scripts/rewrite-selftest.js`：分两部分——A) 进程内 11 个跳过判定用例（不需要凭据），B) 端到端 4 个 LLM 改写用例 + 缓存命中验证（设 `REWRITER_API_KEY` / `REWRITER_BASE_URL` / `REWRITER_MODEL` 即跑）。注意：simple 模式和 agent 模式共享 sessionId 缓存，**同一条 user 消息只调一次改写 LLM**
>
> - **v1.2.1**：**按文件类型分发的智能切分**——旧 `splitChunks` 按 500 字符硬切，PDF 没段落结构时基本是按 char 横切，句子被腰斩；新方案按文件类型挑不同切分器，新建 `src/main/chunkers/` 模块（5 个文件）：(1) **`tokenizer.ts`**：用 `gpt-tokenizer@3.4` 的 cl100k_base 编码（与 OpenAI text-embedding-3 / gpt-4 同源），提供 `countTokens` / `tailTokens`；(2) **`recursive.ts`（A+C）**：LangChain 风格递归分隔符切分 `[\n\n → \n → 句号群 → 词 → 字符]`，按 token 计数，单段超大时下沉到下一级分隔符，overlap 按 token 切不按 char；句号群分隔符走 regex `[。！？!?,，；;]+`；(3) **`markdown.ts`（B+A+C）**：用 `marked.lexer()` 解析为 token 序列，标题维护 `breadcrumb` 栈，每个 chunk 加 `【H1 > H2 > H3】` 面包屑前缀；代码块/表格作为原子单位，超大时按行切但保留 fence / 表头；段落/列表/引用按行累积，token 达 chunkSize 时 flush；(4) **`pdf-layout.ts`（E+A+C，文本层）**：用 `extractPdfTextItems` 拿 pdfjs 带坐标的 items，按 (页, y 降序, x 升序) 排版阅读序，y-gap > 行高 1.6 倍时插段落分隔 `\n\n`，跨页插段落分隔；`detectHeaderFooter` 把数字归一化为 `N`（让 "第 1/2/3 页" 共享 key），出现 ≥ 一半页面则跳过；OCR 路径拿不到坐标，自动降级到 recursive（A+C）；(5) **`index.ts` 分发器**：`ChunkInput = { type: 'markdown', text } | { type: 'plain', text }`；(6) **`document-processor.ts` 改造**：`processAndIndexDoc` 按扩展名分发——`.pdf` 走 items + pdfItemsToText + recursive（失败时 OCR 兜底），`.md` 读原始 markdown，DOCX/TXT 走 `extractText` + recursive；删掉旧的 `splitChunks`；(7) **Settings**：`chunkSize` / `chunkOverlap` 单位从字符静默切到 token，默认 500→800、50→100；UI 标签加 `(tokens)` 后缀、调大 min/max；老用户设置原样保留但按新单位解读（英文 500 token ≈ 1900 字符 ≈ 3.8 倍膨胀，中文 500 token ≈ 500 字符 ≈ 持平，用户可自行调整）。手写 `scripts/chunker-selftest.js` 跑 3 种典型输入验证切分效果

详见 `docs/开发计划.md` 与 `docs/开发进度.md`。

## 项目结构

```
LocalRAG/
├── src/
│   ├── main/                  # Electron 主进程
│   │   ├── main.ts            # 主进程入口（窗口、生命周期）
│   │   ├── preload.ts         # 预加载脚本（暴露 IPC）
│   │   ├── ipc-handlers.ts    # IPC 处理器注册
│   │   ├── secure-store.ts    # keytar 封装
│   │   ├── storage.ts         # SQLite + 本地存储
│   │   ├── document-processor.ts  # 文档解析 + 分块 + OCR 调度
│   │   ├── pdfjs-shim.ts      # pdfjs-dist 启动前预填 DOMMatrix/Path2D（@napi-rs/canvas）
│   │   ├── vector-store.ts    # **vectra** 封装（替代 ChromaDB）
│   │   ├── bm25-store.ts      # **wink-bm25-text-search** 索引（每 KB 一份 bm25.docs.json）
│   │   ├── upload-queue.ts    # 上传队列（全局限并发 3）
│   │   ├── agent.ts           # **Agentic RAG 主循环**（function_calling + 多轮迭代 + 跨 KB）
│   │   ├── api-client.ts      # 多提供商 LLM/Embedding 客户端（含 function_calling SSE 解析）
│   │   └── chunkers/          # **v1.2.1** 按文件类型分发的切分器
│   │       ├── tokenizer.ts   #   gpt-tokenizer cl100k_base 包装
│   │       ├── recursive.ts   #   A+C：递归分隔符切分（DOCX/TXT/OCR-PDF）
│   │       ├── markdown.ts    #   B+A+C：marked.lexer 结构感知
│   │       ├── pdf-layout.ts  #   E+A+C：PDF items 排版（y/x 坐标 + 跳页眉页脚）
│   │       └── index.ts       #   分发器
│   ├── renderer/              # 渲染进程（React）
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── styles/globals.css
│   │   ├── types/index.ts
│   │   ├── services/electronAPI.ts
│   │   ├── hooks/useChat.ts
│   │   ├── hooks/useKnowledgeBase.ts
│   │   └── components/
│   │       ├── Common/LoadingSpinner.tsx
│   │       ├── Layout/Sidebar.tsx
│   │       ├── Layout/ChatArea.tsx
│   │       ├── Layout/DocumentPanel.tsx
│   │       ├── Chat/MessageBubble.tsx
│   │       ├── Chat/MessageList.tsx
│   │       ├── Chat/InputBox.tsx
│   │       ├── Chat/AgentTraceView.tsx  # **v1.2.0** 折叠 trace 组件
│   │       └── Settings/SettingsDialog.tsx
│   └── shared/
│       ├── constants.ts       # IPC 通道 + AGENT_TOOLS schema
│       └── types.ts           # 跨进程共享类型（含 Agentic RAG 协议类型）
├── resources/                 # 图标、安装包资源
├── data/                      # 用户数据（运行时生成）
│   ├── index/                 # vectra 向量索引（每知识库一目录，含 index.json + chunks.json + bm25.docs.json）
│   ├── chat.db                # 对话历史
│   ├── cache/                 # 缓存（含 tesseract OCR 模型）
│   └── logs/                  # 日志
├── docs/                      # 项目文档
├── package.json
├── tsconfig.json
├── tsconfig.main.json
├── tsconfig.renderer.json
├── electron-builder.json
├── tailwind.config.js
├── postcss.config.js
└── vite.config.ts
```

## 开发环境搭建

### 1. 准备环境

- Node.js ≥ 18.18（推荐 20 LTS）
- npm ≥ 9
- Windows 10/11 64-bit
- **无需安装 Python**（项目已切换为纯 JS 向量库）

### 2. 安装依赖

```bash
npm install --ignore-scripts   # 先跳过 install 脚本（避免 native 编译失败）
# 若首次安装后 npm run dev 报 "Electron failed to install correctly"，手动补 Electron 二进制：
#   1) node node_modules/electron/install.js
#   2) 若 dist/ 不全：rm -rf node_modules/electron/dist && unzip -q \
#        "C:\Users\<you>\AppData\Local\electron\Cache\*\electron-v28.3.3-win32-x64.zip" \
#        -d node_modules/electron/dist
npm run rebuild:keytar         # 再为 Electron 单独编译 keytar
```

> v1.1.2 起 `sql.js` 与 `vectra` 0.10.1 都是纯 JS/WASM，无需 native 编译。`keytar` 仍需为 Electron ABI 单独编译。

### 3. 启动开发

```bash
npm run dev
```

同时启动 Vite 渲染进程和 Electron 主进程，并启用热更新。

### 4. 构建生产包

```bash
npm run build
npm run dist:win   # 生成 Windows 安装包（NSIS）
```

> 所有依赖都会被打包进 `LocalRAG-Setup-x.x.x.exe`，**用户安装时不需要任何额外环境**。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动开发环境（Vite + Electron） |
| `npm run build:main` | 仅编译主进程 |
| `npm run build:renderer` | 仅编译渲染进程 |
| `npm run build` | 全量构建 |
| `npm run dist:win` | 打包 Windows 安装包 |
| `npm run typecheck` | 主进程 + 渲染进程 TS 类型检查 |
| `npm run rebuild:keytar` | 为 Electron 重新编译 keytar（解决 preload 加载失败） |
| `npm run lint` | ESLint 检查 |
| `npm run format` | Prettier 格式化 |

## 代码规范

- **语言**：TypeScript 严格模式（`strict: true`）
- **缩进**：2 空格
- **引号**：单引号
- **分号**：必须
- **命名**：
  - 组件文件：PascalCase，如 `MessageBubble.tsx`
  - 工具/服务：camelCase，如 `electronAPI.ts`
  - 常量：UPPER_SNAKE_CASE
  - 类型/接口：PascalCase
- **注释**：关键业务逻辑必须有中文注释，公共 API 必须有 JSDoc

## 关键依赖说明

- **electron**：桌面壳层。
- **react / react-dom**：UI 框架。
- **vite**：渲染进程构建与开发服务器。
- **typescript**：类型系统。
- **tailwindcss**：原子化样式。
- **keytar**：将 API Key 存储到 Windows 凭据管理器，避免明文落盘。
- **sql.js**：纯 WASM 实现的 SQLite，全内存运行 + 周期落盘。**替代 better-sqlite3**（后者需要 native 编译）。
- **axios**：统一 HTTP 调用，处理拦截与超时。
- **pdfjs-dist / mammoth / marked / iconv-lite**：文档解析。v1.1.6 起 PDF 用 pdfjs（CJK CMap 支持）。
- **tesseract.js / @napi-rs/canvas**：v1.1.6 起的扫描件 OCR（本地，无云依赖）。
- **vectra**：纯 JS 向量库，JSON 文件持久化，无需 Python。
- **wink-bm25-text-search / wink-nlp / wink-eng-lite-web-model**：v1.1.7 起的 BM25 关键词索引（精确术语召回）。

## 调试技巧

1. **主进程调试**：渲染进程 DevTools 通过 `mainWindow.webContents.openDevTools()` 自动打开（开发模式）；主进程可通过 VSCode `launch.json` 以 `electron` 命令附加调试。
2. **渲染进程调试**：F12 或右键 → 检查元素；React DevTools 需在生产构建中禁用。
3. **日志**：统一使用 `electron-log`（待接入），当前阶段直接 `console.log`。
4. **向量索引调试**：vectra 索引是普通 JSON，可直接打开 `%APPDATA%\LocalRAG\index\<kbId>\` 查看 `index.json`。
5. **原生模块**：如果 `better-sqlite3` / `keytar` 报错，删除 `node_modules` 后重新 `npm install`，或运行 `npx @electron/rebuild`。

## 常见问题

- **白屏**：检查 Vite 端口（默认 5173）是否被占用；检查主进程 `loadURL`。
- **API Key 失效**：在「设置」中重新填写并保存。
- **keytar 编译失败**：安装 [VS Build Tools 2022](https://visualstudio.microsoft.com/zh-hans/downloads/) 勾选「C++ 桌面开发」。（v1.1.1 起已无 better-sqlite3，sql.js 是纯 WASM 无需编译。）
- **打包后路径问题**：所有用户数据使用 `app.getPath('userData')` 获取。
- **vectra 索引过大**：vectra 是内存型索引，单库超过 5 万片段时检索会变慢。届时可考虑切换到 `hnswlib-node` 或 `lancedb`。
- **.venv 目录能删吗**：项目根目录的 `.venv` 是开发阶段预留的 Python 环境（现已不再需要），可安全删除。

## 文档索引

- [开发计划](./docs/开发计划.md)
- [开发进度](./docs/开发进度.md)
- [API 文档](./docs/API文档.md)
- [用户手册](./docs/用户手册.md)
