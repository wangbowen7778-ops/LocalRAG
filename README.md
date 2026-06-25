# LocalRAG

> 本地知识库 RAG 桌面应用 · Electron + React + TypeScript + TailwindCSS · v1.3.6 (公开版，与内部里程碑号对齐)

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
- 📑 **read_chunk 工具（v1.2.4+）**：检索后只把"索引 + preview"发到 LLM，LLM 按需 `read_chunk(chunk_id)` 拉全文——简单模式也享受工具流，节省 ~60-80% chunk 相关 token
- 🚦 **preview 截断硬规则（v1.2.7+）**：200 字符 preview 末尾加显式 `[TRUNCATED: 共 N 字...]` 标记；system prompt + `READ_CHUNK_TOOL.description` 把"列举/条款/编号型内容必须先 read_chunk(N) 拿完整内容再引用"升级为 hard rule——修复 v1.2.4~v1.2.6 用户实测"条例 (一)~(六) 答出 (一)~(五) 截止到变更…"的截断列表漏判 bug
- 🧮 **智能 context 截断（v1.2.4+）**：替代 v1.2.2 改写 + v1.2.3 硬切——`buildHistory` 按模型 context window 智能截断，64K 模型约 40 轮内不触发压缩
- 🎯 **多轮检索消解（v1.2.6+）**：修复 v1.2.5 regex 漏判开放表达的老问题——简单模式 `session` 有 `history` 总是调 LLM 把 `current` + 末 6 条 history 凝成 self-contained；Agent 模式 prompt 显式要求 `sub_query` 自包含。核心场景（"第几章？"/"它的限流"/"原文呢"）全部命中正确 KB
- 🔮 **查询理解与重写管线（v1.3.0+）**：v1.2.6 query-resolver 升级版——用 LLM 把口语化/短/多意图 query 翻译为 1-3 条可检索 query，RRF 融合后喂给向量库。简单模式 + Agent 模式共享，关闭时退化为 v1.2.6 行为。v1.3.1 加 `stripNoise` 预处理（纯 regex 剥寒暄开头 / 闲聊尾巴 / 句末语气词「呢」），首轮与多轮共享
- 🔄 **检索结果 LLM rerank（v1.3.2+）**：召回 20 候选 → Chat Provider 小 LLM 按语义相关度重排 → 取 topK 喂主答 LLM。解决「正确答案被 BM25/RRF 排到 topK 外」（长整章 chunk 关键词堆砌压过答案子 chunk，LLM 拿到错的 chunk 幻觉）。只重排不替换 score，失败自动回退 RRF 原顺序。简单模式 + Agent 模式共享
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
│   │   ├── agent.ts           # **Agentic RAG 主循环**（v1.2.0 function_calling + v1.2.6 sub_query 自包含 prompt）
│   │   ├── api-client.ts      # 多提供商 LLM/Embedding 客户端（含 function_calling SSE 解析）
│   │   ├── context-builder.ts # **v1.2.4** 智能 history 截断（按模型 context window）
│   │   ├── query-rewriter.ts  # **v1.3.0** 查询理解管线（planSearchQuery：把口语化/短/多意图 query 翻译为 1-3 条 + RRF 融合；v1.3.1 加 stripNoise 剥寒暄/语气词；替换 v1.2.6 query-resolver）
│   │   ├── reranker.ts        # **v1.3.2** 检索后 LLM rerank（rerankHits：召回 20 候选 → Chat Provider 小 LLM 按语义重排 → 取 topK；只重排不替换 score）
│   │   ├── preview.ts         # **v1.2.7** 共享 preview 格式化（formatChunkPreview 抽 simple/agent 通用 + 截断时显式 [TRUNCATED] 标记 + read_chunk 指引）
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

- **当前：v1.3.6 (公开版，与内部里程碑号对齐)** — 随 v1.3.4（闲聊短路 + 会话串扰修复）+ v1.3.5（检索性能优化）发布
  - **检索性能优化**（v1.3.5）—— 分步耗时日志（plan/embed/search/rerank 各步 ms）+ rerank/plan 改流式（`chatStream`）+ rerank 10s 超时兜底。实测 rerank 33s→3.7s（deepseek-v4-flash 非流式要等思考链+正文全生成完才返回，10-33s 超时；流式正文一出就能收）。端到端 47s→13s
  - **闲聊短路**（v1.3.4）—— `planSearchQuery` 加 `skipSearch`：首轮 cheap regex 检测纯问候（"你好/谢谢/在吗"），多轮 LLM 判断，命中跳过检索直接主答，省 2-3 次 LLM/API 调用。失败兜底走检索（宁可不短路别漏答）
  - **会话等待串扰修复**（v1.3.4）—— `useChat` 加 `streamingSessionRef`：切会话时若切到的不是正在流式的会话则清流式态，修复"一个会话提问时其他对话也显示等待"
  - **公开版版本号对齐**（v1.3.6）—— `package.json` + `APP_VERSION` 1.3.0→1.3.6，与内部里程碑号统一
