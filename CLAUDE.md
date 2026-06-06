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
| HTTP 客户端 | axios |
| 状态管理 | React Hooks + Context（不引入额外库） |
| 路由 | 自实现轻量 hash 路由（避免引入 react-router） |

> 重大变更记录：
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
│   │   └── api-client.ts      # 多提供商 LLM/Embedding 客户端（含 function_calling SSE 解析）
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
