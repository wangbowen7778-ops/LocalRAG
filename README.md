# LocalRAG

> 本地知识库 RAG 桌面应用 · Electron + React + TypeScript + TailwindCSS · v2.0.0

LocalRAG 是一款运行在 Windows 上的桌面知识库应用：配置好 AI 服务 API Key 后，你可以建立多个知识库，向其中上传 PDF / DOCX / Markdown / TXT 文档，然后基于这些文档进行智能问答。**所有数据都存储在本地**，向量库与对话历史均不离开你的电脑。

## 特性

- 🗂️ **多知识库**：按主题/项目分库管理，支持 `description`（喂给 LLM 选 KB）
- 📄 **多格式支持**：PDF / DOCX / Markdown / TXT 自动解析与分块；**扫描件 PDF 自动 OCR**（tesseract.js 本地识别）
- 🔍 **混合检索（v1.1.7+）**：向量 + BM25（`wink-bm25-text-search`）走 RRF 公式融合——精确术语召回大幅提升
- 🧠 **Agentic RAG（v1.2.0+）**：LLM 通过 `function_calling` 自主决定「搜不搜、搜什么、搜几次、信息够不够」——支持**跨 KB 检索**、**查询分解**、**多轮迭代**、**自我批判**、**LLM 自选 KB**
- ✂️ **智能切分（v1.2.1+）**：按文件类型分发——Markdown 结构感知（`marked.lexer` + 标题面包屑）/ 文本层 PDF 版面感知（pdfjs items 按 y/x 排版 + 跳页眉页脚）/ DOCX/TXT/OCR-PDF 递归分隔符；`chunkSize` / `chunkOverlap` 单位切到 token（`gpt-tokenizer` cl100k_base），中英文密度差异 ≤ 15%
- 🤖 **多模型**：支持 OpenAI / DeepSeek / 通义千问 / 硅基流动 等 OpenAI 兼容服务
- 🔐 **安全存储**：API Key 通过 Windows 凭据管理器加密保存
- 💬 **流式回答**：基于 SSE 的逐字输出；Agent 模式额外推送折叠 trace（plan / search / critique 步骤）
- 🌓 **暗色 / 亮色 / 跟随系统** 三种主题
- 📦 **一键打包**：NSIS 安装程序，安装即用，**自带全部运行时**，无需 Python / Docker

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 桌面 | Electron 28 |
| 前端 | React 18 + TypeScript 5 + Vite 5 |
| 样式 | TailwindCSS 3 + PostCSS |
| 向量库 | **vectra**（纯 JS，本地持久化） |
| 关系库 | **sql.js**（WASM SQLite，零 native 编译） |
| 关键词索引 | **wink-bm25-text-search**（v1.1.7+ 精确术语召回） |
| 安全 | keytar |
| 文档解析 | **pdfjs-dist**（v1.1.6+ CJK CMap）/ mammoth / marked / iconv-lite |
| OCR | **tesseract.js** + **@napi-rs/canvas**（v1.1.6+ 扫描件识别） |
| 打包 | electron-builder |

> 重要：项目使用 **vectra** 替代了 ChromaDB，主进程不再启动任何外部进程，安装包无需捆绑 Python 运行时；**keytar** 是唯一需要 native 编译的模块（打包时按 Electron ABI 单独 rebuild）。

## 快速开始

### 1. 环境要求（仅开发时）

- Node.js ≥ 18.18（推荐 20 LTS）
- Windows 10/11 64-bit
- **无需 Python**

### 2. 安装依赖

```bash
npm install --ignore-scripts
# 若首次安装后 npm run dev 报 "Electron failed to install correctly"：
#   1) node node_modules/electron/install.js   # 让 npm 重新下载 Electron 二进制
#   2) 若下载不完整：rm -rf node_modules/electron/dist && unzip -q \
#        "C:\Users\<you>\AppData\Local\electron\Cache\*\electron-v28.3.3-win32-x64.zip" \
#        -d node_modules/electron/dist
npm run rebuild:keytar
```

> v1.1.2 起 `sql.js`、`vectra` 都是纯 JS/WASM，**不需 native 编译**。`keytar` 仍需为 Electron 单独编译。

### 3. 启动开发

```bash
npm run dev
```

### 4. 打包 Windows 安装包

```bash
npm run dist:win
```

输出位置：`release/LocalRAG-Setup-x.x.x.exe`

最终用户**双击安装即可使用**，不需要安装 Python、Node、ChromaDB 等任何环境。

## 使用流程