- **v1.3.3 (内部里程碑)** — rerank 启用时直接发全文，修复 LLM 不调 read_chunk 导致截断
  - **rerank 开 → 发全文**（v1.3.3）—— `runSimpleChat` 的 `useToolFlow` 加 `&& !enableRerank`（rerank 开走 legacy 全文路径）；`runAgent` search_kb 响应 rerank 开时发 `filtered` 全文（不调 `formatChunkPreview`）。rerank 已精确挑出 topK，全文成本可接受，不再依赖 LLM 主动调 read_chunk
  - **修复的核心场景**：v1.3.2 rerank 搜到正确 chunk（第十九-二十二条 400+ 字），但 LLM 收到 200 字 preview 没调 read_chunk，答"截断，暂不支持拉取"。v1.3.3 直接发全文 → LLM 拿到完整内容 → 完整答出。根因：v1.2.7 硬规则"列举/条款型必须先 read_chunk"对弱模型无约束力，`runSimpleChatWithTools` line 440 兜底「LLM 没调 tool 就直接用 preview 答」
  - **rerank 关 → 保持 read_chunk 流**——无 rerank 时 chunk 质量参差，LLM 选择性读省 token 有价值
  - 无新增 Settings 字段（绑定 `enableRerank`）；build + typecheck + 自检回归通过
- **v1.3.2 (内部里程碑)** — 检索后 LLM rerank（重排候选）
  - **reranker**（v1.3.2）—— `src/main/reranker.ts` 新模块；`rerankHits(query, hits, settings)` 复用 `resolveSummaryProvider` + `chatCompletion`（走 Chat Provider，无新依赖）；召回 20 候选 → 小 LLM 按语义相关度重排 → 取 topK。只重排顺序不替换 score（RRF norm 保留，引用阈值/引用列表零侵入）。降级链：缺 key / 抛错 / 非 JSON / 空 order → 回退 RRF 原顺序
  - **简单模式 + Agent 模式都覆盖**（v1.3.2）—— `runSimpleChat` / `runAgent` search_kb 段：`fetchTopK = max(topK, 20)` 扩召回（不改 vector-store 签名）→ `rerankHits` → `slice(topK)` → threshold 过滤；rerank 先于 threshold 让 LLM 在更大候选池挑
  - **Settings 加 1 字段**（v1.3.2）—— `enableRerank`（默认 true）；UI 在「设置 → 常规」加 checkbox
  - **修复的核心场景**：用户实测「北京历史文化名城保护条例 第二章第十三条前后备案事项」——BM25 把正确答案（第十九-二十二条）排到 rank 12，RRF 融合后 rank 6 被 topK 切掉，LLM 拿到整章总则 chunk 幻觉"第四章只有第三十四条"。v1.2.8/v1.2.9 调参没根治（BM25 中文 unigram 分词让条例名前缀稀释 IDF），v1.3.2 用 LLM 语义重排把答案抬到前 1-2
  - **自检脚本** `scripts/reranker-selftest.js` 8 组 18 用例全部通过
  - **query-rewriter 入口加 stripNoise**（v1.3.1）—— 纯 regex 剥寒暄开头 / 闲聊尾巴 / 句末语气词「呢」，首轮 passthrough 与多轮 LLM 改写都先过一遍；改写 prompt 加规则 0 显式要求 LLM 剥无效词。解决"用户输入有很多无效的词句"稀释检索向量的问题。自检加测 1b 4 场景，40/40 通过
- **v1.3.0 (内部里程碑)** — 检索 query 理解与重写管线（替换 v1.2.6 query-resolver）
  - **query-rewriter**（v1.3.0）—— `src/main/query-rewriter.ts` 新模块；`planSearchQuery()` 用小 LLM（temperature=0.1）产出 `QueryPlan { searchQueries: 1-3 条, intent, expandedTerms, needsHighRecall }`：自包含原样 / 指代补全 / 模糊扩展 / 多意图分解。多 query 走 `hybridSearchMultiQuery`（`vector-store.ts` 新增）RRF 全局融合
  - **Settings 加 3 字段**（v1.3.0）—— `enableQueryRewriter`（默认 true）/ `queryRewriterProviderId`（空 = 走 Chat Provider）/ `queryRewriterModel`（空 = 走 Chat 模型）；UI 在「设置 → 常规」加 checkbox + Provider select + Model text input
  - **简单模式 + Agent 模式都覆盖**（v1.3.0）—— `runSimpleChat` 改用 `planSearchQuery` + `hybridSearchMultiQuery`；`runAgent` 循环前预计算 plan 注入 system prompt 作为「已改写候选 query」参考，LLM 仍可自主决定 sub_query
  - **替换 query-resolver**（v1.3.0）—— `src/main/query-resolver.ts` 和 `scripts/query-resolver-selftest.js` 已删除；`v1.2.5 / v1.2.6` 段保留为历史
  - **修复的核心场景**：用户实测反馈"检索时大模型不理解用户语义，很多无效的提示词"——根因是检索侧 query 质量差（口语化/短/多意图）。v1.3.0 把"单点指代消解"升级为完整管线，LLM 改写后 embedding/BM25 拿到高质量可检索 query
