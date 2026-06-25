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
> - **v1.2.4**：**智能 context 截断 + read_chunk 工具**——清理 v1.2.2 query rewriting 过度设计。两件套：**(1) `src/main/context-builder.ts::buildHistory(opts)`**——按模型 context window 智能截断：能塞下就全塞（DeepSeek-V3 64K 约 40 turn 内不触发），超了则 firstUser 必带 + 中间调 LLM 压缩 + 末尾尽量多。替代 v1.2.3 的 `slice(-8)` 硬切和 v1.2.2 的「近 8 条改写上下文」；**(2) `READ_CHUNK_TOOL` + read_chunk 工具流**——检索后**不**把 topK 全文发到 LLM，而是发"索引 + preview"（每条 200 字），LLM 按需 `read_chunk(chunk_id)` 拉完整内容。简单模式（`Settings.enableReadChunkTool`）和 Agent 模式（AGENT_TOOLS 永远包含 read_chunk）统一——节省 ~60-80% chunk 相关 token。删除 v1.2.2 query rewriting：`rewriteQuery` / `buildRewriteHistory` / `ANAPHORIC_RE` / `rewriteCache` 全部移除，`Settings` 的 `enableQueryRewrite` / `rewriterProviderId` / `rewriterModel` 3 字段**保留**（兼容老 DB JSON）。`document-processor.ts` 的 `resolveRewriterProvider` 重命名为 `resolveSummaryProvider`（摘要 LLM 复用 Chat Provider/模型，不再支持独立指定）。`runSimpleChat` 重构为 read_chunk 工具流（带 `runSimpleChatLegacy` 退路——Provider 不支持 tools / `enableReadChunkTool=false` 时退化到 topK 全文）。**自检脚本** `scripts/context-builder-selftest.js` 20 个用例（短 session 全塞 / 超长 session 截断 / 极端 takeFromTail 兜底 / read_chunk schema / AGENT_TOOLS 包含 / APP_VERSION）全部通过
> - **v1.2.5**：**检索 query 消解（修复 v1.2.4 检索盲点）**——v1.2.4 把"指代 / 实体补全"完全寄托给 LLM（"LLM 看到全 history 时消解是无成本的"），但**只对 LLM 有效，对检索无效**——`embedText` + `hybridSearch` 发生在 LLM 看到 history 之前，拿的是裸 query（"第三条是什么" / "这是哪个文件的内容？"），embedding 和 BM25 不知道历史。后果：(1) "第三条是什么" 检索返回全 KB 里所有出现"第三条"的文档条款（法律援助 / 城乡规划 / 科技 / 红旗渠），LLM 即便看到 history 知道指代前文也救不回已被污染的 context；(2) "原文 + 这是哪个文件的内容？" query 把"哪个文件"问句也带进 embedding，把 Article 3 这种精确匹配的 chunk 顶出 topK，LLM 拿空 / 残 context 后被迫用外部知识幻觉出《中华人民共和国村民委员会组织法》。本版本修复：**(1) 新建 `src/main/query-resolver.ts`**——三件套：`stripQuestionTail`（cheap regex 剥除"这是哪个文件的内容？"/"这是哪部法规？"/"出自哪里？"等问句尾巴，前缀分隔符只用 `[；;\s]*` 不含 。避免误吞句末标点）+ `isAnaphoric`（cheap regex 命中"第N条/这/那/它/哪条/上条/刚才"等指代）+ `condenseWithLlm`（anaphoric 命中时调一次小模型把 history 末条 user msg + current 凝成 self-contained 检索 query，结果**只用于 embedText + hybridSearch**，**不进 LLM context**——LLM 反正自己看 history 也能消解）。(2) **进程内缓存**：`Map<key, ResolvedQuery>`，key = `(sessionId, currentUserMsgId, currentQuery)`——含 msgId 避免"同 query 不同 anchor 拿到陈旧 resolved"。(3) **`runSimpleChat` 接入**：`ipc-handlers.ts:runSimpleChat` 检索前 `await resolveSearchQuery(...)`，把 `resolved.searchQuery` 喂给 `embedText` + `hybridSearch`；LLM 端 user prompt 仍用 `payload.content`（LLM 反正看全 history 自行消解）。Agent 模式不动——LLM 自己调 `search_kb` 输出 sub_query，指代自然消解。(4) **regex 注意事项**：multi-char + ? 的组合（`法规?文件?`、`的?内容?`）会触发 JS regex 引擎的 backtracking bug——多字符 `?` 消费 0 或 N 字符，遇到「X-Y-Z」跨不过，统一用 `(a|b|c)` 显式二选一 + `()` 显式包裹 optional group。(5) **自检脚本** `scripts/query-resolver-selftest.js` 32 个用例（stripQuestionTail 6 / isAnaphoric 10 / resolveSearchQuery 16：tail-strip 命中、anaphoric + 无 LLM key 走 fallback、自包含 passthrough、cache hit、cache key 隔离）全部通过
>
> - **v1.2.6**：**取消 query-resolver 的 regex 门控（always-LLM 消解）+ 补 agent 模式 sub_query 自包含 prompt**——v1.2.5 的 `isAnaphoric` 是 cheap cost gate，但**分类问题天然不该用 regex**——开放表达永远盖不全（用户实测：`第几章？` / `原文呢` / `适用范围` / `处罚标准呢` / `对比一下` / `举个例子` / `它的限流策略` / `为什么` / `详细说说` 等大量真实指代都漏），漏的就被 `passthrough` 原 query 直送 `hybridSearch`，embedding/BM25 拿到裸 query 召回必错。本版本双管齐下：**(1) 简单模式：删 regex 门控，session 有 history 就总是调 LLM 消解**。`query-resolver.ts` 移除 `TAIL_FILE_QUESTION_PATTERNS` / `stripQuestionTail` / `ANAPHORIC_STARTERS` / `isAnaphoric` 四件套，`steps` 类型从 4 元（`cache-hit | passthrough | llm-call | llm-condense | tail-strip`）简化为 4 元（`cache-hit | passthrough | llm-call | llm-condense`），主流程三步走——`cacheKey` 命中走 `cache-hit`；首轮（除 current 外无 user/assistant）走 `passthrough`；有 history 总是走 `llm-call`（缺 key / LLM 抛错 / 返回空 / 返回同 query 全部回退原文）。`condenseWithLlm` 拿"最近 6 条 user/assistant"（≈3 轮）作为 anchor（v1.2.5 是"末条 user msg"——assistant 答案里的实体名抓不到，本版本扩到 6 条让 LLM 看到前一轮 assistant 答案里的条例名/文件名/章节号）；清洗逻辑保留去首尾引号 + 截第一行。**(2) Agent 模式：补 prompt 明确要求 sub_query 自包含**。`AGENT_SYSTEM_PROMPT` 加 `⚠ 调 search_kb 之前：sub_query 必须自包含` 警示段 + 3 个正反例（"上文聊《北京市殡葬管理条例》第十四条 → 第几章？ → sub_query=北京市殡葬管理条例 第十四条"、"OpenAI API → 它的限流策略呢 → OpenAI API 限流策略"、"5G 和 4G 的区别 → 原样使用"）；`AGENT_TOOLS` 的 `search_kb.sub_query.description` 同步更新，加 **`**必须自包含**`** 标记 + 同样 3 个反例（`第几章？` / `为什么？` / `它的限流是多少`），让 LLM 决定 `sub_query` 时把"分类任务天然解"这件事显式写进约束。**(3) 消解结果只用于检索侧**——`resolved.searchQuery` 喂 `embedText` + `hybridSearch`；LLM 端 user prompt 仍用 `payload.content`（LLM 反正自己看全 history 也能消解，进 LLM context 反而会污染"用户原话"）。**(4) 自检脚本** `scripts/query-resolver-selftest.js` 重写为 5 组 13 个用例（删 `isAnaphoric` / `stripQuestionTail` 单元测试，只覆盖 `resolveSearchQuery` 快路径：首轮 passthrough / 有 history 缺 key fallback / cache hit / cache key 隔离 / 空白 history 当首轮）。端到端 LLM 消解用例需要真 Chat Provider API Key，留给手动跑。**关键设计取舍**：always-LLM 的代价是每条 multi-turn user msg 多 1 次 chatCompletion（≈200-300 token 小模型，温度 0.1），与 v1.2.2 的 query rewriting 同档；但消解正确性从"覆盖率 < 50%"（regex 漏掉大量真实指代）回到"100%"（LLM 自行判断），且用户实测的核心场景（"第几章？" / "它的限流" / "原文呢"）全部能命中正确 KB
> - **v1.3.0**：**查询理解与重写管线（query-rewriter）**——v1.2.6 的 `query-resolver.ts` 只解决"指代→实体"一种情况，用户实测反馈"检索时大模型不理解用户语义，很多无效的提示词"。根因：检索侧的 query 质量差（口语化/模糊/短/多意图），embedding + BM25 拿裸 query 召回必坏。本版本把"单点指代消解"升级为完整管线：(1) **新建 `src/main/query-rewriter.ts`**——主入口 `planSearchQuery(opts)` 返回 `QueryPlan { searchQueries: string[1-3], intent, expandedTerms, needsHighRecall, steps, usedLlm }`，用小 LLM（temperature=0.1）一次性产出 JSON plan：自包含原样 / 指代补全 / 模糊扩展 / 多意图分解。架构沿用 v1.2.6 三步走（cacheKey 命中 → 首轮 passthrough → 有 history 调 LLM），失败兜底链同 v1.2.6（缺 key / 抛错 / JSON 解析失败 / 返回空 / 返回同 query 全部回退原 query）。(2) **`runSimpleChat` 改造**（`ipc-handlers.ts`）——把 `resolveSearchQuery` 替换为 `planSearchQuery`；多 query 并发 `embedText` 后用新函数 `hybridSearchMultiQuery`（`vector-store.ts`）走 RRF 全局融合（每路 fetchK=`max(50, 8×topK)`，与 `hybridSearchMulti` 跨 KB 同构）。`enableQueryRewriter=false` 时退化为 v1.2.6 行为（单条原 query）。(3) **`runAgent` 改造**（`agent.ts`）——循环开始前调一次 `planSearchQuery`，把 plan.searchQueries 注入到 system prompt 的"⚠ sub_query 必须自包含"段下面作为「已改写候选 query（供参考）」，LLM 仍可自主决定 sub_query（保持自主权），但有了更好的起点。(4) **`Settings` 加 3 字段**（`shared/types.ts` + `storage.ts::DEFAULT_SETTINGS`）：`enableQueryRewriter`（默认 true）/ `queryRewriterProviderId`（空 = 走 Chat Provider）/ `queryRewriterModel`（空 = 走 Chat 模型），UI 在「设置 → 常规」general tab 加 checkbox + Provider select + Model text input。(5) **替换 query-resolver**——`src/main/query-resolver.ts` 和 `scripts/query-resolver-selftest.js` 已删除；v1.2.5 / v1.2.6 段保留为历史记录。**(6) 自检脚本** `scripts/query-rewriter-selftest.js` 13 组 34 个用例（passthrough / 缺 key fallback / LLM 抛错 fallback / JSON 解析失败 fallback / 空 searchQueries fallback / 截断到 3 条 / 去重 / 过滤非 string / 非标准 intent fallback 'other' / cache hit / cache key 隔离 / 空白 history 当首轮）全部通过。**关键设计取舍**：**(a) 替换而非叠加 query-resolver**——query-rewriter 的 `searchQueries[0]` 已包含指代消解能力，叠加会导致每轮 2 次 LLM 调用 + 收益重叠；**(b) 多 query 融合而非单 query 拼接**——RRF 融合让 LLM 改写结果不一致时仍能兜底，"q1 OR q2 OR q3" 字符串拼接会让 BM25 稀有词淹没；**(c) Agent 模式预计算 plan 但不强制使用**——LLM 仍可自调 search_kb，plan 仅作"参考起点"；**(d) 不做 HyDE**——成本高（200+ 字生成），LLM 幻觉会污染 embedding，留给未来评估
>
> - **v1.3.1**：**query-rewriter 入口加 stripNoise 预处理（剥无效词句）**——用户反馈"用户输入有很多无效的词句"，但 v1.3.0 的 `planSearchQuery` 首轮（无 history）走 passthrough 原样送检索，"请问一下，麻烦问下 OpenAI 的限流策略是什么？"这类带寒暄的 query 原样进 embedding/BM25，寒暄词稀释向量、干扰关键词命中；多轮 LLM 改写 prompt 也没显式要求剥无效词。本版本轻量改（纯 regex、零 LLM 成本）：**(1) 新增 `stripNoise(query)`**（`query-rewriter.ts`）——剥寒暄开头（`请问一下/麻烦问下/我想了解一下/帮我查一下/您好/你好/哈喽/嗨` 等 20+ 前缀，长前缀在 alternation 里排前防短前缀先吃）+ 闲聊尾巴（`谢谢/感谢/麻烦了/辛苦了/thanks` 等）+ 句末疑问语气词「呢」；剥后为空（用户只输入寒暄）退回原文，不送空 query。**(2) 接线到 `planSearchQuery` 入口**——`originalQuery = stripNoise(opts.currentQuery.trim())`，首轮 passthrough 与多轮 LLM 改写都先过一遍。**(3) 改写 prompt 加规则 0**——`planWithLlm` 的 systemPrompt 显式要求 LLM 先剥离寒暄/尾巴/句末"呢"再做指代/扩展/分解判断。**设计取舍（保守防误伤）**：只剥明确无检索价值的成分，不动指代词（它/那/这——留给多轮 LLM 消解）与实体名；句末语气词只剥「呢」（几乎不可能是术语/实体名合法结尾），不剥「啊/呀/吧」等误伤风险高的。**自检脚本** `scripts/query-rewriter-selftest.js` 加测 1b 4 场景 6 断言（剥寒暄开头 / 剥闲聊尾巴 / 剥句末"呢" / 只输入寒暄退回原文），全部通过（40/40）
>
> - **v1.3.2**：**检索后 LLM rerank（重排候选）**——v1.2.8/v1.2.9 调了一轮 BM25/RRF 参数（topK 5→8、fetchK=max(50,10×topK)、RRF_K 60→30、b 0.75→0.5）但没根治「正确答案被排到 topK 外」。用户实测复现「北京历史文化名城保护条例 第二章第十三条前后备案事项」：BM25 把正确答案（chunk 7 含第十九-二十二条）排到 rank 12，8 个整章 chunk 的 BM25 分数挤在 10% 区间内（29.97/27.04/26.81/...），区分度极低；RRF 融合后答案落到 rank 6 边缘，topK 切掉，LLM 拿到整章总则 chunk 幻觉出"第四章只有第三十四条"。根因：BM25 中文 unigram 分词让条例名前缀（每章节 chunk 都以「北京历史文化名城保护条例 第N章」开头）稀释 IDF，继续调参边际递减。本版本用 LLM 语义重排（CLAUDE.md v1.2.8 已预留为"终极方案"）：**(1) 新建 `src/main/reranker.ts`**——主入口 `rerankHits(query, hits, settings)`，复用 `resolveSummaryProvider` + `chatCompletion`（走 Chat Provider，无新依赖）；候选上限 20（防 prompt 爆），≤1 hit 直接返回不调 LLM；prompt 让 LLM 输出 `{"order":[编号降序]}`，按 order 重排，未列入的 hit 按 RRF 原顺序追加末尾；**只重排顺序，不替换 score**（RRF norm score 保留，citationScoreThreshold/citation 零侵入）；降级链（缺 key / 抛错 / 非 JSON / 空 order / order 非整数数组）全部返回原 hits 原顺序 + console.warn。**(2) 简单模式接入**（`ipc-handlers.ts::runSimpleChat`）——`fetchTopK = enableRerank ? Math.max(topK, 20) : topK` 扩召回（不改 vector-store 签名，调用方传大 topK），检索后 `rerankHits` → `slice(topK)` → threshold 过滤；rerank 先于 threshold 让 LLM 在更大候选池挑。**(3) Agent 模式接入**（`agent.ts::runAgent` search_kb 段）——同款扩召回 + rerank + slice + threshold；`AgentInput` 加 `enableRerank?`；CHAT_SEND agent 分支传 `enableRerank`。**(4) Settings 加 `enableRerank`**（默认 true）+ SettingsDialog general tab checkbox（照抄 enableQueryRewriter 样式）。**自检脚本** `scripts/reranker-selftest.js` 8 组 18 用例（≤1 不调 / 缺 key / 抛错 / 非 JSON / 空 order / 正常重排 / 越界跳过 / >20 截断）全部通过。**关键设计取舍**：① 不改 vector-store 检索签名（扩召回靠调用方传大 topK）；② 不替换 score（rerank 只重排，threshold/citation 零侵入）；③ 不加独立 rerank Provider/Model 配置（走 Chat Provider，同 summary/rewriter，保持轻量）；④ 不做 cross-encoder（需本地模型，违背零 native 依赖）；⑤ 不改切片策略（按条切是另一条路，影响全库，留后续）
>
> - **v1.3.3**：**rerank 启用时直接发全文，修复 LLM 不调 read_chunk 导致截断**——v1.3.2 rerank 把正确 chunk 精确搜到了，但简单/agent 模式都走 read_chunk preview 流（v1.2.4）：chunk 全文 > 200 字时只发前 200 字 preview + `[TRUNCATED]` 标记，依赖 LLM 主动调 `read_chunk` 拿全文。v1.2.7 加硬规则"列举/条款型必须先 read_chunk"，但**弱模型不遵守**——`runSimpleChatWithTools` line 440 兜底「LLM 没调 tool（`toolCalls.length===0`）就直接用 preview 答」导致截断错误答案（LLM 还会编"当前环境暂不支持拉取完整文档"借口）。用户实测「第二章第十三条前后备案事项」：rerank 搜到正确 chunk（第十九-二十二条全文 400+ 字），但 LLM 收到 200 字 preview（只含第十九条 + 第二十条(一)），没调 read_chunk，答出截断内容——**搜到了却没用上**。本版本：rerank 启用时跳过 read_chunk preview 流，直接发 topK 全文。**(1) 简单模式**（`ipc-handlers.ts::runSimpleChat`）——`useToolFlow` 加 `&& !enableRerank`，rerank 开 → 走 `runSimpleChatLegacy` 全文路径（发 `allHits` 全文）；**(2) Agent 模式**（`agent.ts::runAgent` search_kb 响应）——rerank 开时发 `filtered` 全文（`[#N filename]\n${h.text}`，不调 `formatChunkPreview`），关时保持 preview 流；chunkMap 仍建（read_chunk 兜底）。rerank 已精确挑出语义最相关 chunk，全文成本可接受（topK=8 约 6.4K token），且不再依赖 LLM 主动调工具。rerank 关闭时保持 read_chunk 流（无 rerank 时 chunk 质量参差，LLM 选择性读省 token 有价值）。**无新增 Settings 字段**（绑定 `enableRerank`）。build + typecheck + reranker-selftest 18/18 + query-rewriter-selftest 40/40 回归通过
>
> - **v1.3.4**：**闲聊短路 + 会话等待串扰修复**——两件事：**(1) 闲聊短路**：用户反馈"你好"这种闲聊也走完整检索（query-rewriter + embed + hybridSearch + rerank + 主答），白白多 2-3 次 LLM/API 调用。`planSearchQuery` 加 `skipSearch` 字段——首轮用 cheap regex `CHITCHAT_RE`（`query-rewriter.ts`）检测纯问候（"你好/谢谢/在吗/嗨"等 ≤8 字、剥 Noise 后整句就是问候，极保守不命中含疑问/实义的真问题，首轮本来就不调 LLM 所以 regex 零成本）；多轮 `planWithLlm` 的 prompt 加规则 6 让 LLM 判断"是否需要检索"返回 `skipSearch`，prompt 明确"拿不准一律 false（宁可检索别漏答）"。失败兜底（LLM 抛错/非 JSON/未返回 skipSearch）→ `skipSearch=false`。`runSimpleChat`（`ipc-handlers.ts`）检索段整个 `try` 块包进 `if (!skipSearch)`，闲聊时 allHits/citations/contextText 保持空直接走 chatStream 主答——省 1-3 次 embed API + 1 次 hybridSearch + 1 次 rerank LLM。"你好"现在只走 1 次主答。**(2) 会话等待串扰修复**（`src/renderer/hooks/useChat.ts`）：`streaming` 是 useChat 局部 state，切会话不重挂载；`activeSession` 切换时只重载 messages 没重置 streaming → 切走正在流式的会话后新会话继承 `streaming=true` → 输入框禁用 + 显示等待气泡（"其他对话也显示等待"）。加 `streamingSessionRef` 跟踪当前流式 sessionId：send 时设、done/catch 时清；`activeSession` 切换时若切到的不是正在流式的会话→重置 streaming/streamingText/streamingCitations/streamingTrace/streamingPhase（新会话干净），切回正在流式的原会话不动（事件订阅按 sessionId 过滤，token/done 仍续上不丢内容）。**自检**：query-rewriter-selftest 加测 1c/1d/1e 共 12 用例（首轮 regex 检测 5 场景 + 多轮 LLM 判断 + 未返回 skipSearch 默认 false），52/52 通过
>
> - **v1.3.5**：**检索性能优化（分步耗时日志 + rerank/plan 改流式 + rerank 超时兜底）**——用户实测简单模式慢，分步耗时日志定位到 **rerank 33 秒**是主凶（deepseek-v4-flash 非流式 `chatCompletion` 要等思考链+正文全生成完才返回，10-33s 超时）。三件套：**(1) 分步耗时日志**（`ipc-handlers.ts::runSimpleChat`）——`timing` 对象记录 plan/embed/search/rerank 各步 ms，检索段结束打 `[chat] [timing] session=... plan=Xms embed=Xms search=Xms rerank=Xms hits=N`，主答完成打 `total=Xms`，闲聊短路打 `skip-search`。定位慢在哪步，避免盲改。**(2) rerank/plan 改流式**——`reranker.ts::rerankHits` 和 `query-rewriter.ts::planWithLlm` 的 LLM 调用从 `chatCompletion`（非流式 `stream:false`）改成 `chatStream`（流式 `stream:true`），onDelta 传空（不流式给 UI，只要最终 content）。流式让服务端不用缓冲整个思考链，正文一出就能收，思考链 reasoning_content 边来边丢。**实测 rerank 33s→3.7s**（之前 33s 大部分是非流式缓冲/超时浪费，不是真在思考 33s）；plan 4s 没降（4s 是真思考时间，流式省不了，但至少不超时）。**(3) rerank 10s 超时兜底**（`reranker.ts` `RERANK_TIMEOUT_MS=10_000`）——`Promise.race` 包 chatStream，超时回退 RRF 原顺序（`return hits`），最差 10s 而不是 33s。reranker.ts 加诊断日志 `[reranker] provider=... model=... candidates=N prompt=N字 response=N字 llm=Nms finish=...`。自检脚本 mock 从 `chatCompletion` 改 `chatStream`（query-rewriter-selftest 52/52 + reranker-selftest 18/18 回归）。**关键认知**：流式加速 = 省掉服务端缓冲 + 避免思考链憋超时，不是省"生成时间"；rerank 33s→3.7s 立竿见影是因为之前大部分是缓冲浪费，plan 4s 是真思考流式省不了
>
> - **v1.3.6**：**公开版版本号对齐**——`package.json` + `APP_VERSION` 从 `1.3.0` 升至 `1.3.6`，与内部里程碑号对齐（不再维护"内部号 v1.3.x / 公开版 v1.3.0"两套）。本次会话累积的 v1.3.1（stripNoise）/ v1.3.2（rerank）/ v1.3.3（rerank 发全文）/ v1.3.4（闲聊短路+会话串扰）/ v1.3.5（性能优化）一并随 v1.3.6 公开版发布。`context-builder-selftest.js` 的 APP_VERSION 断言从硬编码 `'1.2.7'` 改为"非空字符串"，升版本不再挂
>
> - **v1.2.8**：**修复混合检索把正确答案挤出 topK 的 bug**——用户实测「北京历史文化名城保护条例」：BM25 把正确答案（第四章 chunk 7 含 第十九-二十二条）排到第 12 名，前 8 个长整章 chunk（第一章/第二章/第三章/第六章/第四章 chunk 8/11）BM25 分都比它高；RRF 融合后正确答案在第 6 名（norm score 0.89），topK=5 卡掉；LLM 看到第四章 chunk 11（含 第三十四条）就当成"第四章"的代表，幻觉出"第四章只有第三十四条"。三个机制叠加放大问题：**(1) BM25 length norm 力度不够**（wink-bm25-text-search 默认 b=0.75）——8 个长整章 chunk 因内容多→tf 命中 query 关键词次数多→BM25 分高，短子 chunk（答案）分低被压到第 12；**(2) fetchK=4×topK=20 不够**——RRF 融合候选数窄，BM25 排名 12 的 chunk 虽在候选内但 RRF 贡献 `1/(60+12)=0.0139` 不够与前 5 名抗衡；**(3) RRF_K=60 让低 rank 衰减过猛**——rank 1 vs rank 12 的 RRF 贡献差距只有 1.18×，前 8 名互相加成后答案仍被顶到第 6。本版本四件套（**纯参数调整，无新增依赖**）：**(1) Settings.topK 默认 5→8**（`src/main/storage.ts:26`）——给 LLM 多 3 个 chunk 配额，rank 6 的答案直接进 topK；UI 默认值同步（`SettingsDialog.tsx:445`）；**(2) fetchK = max(50, 10×topK)**（`vector-store.ts:177` `hybridSearch` + `:285` `hybridSearchMulti` 用 `max(50, 8×topK)`）——保证 BM25/vec 召回 ≥ 50 候选，低 rank chunk 也有机会在 RRF 融合里反超；**(3) RRF_K 60→30**（`vector-store.ts:188` + `:291`）——让低 rank 相对提升，rank 1 vs rank 12 差距从 1.18× → 1.36×；NORMALIZER 公式 `(RRF_K+1)/2` 自动从 30.5 → 15.5（数学上保持一致——0.5 仍代表 "top of one list only"）；**(4) BM25 b 0.75→0.5**（`bm25-store.ts:createEngine` `defineConfig`）——弱化 length normalization 力度，让长整章 chunk 不再压死短子 chunk。**关键决策**：**(a) 不动 query-resolver**——用户初判根因是「口语化搜不到」，曾起草 v1.2.8 口语化改写方案（cheap gate + always-LLM 兜底），后用户实测数据指向「排错」非「搜不到」，**v1.2.8 口语化改写全部回滚**，query-resolver.ts / scripts/query-resolver-selftest.js 维持 v1.2.6 行为——消解指代（多轮 query）的核心价值仍然在；**(b) 不动 cross-encoder rerank**——v1.3.0 留章节结构 boost（query 含「第N章/条」→chunk 匹配则 RRF +0.05）+ cross-encoder rerank 终极方案；**(c) b=0.5 是经验值**——chunkSize=800 token 偏大、短 chunk 场景少，b=0.5 风险低；如实测有副作用可降到 0.3 或加 `Settings.bm25B` 字段让用户调
>
> - **v1.2.7**：**修复 LLM 把截断的 preview 当成完整列表答错的 bug**——v1.2.4 的 read_chunk 工具流把 200 字符 preview 发给 LLM 节省 token，但 LLM 看到 preview 末尾的省略号 `…` 经常当成自然结尾直接答——**用户实测**：问"条例第二章第十三条前后关于备案事项的完整规定"，源文档有 6 条 `(一)~(六) 设立分支机构`，AI 答出 (一)~(五) 截止到"变更…"。本版本三件套：**(1) 新建 `src/main/preview.ts` 抽 `formatChunkPreview(hit, chunkId)`**——把"截断 + 提示调 read_chunk"做成跨 simple/agent 共享函数；`hit.text.length > 200` 时显式追加 `[TRUNCATED: 共 N 字，仅显示前 200 字；列举/条款/编号型内容请先 read_chunk(${chunkId}) 取完整内容再引用]`，让 LLM 看到截断时**有显式信号**（不再靠猜"…"是不是自然结尾）。**(2) Citation.chunk 改存全文**——`ipc-handlers.ts` 6 处 + `agent.ts` 2 处把 `c.text.slice(0, 200)` 改成 `c.text`（`runSimpleChat` 的 `allCitations` / `legacyCitations` / provider error fallback / dedup / `finalCitations`；`runAgent` 的 dedup / chunk field）。UI 引用块加 `max-h-40 overflow-auto` + `whitespace-pre-wrap` 让长引用也能滚+换行；`readContext` 兜底分支现在用真实 chunk 全文本（之前是 200 字符 preview）。**(3) 硬规则写进 system prompt + tool description**——`SIMPLE_CHAT_SYS_PROMPT` 加 `v1.2.7 硬规则：preview 末尾出现 [TRUNCATED: 共 N 字...] 标记 且 内容看起来像列举/条款/编号型（(一)(二)(三) / 第N条/章/款 / 1.1.2 / A. B. C. / - 列表项）→ 必须先调 read_chunk(N) 拿完整内容再引用`；`AGENT_SYSTEM_PROMPT` 同样加硬规则；`READ_CHUNK_TOOL.description` 加 `**v1.2.7 硬规则**` 段同步约束。**关键决策**：v1.2.4 时 `READ_CHUNK_TOOL.description` 已写"想看具体内容调 read_chunk"——soft 引导不够用，LLM 把它当可选项，列举型内容必须用 hard rule 强约束。**(4) 自检脚本** `scripts/citation-preview-selftest.js` 7 组 21 用例：短文本不加 TRUNCATED / 长文本加 TRUNCATED（含字数 / read_chunk 编号）/ 列举型长文本（用户实战"第十三条 (一)~(六)"场景，验证 (六) 落在 preview body 之外 + 指引出现 read_chunk(1)）/ preview body 长度限制（恰好 201 字符含省略号）/ chunkId 嵌入 / 边界 200 字不加 TRUNCATED / 边界 201 字加 TRUNCATED，全部通过
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
│   │   ├── agent.ts           # **Agentic RAG 主循环**（v1.2.0 function_calling + v1.2.6 sub_query 必须自包含 prompt）
│   │   ├── api-client.ts      # 多提供商 LLM/Embedding 客户端（含 function_calling SSE 解析）
│   │   ├── context-builder.ts # **v1.2.4** 智能 history 截断（按模型 context window 智能压缩）
│   │   ├── query-rewriter.ts  # **v1.3.0** 查询理解管线（planSearchQuery：把口语化/短/多意图 query 翻译为 1-3 条 + RRF 融合；v1.3.1 加 stripNoise 剥寒暄/语气词；替换 v1.2.6 query-resolver）
│   │   ├── reranker.ts        # **v1.3.2** 检索后 LLM rerank（rerankHits：召回 20 候选 → Chat Provider 小 LLM 按语义重排 → 取 topK；只重排不替换 score；解决「正确答案被 BM25/RRF 排到 topK 外」）
│   │   ├── preview.ts         # **v1.2.7** 共享 preview 格式化（formatChunkPreview 抽 simple/agent 通用 + 截断时显式 [TRUNCATED] 标记 + read_chunk 指引）
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
