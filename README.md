# LocalRAG

> 本地知识库 RAG 桌面应用 · Electron + React + TypeScript + TailwindCSS + vectra

LocalRAG 是一款运行在 Windows 上的桌面知识库应用：配置好 AI 服务 API Key 后，你可以建立多个知识库，向其中上传 PDF / DOCX / Markdown / TXT 文档，然后基于这些文档进行智能问答。**所有数据都存储在本地**，向量库与对话历史均不离开你的电脑。

## 特性

- 🗂️ **多知识库**：按主题/项目分库管理，互不干扰
- 📄 **多格式支持**：PDF / DOCX / Markdown / TXT 自动解析与分块
- 🔍 **RAG 检索**：基于 vectra 的本地向量相似度检索 + Top-K 上下文
- 🤖 **多模型**：支持 OpenAI / DeepSeek / 通义千问 等 OpenAI 兼容服务
- 🔐 **安全存储**：API Key 通过 Windows 凭据管理器加密保存
- 💬 **流式回答**：基于 SSE 的逐字输出
- 🌓 **暗色 / 亮色 / 跟随系统** 三种主题
- 📦 **一键打包**：NSIS 安装程序，安装即用，**自带全部运行时**，无需 Python

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 桌面 | Electron 28 |
| 前端 | React 18 + TypeScript 5 + Vite 5 |
| 样式 | TailwindCSS 3 + PostCSS |
| 向量库 | **vectra**（纯 JS，本地持久化） |
| 关系库 | **sql.js**（WASM SQLite，零 native 编译） |
| 安全 | keytar |
| 文档解析 | pdf-parse / mammoth / marked / iconv-lite |
| 打包 | electron-builder |

> 重要：项目使用 **vectra** 替代了 ChromaDB，主进程不再启动任何外部进程，安装包无需捆绑 Python 运行时。

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

1. **配置 AI 服务**：启动后进入「设置 → AI 服务」，添加一个 Provider（OpenAI / DeepSeek / Qwen）并填入 API Key
2. **创建知识库**：左侧栏点击「＋ 新建」
3. **上传文档**：在文档面板点击「+ 上传」或拖入文件
4. **开始提问**：在底部输入框输入问题，AI 会基于文档内容回答并附带引用

> 详细使用说明见 [docs/用户手册.md](./docs/用户手册.md)

## 项目结构

```
LocalRAG/
├── src/
│   ├── main/                  # Electron 主进程
│   │   ├── vector-store.ts    # vectra 封装（向量库）
│   │   ├── document-processor.ts
│   │   ├── storage.ts         # SQLite + 文件存储
│   │   ├── api-client.ts
│   │   ├── secure-store.ts    # keytar
│   │   ├── ipc-handlers.ts
│   │   ├── preload.ts
│   │   └── main.ts
│   ├── renderer/              # React 渲染进程
│   └── shared/                # 跨进程共享类型与常量
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
| 应用配置 / 数据库 | `%APPDATA%\LocalRAG\` |
| 向量索引 | `%APPDATA%\LocalRAG\index\<kbId>\`（每知识库一目录） |
| 缓存 | `%APPDATA%\LocalRAG\cache\` |
| API Key | Windows 凭据管理器（条目名 `LocalRAG/<provider-id>`） |

## 常见问题

**Q：打包后用户还需要安装什么吗？**
A：不需要。安装包已包含所有 native 模块与运行时。

**Q：之前看到 ChromaDB，怎么没有了？**
A：v1.1 起改用 vectra（纯 JS 向量库），不再需要 Python 子进程，安装包体积更小、启动更快。

**Q：上传 PDF 报「无法解析」？**
A：可能是扫描件（图片型 PDF），需要 OCR，暂未支持。

**Q：打包后首次启动很慢？**
A：首次启动需要解压并初始化 SQLite 索引，约 5-10 秒属正常。

## License

MIT