1. **配置 AI 服务**：启动后进入「设置 → AI 服务」，添加一个 Provider（OpenAI / DeepSeek / Qwen / 硅基流动）并填入 API Key
2. **创建知识库**：左侧栏点击「＋ 新建」；推荐填写「描述」——Agent 模式下 LLM 会用它判断该搜哪些 KB
3. **上传文档**：在文档面板点击「+ 上传」或拖入文件（扫描件 PDF 需先在「设置 → 常规」开启 OCR）
4. **开始提问**：在底部输入框输入问题。**简单模式**（默认）：单轮检索 + 流式生成；**Agent 模式**（设置开启）：多轮迭代 + 跨 KB 检索 + 查询分解 + 自我批判
5. **多 KB 跨库检索**：左侧勾选多个 KB checkbox，header 出现「跨 N KB」徽章，Agent 会自动挑该搜哪些

> 详细使用说明见 [docs/用户手册.md](./docs/用户手册.md)

## Agent 模式（v1.2.0+）

开启「设置 → 常规 → 启用 Agentic RAG」后，LLM 通过 OpenAI 协议 `function_calling` 自主决策：

- **不搜**（闲聊 / 数学 / 代码）→ 直接调 `skip_search` 走通识
- **搜**：调 `search_kb(sub_query, kb_ids?)` 检索
- **多轮**：拿到结果后判断信息够不够；不够就改写 `sub_query` 再搜
- **跨 KB**：把 KB 目录（含 `description`）喂给 LLM，让它自己挑搜哪些

每一步都会实时推送到 UI 的折叠 trace 面板（`src/renderer/components/Chat/AgentTraceView.tsx`）。需要 Provider 支持 function_calling（OpenAI / DeepSeek / Qwen / SiliconFlow 都支持）。Provider 不支持时自动降级到简单模式。

典型端到端用例见 [docs/用户手册.md §5.3](./docs/用户手册.md)。

## 项目结构

```
LocalRAG/
├── src/
│   ├── main/                  # Electron 主进程
│   │   ├── main.ts            # 主进程入口（窗口、生命周期）
│   │   ├── preload.ts         # 预加载脚本（暴露 IPC）
│   │   ├── ipc-handlers.ts    # IPC 处理器注册
│   │   ├── secure-store.ts    # keytar 封装
│   │   ├── storage.ts         # sql.js + 本地存储
│   │   ├── document-processor.ts  # 文档解析 + 分块 + OCR 调度
│   │   ├── pdfjs-shim.ts      # pdfjs 启动前预填 DOMMatrix/Path2D（@napi-rs/canvas）
│   │   ├── vector-store.ts    # **vectra** 封装（hybridSearch + hybridSearchMulti 跨 KB）
│   │   ├── bm25-store.ts      # **wink-bm25-text-search** 索引（每 KB 一份 bm25.docs.json）
│   │   ├── upload-queue.ts    # 上传队列（全局限并发 3）
│   │   ├── agent.ts           # **Agentic RAG 主循环**（function_calling + 多轮迭代 + 跨 KB）
│   │   ├── api-client.ts      # 多提供商 LLM/Embedding 客户端（含 function_calling SSE 解析）
│   │   └── chunkers/          # **v1.2.1** 按文件类型分发的切分器
│   │       ├── tokenizer.ts   #   gpt-tokenizer cl100k_base 包装
│   │       ├── recursive.ts   #   递归分隔符（DOCX/TXT/OCR-PDF）
│   │       ├── markdown.ts    #   marked.lexer 结构感知（Markdown）
│   │       ├── pdf-layout.ts  #   pdfjs items 版面感知（文本层 PDF）
│   │       └── index.ts       #   分发器
│   ├── renderer/              # React 渲染进程
│   │   ├── App.tsx
│   │   ├── hooks/useChat.ts   # 订阅 chat:* 事件 + streamingTrace state
│   │   └── components/
│   │       ├── Chat/AgentTraceView.tsx  # **v1.2.0** 折叠 trace 组件
│   │       └── ...
│   └── shared/                # 跨进程共享类型与常量（IPC + AGENT_TOOLS）
├── docs/                      # 项目文档
├── resources/                 # 图标等静态资源
├── electron-builder.json      # 打包配置
├── tailwind.config.js
└── vite.config.ts
```

## 文档

- [CLAUDE.md](./CLAUDE.md) - 项目说明（必读）
- [开发计划](./docs/开发计划.md) - 七阶段开发计划
- [开发进度](./docs/开发进度.md) - 当前进度
- [API 文档](./docs/API文档.md) - IPC 接口与示例
- [用户手册](./docs/用户手册.md) - 终端用户指南

## 数据存储位置