- **v2.0.0 (公开版)** — 10 项内部里程碑合并发布：Agentic RAG + 智能切分 + 查询改写 + 长会话上下文 + 智能截断 + read_chunk + 检索消解 + preview 截断硬规则 + 混合检索参数调优 + 查询理解管线
  - **Agentic RAG**（内部里程碑 v1.2.0）—— function_calling + 多轮迭代 + 跨 KB + LLM 自选 KB
  - **智能切分**（内部里程碑 v1.2.1）—— 按文件类型分发：Markdown 结构感知 / PDF 版面感知 / 递归分隔符，token 单位
  - **查询改写**（内部里程碑 v1.2.2）—— 多轮对话"它/哪一章？"指代省略问句自动改写为自包含 query（v1.2.4 已删除改写 LLM 调用；v1.2.6 重新引入 always-LLM 消解，但只用于检索侧）
  - **长会话上下文**（内部里程碑 v1.2.3）—— `buildRewriteHistory` 历史压缩 + 周期摘要 + 跨 session 历史摘要召回（v1.2.4 简化为 `buildHistory`）
  - **智能 context 截断**（内部里程碑 v1.2.4）—— `buildHistory` 按模型 context window 智能截断（firstUser 锚定 + middle LLM 压缩 + 末尾尽量多），替代 v1.2.2 改写 + v1.2.3 硬切 `slice(-8)`
  - **read_chunk 工具**（内部里程碑 v1.2.4）—— 检索后只把"索引 + preview"发到 LLM，LLM 按需 `read_chunk(chunk_id)` 拉全文，节省 ~60-80% chunk 相关 token。简单模式 + Agent 模式统一
  - **检索 query 消解**（内部里程碑 v1.2.5 → v1.2.6）—— v1.2.5 加 `query-resolver.ts` 三件套（stripQuestionTail / isAnaphoric / condenseWithLlm），v1.2.6 删 regex 门控改为 always-LLM
  - **preview 截断硬规则**（内部里程碑 v1.2.7）—— 显式 `[TRUNCATED]` 标记 + system prompt 硬规则"列举/条款/编号型必须 read_chunk"，修复 LLM 把截断 preview 当完整列表答错的 bug
  - **混合检索参数调优**（内部里程碑 v1.2.8）—— topK 5→8 / fetchK `max(50, 10×topK)` / RRF_K 60→30 / BM25 b 0.75→0.5，修复 BM25 长整章 chunk 压死短子 chunk 的 bug
  - **查询理解管线**（内部里程碑 v1.3.0）—— `query-rewriter` 多 query 翻译 + RRF 融合，替换 v1.2.6 query-resolver
  - **stripNoise 预处理**（内部里程碑 v1.3.1）—— `query-rewriter` 入口加纯 regex 剥寒暄开头 / 闲聊尾巴 / 句末语气词「呢」，首轮与多轮共享
  - **检索结果 LLM rerank**（内部里程碑 v1.3.2）—— `reranker` 召回 20 候选 → Chat Provider 小 LLM 语义重排 → 取 topK，解决「正确答案被 BM25/RRF 排到 topK 外」
  - **rerank 启用时发全文**（内部里程碑 v1.3.3）—— rerank 开时跳过 read_chunk preview 流直接发 topK 全文，修复 LLM 不调 read_chunk 导致截断
  - **闲聊短路 + 会话串扰修复**（内部里程碑 v1.3.4）—— 闲聊跳过检索直接主答（首轮 regex / 多轮 LLM 判断）；useChat streamingSessionRef 修复切会话等待串扰
  - **检索性能优化**（内部里程碑 v1.3.5）—— 分步耗时日志 + rerank/plan 改流式 + rerank 10s 超时，rerank 实测 33s→3.7s
  - **公开版版本号对齐**（v1.3.6）—— package.json + APP_VERSION 1.3.0→1.3.6，与内部里程碑号统一
- v1.1.7 — 混合检索（向量 + BM25, RRF 融合）
- v1.1.6 — 扫描件 OCR（tesseract.js）+ 引用分数阈值 + pdfjs + @napi-rs/canvas 集成
- v1.1.5 — DeepSeek 无 `/embeddings` 端点修复（独立 `embeddingProviderId`）
- v1.1.1 — sql.js 替代 better-sqlite3（彻底消除 native 编译依赖）
- v1.1 — vectra 替代 ChromaDB（无 Python 子进程）
