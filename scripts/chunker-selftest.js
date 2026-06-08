// 切片器自检（运行 dist/main/chunkers）
// 跑法：node scripts/chunker-selftest.js
const { chunkDocument, pdfItemsToText } = require('../dist/main/chunkers');
const { countTokens } = require('../dist/main/chunkers/tokenizer');

const opts = { chunkSize: 200, chunkOverlap: 30 };

function show(title, chunks) {
  console.log(`\n===== ${title} (${chunks.length} chunks) =====`);
  chunks.forEach((c, i) => {
    const tokens = countTokens(c);
    const preview = c.replace(/\n/g, ' ⏎ ').slice(0, 100);
    console.log(`  [${i}] ${tokens}t | ${preview}${c.length > 100 ? '...' : ''}`);
  });
}

// 1) 纯文本
const plainText = `
第一段：介绍项目背景。本项目是一个本地知识库 RAG 桌面应用，目标是让用户在不上传任何数据到云端的前提下使用 RAG 能力。

第二段：技术栈选型。前端使用 React 18 + TypeScript 5 + Vite 5。桌面壳层使用 Electron 28。向量库选用 vectra 而非 ChromaDB，因为后者依赖 Python 子进程会破坏"零外部运行时"的承诺。关系数据库选用 sql.js（纯 WASM）而非 better-sqlite3（需要 native 编译）。

第三段：项目特点。整个应用打包后自带 Node 原生模块与全部资源，安装即可使用。不需要 Python，不需要 Docker，不需要 Node 工具链。Windows 凭据管理器用于安全存储 API Key，避免明文落盘。

第四段：检索能力。除了向量检索，还支持 BM25 关键词索引（精确术语召回），通过 RRF 融合两路结果。Agent 模式下 LLM 可以自主决定搜不搜、搜什么、搜几次、信息够不够。
`.trim();
show('纯文本 (plain)', chunkDocument({ type: 'plain', text: plainText }, opts));

// 2) Markdown
const md = `
# LocalRAG 项目

## 概述

LocalRAG 是一款 Windows 桌面 RAG 应用。用户配置 API Key 后，可上传文档（PDF / DOCX / Markdown / TXT）并基于这些文档进行智能问答。

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 桌面框架 | Electron 28+ |
| 前端框架 | React 18 + TypeScript 5 |
| 向量库 | vectra |

## 核心模块

\`\`\`typescript
// vector-store.ts
export async function hybridSearch(kbId: string, query: string, topK: number) {
  const vecHits = await vectorSearch(kbId, query, topK);
  const bm25Hits = await bm25Search(kbId, query, topK);
  return rrfMerge(vecHits, bm25Hits);
}
\`\`\`

### BM25 索引

每个 KB 单独维护一份 bm25.docs.json 索引。检索时与向量结果用 RRF 公式融合（\`score = 1/(k+rankVec) + 1/(k+rankBM25)\`）。
`.trim();
show('Markdown (markdown)', chunkDocument({ type: 'markdown', text: md }, opts));

// 3) 模拟 PDF items
const PAGE_H = 800;
const items = [
  // 第 1 页 - 页眉
  { str: 'LocalRAG 用户手册 v1.0', x: 300, y: 770, hasEOL: false, page: 0 },
  { str: '第一章', x: 50, y: 700, hasEOL: false, page: 0 },
  { str: ' ', x: 110, y: 700, hasEOL: false, page: 0 },
  { str: '概述', x: 120, y: 700, hasEOL: true, page: 0 },
  { str: '本项目是 LocalRAG 桌面应用。', x: 50, y: 650, hasEOL: true, page: 0 },
  { str: '产品定位是面向个人开发者的本地 RAG 工具。', x: 50, y: 600, hasEOL: true, page: 0 },
  { str: '技术栈选型使用 vectra 而不是 ChromaDB。', x: 50, y: 550, hasEOL: true, page: 0 },
  { str: '不依赖 Python 子进程是核心承诺。', x: 50, y: 500, hasEOL: true, page: 0 },
  { str: '第 1 页', x: 380, y: 30, hasEOL: false, page: 0 },

  { str: 'LocalRAG 用户手册 v1.0', x: 300, y: 770, hasEOL: false, page: 1 },
  { str: '第二章', x: 50, y: 700, hasEOL: false, page: 1 },
  { str: ' ', x: 110, y: 700, hasEOL: false, page: 1 },
  { str: '架构', x: 120, y: 700, hasEOL: true, page: 1 },
  { str: '主进程负责文档解析、向量化、入库。', x: 50, y: 650, hasEOL: true, page: 1 },
  { str: '渲染进程负责 UI、对话、引用展示。', x: 50, y: 600, hasEOL: true, page: 1 },
  { str: '通过 IPC + preload 安全地暴露能力。', x: 50, y: 550, hasEOL: true, page: 1 },
  { str: '细节见 src/main/ 目录下的模块。', x: 50, y: 500, hasEOL: true, page: 1 },
  { str: '第 2 页', x: 380, y: 30, hasEOL: false, page: 1 },

  { str: 'LocalRAG 用户手册 v1.0', x: 300, y: 770, hasEOL: false, page: 2 },
  { str: '第三章', x: 50, y: 700, hasEOL: false, page: 2 },
  { str: ' ', x: 110, y: 700, hasEOL: false, page: 2 },
  { str: '切片策略', x: 120, y: 700, hasEOL: true, page: 2 },
  { str: '本版本（v1.2.1）按文件类型分发。', x: 50, y: 650, hasEOL: true, page: 2 },
  { str: 'Markdown 走结构感知，PDF 走版面感知。', x: 50, y: 600, hasEOL: true, page: 2 },
  { str: '纯文本与 OCR 后的 PDF 走递归切分。', x: 50, y: 550, hasEOL: true, page: 2 },
  { str: '第 3 页', x: 380, y: 30, hasEOL: false, page: 2 },
];
const pdfText = pdfItemsToText({ items, pageHeight: PAGE_H });
console.log(`\n===== PDF items → 文本 (${pdfText.length} 字符) =====`);
console.log(pdfText);
show('PDF 文本 (经 pdfItemsToText 后走 recursive)', chunkDocument({ type: 'plain', text: pdfText }, opts));
