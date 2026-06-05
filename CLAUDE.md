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
│   │   ├── document-processor.ts  # 文档解析 + 分块
│   │   ├── vector-store.ts    # **vectra** 封装（替代 ChromaDB）
│   │   └── api-client.ts      # 多提供商 LLM/Embedding 客户端
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
│   │       └── Settings/SettingsDialog.tsx
│   └── shared/
│       ├── constants.ts
│       └── types.ts
├── resources/                 # 图标、安装包资源
├── data/                      # 用户数据（运行时生成）
│   ├── index/                 # vectra 向量索引（每知识库一目录）
│   ├── chat.db                # 对话历史
│   ├── cache/                 # 缓存
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
- **pdf-parse / mammoth / marked / iconv-lite**：文档解析。
- **vectra**：纯 JS 向量库，JSON 文件持久化，无需 Python。

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