| 数据 | 路径 |
| --- | --- |
| 应用配置 / 数据库 | `%APPDATA%\LocalRAG\chat.db` |
| 向量索引 | `%APPDATA%\LocalRAG\index\<kbId>\index.json`（vectra） |
| 关键词索引 | `%APPDATA%\LocalRAG\index\<kbId>\bm25.docs.json`（v1.1.7+） |
| 分块原文 | `%APPDATA%\LocalRAG\index\<kbId>\chunks.json` |
| OCR 模型缓存 | `%APPDATA%\LocalRAG\cache\tesseract\`（v1.1.6+ 首次启用 OCR 后下载） |
| 日志 | `%APPDATA%\LocalRAG\logs\` |
| API Key | Windows 凭据管理器（条目名 `LocalRAG/<provider-id>`） |

## 常见问题

**Q：打包后用户还需要安装什么吗？**
A：不需要。安装包已包含所有 native 模块与运行时（除 `keytar` 由 electron-builder 按 Electron ABI 单独 rebuild 外，无其他 native 依赖）。

**Q：之前看到 ChromaDB，怎么没有了？**
A：v1.1 起改用 vectra（纯 JS 向量库），不再需要 Python 子进程，安装包体积更小、启动更快。

**Q：上传 PDF 报「无法解析」？**
A：v1.1.6 起已支持扫描件（图片型 PDF）OCR：到「设置 → 常规」勾选「**对扫描件 PDF 启用 OCR**」，首次使用会自动下载 tesseract 中英模型（~23MB，之后离线可用）。如果还不行，点「**测试 OCR**」按钮独立验证管线。

**Q：DeepSeek 用户上传文档报 404？**
A：DeepSeek **没有 `/embeddings` 端点**（任何模型都 404，这是 DeepSeek 的根本限制）。在「AI 服务」页新增一个支持 Embedding 的 Provider（OpenAI / 通义千问 / 硅基流动），然后到「设置 → 常规 → Embedding Provider」选它。Chat 仍可继续用 DeepSeek。

**Q：问一个文档，三个相似文档都被引用？**
A：到「设置 → 常规」调高「**引用分数阈值**」（默认 0.4，可调到 0.5-0.6）。低于阈值的 chunk 既不进 LLM 上下文、也不展示为引用。v1.1.7+ 启用了 BM25 混合检索也能改善——精确术语召回更好，不会因为字面相似拉错文档。

**Q：删除文档后文档数变负数？**
A：v1.1.6 起已修复（`updateKBStats` 改为条件回退 + 启动时按 documents 表实际重算）。如果是从更老版本升上来的，重启应用一次即可触发重算。

**Q：Agent 模式是什么？和「简单模式」有什么区别？**
A：简单模式是「单次检索 + 一次性生成」——秒回但只够单 KB 简单问题。Agent 模式（v1.2.0+）是「多轮迭代 + 自主决策」——LLM 自己决定搜不搜、搜什么、搜几次，支持跨 KB、查询分解、自我批判。**首问慢 2-5 秒**。任何 OpenAI 兼容 Provider 都支持 function_calling。详见 [用户手册 §5.3](./docs/用户手册.md)。

**Q：怎么跨 KB 检索？**
A：在左侧 KB 列表勾上多个 KB（checkbox），顶部 header 出现「跨 N KB」徽章。Agent 模式开启时，LLM 会读每个 KB 的 `description` 决定搜哪些（描述越准越好）。简单模式默认只搜第一个 KB。

**Q：打包后首次启动很慢？**
A：首次启动需要解压并初始化 SQLite 索引，约 5-10 秒属正常。OCR 模型按需下载（首次用扫描件时）。

## License

MIT

---

## 版本

- **当前：v2.0.0** — 4 项核心特性合并发布：Agentic RAG + 智能切分 + 查询改写 + 长会话上下文
  - **Agentic RAG**（内部里程碑 v1.2.0）—— function_calling + 多轮迭代 + 跨 KB + LLM 自选 KB
  - **智能切分**（内部里程碑 v1.2.1）—— 按文件类型分发：Markdown 结构感知 / PDF 版面感知 / 递归分隔符，token 单位
  - **查询改写**（内部里程碑 v1.2.2）—— 多轮对话"它/哪一章？"指代省略问句自动改写为自包含 query
  - **长会话上下文**（内部里程碑 v1.2.3）—— `buildRewriteHistory` 历史压缩 + 周期摘要 + 跨 session 历史摘要召回
- v1.1.7 — 混合检索（向量 + BM25, RRF 融合）
- v1.1.6 — 扫描件 OCR（tesseract.js）+ 引用分数阈值 + pdfjs + @napi-rs/canvas 集成
- v1.1.5 — DeepSeek 无 `/embeddings` 端点修复（独立 `embeddingProviderId`）
- v1.1.1 — sql.js 替代 better-sqlite3（彻底消除 native 编译依赖）
- v1.1 — vectra 替代 ChromaDB（无 Python 子进程）
