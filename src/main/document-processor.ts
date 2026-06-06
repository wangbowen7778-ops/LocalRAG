/**
 * 文档处理：解析 → 分块 → Embedding → 写入 Vectra 本地索引
 * 支持 PDF / DOCX / MD / TXT
 *
 * 文本提取器抽象：所有"文件 → 文本"的实现都走同一个 TextExtractor 接口，
 * 当前已注册两个：
 *   - PdfjsTextExtractor    纯文本 PDF（默认，零成本）
 *   - TesseractOcrExtractor 扫描件 / 图片型 PDF（用户在设置中开启 OCR 后自动 fallback）
 * 将来加云 OCR / RapidOCR，只需新增一个 TextExtractor 实现并在 selectExtractors() 注册。
 */
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore - pdfjs-dist 没有 .d.ts
import * as pdfjsLib from './pdfjs-shim';
import { createCanvas, type Canvas as NapiCanvas, type SKRSContext2D } from '@napi-rs/canvas';
// @ts-ignore - tesseract.js 没有完整 .d.ts
import { createWorker as createTesseractWorker, type Worker as TesseractWorker } from 'tesseract.js';
import mammoth from 'mammoth';
import { marked } from 'marked';
import iconv from 'iconv-lite';
import { listProviders } from './storage';
import { SecureStore } from './secure-store';
import { embedText } from './api-client';
import { addChunks, deleteChunksByDoc } from './vector-store';
import { getSettings, getUserDataDir } from './storage';
import type { DocProgressEvent } from '../shared/types';

interface ProcessParams {
  docId: string;
  kbId: string;
  filePath: string;
  mimeType: string;
  onProgress: (stage: DocProgressEvent['stage'], percent: number, message?: string) => void;
}

type ProgressFn = (stage: DocProgressEvent['stage'], percent: number, message?: string) => void;

/**
 * 文本提取器接口。任何"文件 → 纯文本"的实现都遵循此签名。
 * 提取失败（返回空 / 抛错）由 orchestrator 决定是否 fallback 到下一个。
 */
interface TextExtractor {
  /** 人类可读的提取器名（用于日志和错误提示） */
  readonly name: string;
  /** 是否愿意处理这个文件（按扩展名 / mimeType 自我判断） */
  accepts(ext: string, mimeType: string): boolean;
  /** 实际提取；返回空字符串视为"提取失败" */
  extract(buf: Buffer, ctx: { onProgress?: ProgressFn; filePath: string }): Promise<string>;
}

// pdfjs-dist legacy build 默认的 NodeCanvasFactory 内部会 require('canvas')（即 node-canvas 原版包），
// 它在 npm 上是 pdfjs-dist 的 optionalDependencies（已被 npm 拉进 node_modules/canvas，但 .node 二进制没编译）。
// 我们用的是 @napi-rs/canvas，pdfjs 认不到 → Cannot find module '../build/Release/canvas.node'。
// 自定义 factory 用 @napi-rs/canvas，绕开默认 factory。
// 注意：必须传给 getDocument()，不能只传给 page.render()——getDocument 内部会 new 默认 factory，
// 一旦 PDF 触发 annotation 渲染就会 require("canvas") 失败。
interface NapiCanvasAndContext {
  canvas: NapiCanvas;
  context: SKRSContext2D;
}
class NapiCanvasFactory {
  create(width: number, height: number): NapiCanvasAndContext {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(canvasAndContext: NapiCanvasAndContext, width: number, height: number): void {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: NapiCanvasAndContext): void {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

// pdfjs-dist 资源（cMap / 标准字体）路径：装包后从 node_modules 解析。
// 必须以分隔符结尾——pdfjs 会把文件名直接拼到 URL 后面，
// 不带分隔符会拼出 "...standard_fontsLiberation..." 这种错位路径。
function pdfjsAssetDir(sub: 'cmaps' | 'standard_fonts'): string {
  const pkgPath = require.resolve('pdfjs-dist/package.json');
  return path.join(path.dirname(pkgPath), sub) + path.sep;
}

/** 纯文本 PDF 提取：使用 pdfjs-dist legacy build（Node 主线程跑，无需 worker） */
const PdfjsTextExtractor: TextExtractor = {
  name: 'pdfjs-text',
  accepts: (ext) => ext === '.pdf',
  async extract(buf, { onProgress }) {
    // canvasFactory 也要传：getDocument() 会 new 一个默认 factory（Node 上是 NodeCanvasFactory），
    // 一旦 PDF 包含 annotation / link 需要渲染就会 require("canvas") 找 .node，找不到就 throw。
    // 文本提取本身不渲染，但安全起见统一传 NapiCanvasFactory。
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      cMapUrl: pdfjsAssetDir('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: pdfjsAssetDir('standard_fonts'),
      verbosity: 0,
      canvasFactory: new NapiCanvasFactory(),
    });
    let doc;
    try {
      doc = await loadingTask.promise;
    } catch (e) {
      throw new Error(`PDF 结构无法解析（${(e as Error).message}）。` +
        `若为密码保护文件，目前不支持；如文件可正常打开，请用「打印 → 另存为 PDF」重新导出一次。`);
    }
    const pageTexts: string[] = [];
    try {
      const num = doc.numPages;
      for (let i = 1; i <= num; i++) {
        onProgress?.('parsing', 5 + (i / num) * 20, `解析 PDF 文字层 ${i}/${num}`);
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        let lastY: number | undefined;
        const parts: string[] = [];
        for (const item of content.items as Array<{
          str: string;
          transform: number[];
          hasEOL?: boolean;
        }>) {
          const y = item.transform[5];
          if (lastY !== undefined && y !== lastY) parts.push('\n');
          parts.push(item.str);
          if (item.hasEOL) parts.push('\n');
          lastY = y;
        }
        pageTexts.push(parts.join(''));
      }
    } finally {
      await doc.destroy();
    }
    return pageTexts.join('\n\n');
  },
};

// Tesseract OCR 提取：渲染 PDF 每一页为 PNG，逐页 OCR。
// 用 module-level 缓存 worker，进程内只创建一次（后续调用零成本）。
// 模型首次使用自动下载到 userData/cache/tesseract；之后离线可用。
let tesseractWorkerPromise: Promise<TesseractWorker> | null = null;

function tesseractCacheDir(): string {
  const dir = path.join(getUserDataDir(), 'cache', 'tesseract');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function getTesseractWorker(onProgress?: ProgressFn): Promise<TesseractWorker> {
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = (async () => {
      onProgress?.('ocr', 2, '加载 OCR 引擎（首次需下载 ~23MB 语言模型）');
      return createTesseractWorker(['chi_sim', 'eng'], 1, {
        cachePath: tesseractCacheDir(),
        logger: (m: { status: string; progress: number }) => {
          if (!onProgress) return;
          // tesseract.js 内部状态：loading tesseract core / initializing tesseract /
          // loading language traineddata / initializing api / recognizing text
          if (m.status === 'loading language traineddata') {
            onProgress('ocr', Math.min(20, 2 + m.progress * 18), '下载 OCR 语言模型...');
          } else if (m.status === 'initializing tesseract' || m.status === 'loading tesseract core') {
            onProgress('ocr', 20, '初始化 OCR 引擎');
          }
        },
      });
    })().catch((e) => {
      // 创建失败要清空 promise，否则下次调用复用坏 worker
      tesseractWorkerPromise = null;
      throw e;
    });
  }
  return tesseractWorkerPromise;
}

// pdfjs-dist legacy build 自带的 BaseCanvasFactory 内部会 require('canvas')（即 node-canvas 原版包），
// 我们用的是 @napi-rs/canvas（无 native 编译），pdfjs 认不到、抛 Cannot find module '../build/Release/canvas.node'。
// 这里写一个用 @napi-rs/canvas 的 factory 显式传给 page.render()，绕开默认 factory。
// （NapiCanvasFactory 类定义在文件开头，两个抽取器共用）

const TesseractOcrExtractor: TextExtractor = {
  name: 'tesseract-ocr',
  accepts: (ext) => ext === '.pdf',
  async extract(buf, { onProgress, filePath }) {
    const worker = await getTesseractWorker(onProgress);
    const canvasFactory = new NapiCanvasFactory();
    // 先用 pdfjs 把每页渲染到 @napi-rs/canvas（scale=2 让小字也能 OCR 准）
    // 关键：canvasFactory 必须传给 getDocument()，不能只传给 page.render()——
    // getDocument 内部默认会 new DefaultCanvasFactory()（在 Node 上即 NodeCanvasFactory），
    // 它在 _createCanvas 里 require("canvas") 找 .node 二进制，找不到就 throw。
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      cMapUrl: pdfjsAssetDir('cmaps') + path.sep,
      cMapPacked: true,
      standardFontDataUrl: pdfjsAssetDir('standard_fonts') + path.sep,
      verbosity: 0,
      canvasFactory,
    });
    let doc;
    try {
      doc = await loadingTask.promise;
    } catch (e) {
      throw new Error(`OCR 前置步骤失败：PDF 渲染不了（${(e as Error).message}）。`);
    }
    const numPages = doc.numPages;
    const pageTexts: string[] = [];
    try {
      for (let i = 1; i <= numPages; i++) {
        onProgress?.('ocr', 20 + ((i - 1) / numPages) * 75, `OCR 识别 ${i}/${numPages}`);
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        const cc = canvasFactory.create(viewport.width, viewport.height);
        try {
          await page.render({
            canvasContext: cc.context,
            viewport,
            canvasFactory,
          } as any).promise;
          const png = cc.canvas.toBuffer('image/png');
          const { data } = await worker.recognize(png);
          pageTexts.push(data.text || '');
        } finally {
          canvasFactory.destroy(cc);
        }
      }
    } finally {
      await doc.destroy();
    }
    const combined = pageTexts.join('\n\n').trim();
    if (combined.length < 10) {
      throw new Error(`OCR 完成但识别为空（${filePath}）。` +
        `可能原因：图片分辨率极低 / 全部为表格 / 文字被反色处理。`);
    }
    onProgress?.('ocr', 95, `OCR 完成，共识别 ${numPages} 页`);
    return combined;
  },
};

/** 按顺序选择要尝试的提取器（PDF 走 pdfjs → tesseract fallback） */
function selectExtractors(ext: string, mimeType: string, settings: ReturnType<typeof getSettings>): TextExtractor[] {
  if (ext === '.pdf' || mimeType === 'application/pdf') {
    const list: TextExtractor[] = [PdfjsTextExtractor];
    if (settings.enableOcr) list.push(TesseractOcrExtractor);
    return list;
  }
  return []; // DOCX/MD/TXT 不走抽取器接口
}

/** 解析文档为纯文本（带 OCR fallback） */
async function extractText(
  filePath: string,
  mimeType: string,
  onProgress?: ProgressFn,
): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  const settings = getSettings();

  // 走抽取器接口（PDF）
  const extractors = selectExtractors(ext, mimeType, settings);
  if (extractors.length > 0) {
    let lastErr: Error | null = null;
    for (let i = 0; i < extractors.length; i++) {
      const ex = extractors[i];
      const hasNext = i < extractors.length - 1;
      try {
        const text = await ex.extract(buf, { onProgress, filePath });
        if (text && text.length >= 10) {
          if (ex !== extractors[0]) {
            console.log(`[doc] ${filePath}：${extractors[0].name} 失败，${ex.name} 提取到 ${text.length} 字符`);
          }
          return text;
        }
        if (hasNext) {
          console.log(`[doc] ${filePath}：${ex.name} 仅得 ${text?.length ?? 0} 字符，尝试下一个抽取器`);
        } else {
          console.log(`[doc] ${filePath}：${ex.name} 仅得 ${text?.length ?? 0} 字符，已无更多抽取器` +
            (settings.enableOcr ? '' : '（如需 OCR 请在「设置 → 常规」开启「对扫描件 PDF 启用 OCR」）'));
        }
      } catch (e) {
        lastErr = e as Error;
        if (hasNext) {
          console.log(`[doc] ${filePath}：${ex.name} 失败（${(e as Error).message}），尝试下一个抽取器`);
        } else {
          console.log(`[doc] ${filePath}：${ex.name} 失败（${(e as Error).message}），已无更多抽取器`);
        }
      }
    }
    // 所有抽取器都失败
    const ocrOff = !settings.enableOcr;
    const hint = ocrOff
      ? `可能原因：(1) 这是扫描件 / 图片型 PDF，文字在图里需要 OCR；` +
        `(2) PDF 加密或受密码保护。请在「设置 → 常规」开启「对扫描件 PDF 启用 OCR」后重试。`
      : `可能原因：扫描质量极差 / 全表格 / 反色图像。` +
        `请确认 PDF 内容或换用专业 OCR 工具先转一道。`;
    throw new Error(
      `所有抽取器均未取得可用文字。${hint}${lastErr ? `\n最后错误：${lastErr.message}` : ''}`,
    );
  }

  // DOCX
  if (ext === '.docx' || mimeType.includes('officedocument')) {
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value;
  }

  // Markdown
  if (ext === '.md' || mimeType === 'text/markdown') {
    const html = await marked.parse(buf.toString('utf-8'));
    return html.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n');
  }

  // 兜底当作 txt
  if (buf[0] === 0xff && buf[1] === 0xfe) return iconv.decode(buf, 'utf-16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return iconv.decode(buf, 'utf-16be');
  if (buf[0] === 0xef && buf[1] === 0xbb) return buf.toString('utf-8');
  try {
    return iconv.decode(buf, 'gbk');
  } catch {
    return buf.toString('utf-8');
  }
}

/**
 * 滑动窗口分块
 * - 优先按段落（\n\n）切分
 * - 单段过长时按句号切
 * - 最后按 chunkSize 强制切片，保留 overlap
 */
function splitChunks(text: string, size: number, overlap: number): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!cleaned) return [];

  const paragraphs = cleaned.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = '';

  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = '';
  };

  for (const p of paragraphs) {
    if (p.length > size) {
      // 大段单独切
      flush();
      for (let i = 0; i < p.length; i += size - overlap) {
        const piece = p.slice(i, i + size);
        if (piece.trim()) chunks.push(piece.trim());
      }
      continue;
    }
    if ((buf + '\n\n' + p).length > size) {
      flush();
      // 保留 overlap
      const tail = chunks[chunks.length - 1]?.slice(-overlap) ?? '';
      buf = (tail ? tail + '\n' : '') + p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }
  flush();
  return chunks;
}

/**
 * 构造文档级上下文前缀（Contextual Retrieval, Anthropic 2024）
 *
 * 目的：解决"相关 chunk 被切散后 LLM 失去上下文"问题——
 * 给每个 chunk 注入文档标题 + 摘要前缀，使所有 chunk 共享同一锚点，
 * 检索时 LLM 看到的是「带上下文的片段」而非孤立文本。
 *
 * 不调 LLM 生成摘要（成本/延迟/隐私），cheap 方案：
 * - title = filename
 * - summary = 文档第一段非空内容前 200 字符
 *
 * 同样的带前缀 text 会同时写入 vectra 和 BM25——BM25 会把 filename 和摘要词
 * 一起索引，用户问"X 的文档在哪"时也能命中。
 */
function buildContextPrefix(filename: string, fullText: string): string {
  // 第一个非空段落
  const firstPara =
    fullText
      .replace(/\r\n/g, '\n')
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? '';
  // 截断到 200 字符；保留句子边界
  let summary = firstPara;
  if (summary.length > 200) {
    summary = summary.slice(0, 200);
    const lastPunc = Math.max(
      summary.lastIndexOf('。'),
      summary.lastIndexOf('.'),
      summary.lastIndexOf('！'),
      summary.lastIndexOf('!'),
      summary.lastIndexOf('；'),
      summary.lastIndexOf(';'),
    );
    if (lastPunc > 80) summary = summary.slice(0, lastPunc + 1);
  }
  if (!summary) summary = '（无摘要）';
  return `【文档：${filename}】\n【摘要：${summary}】\n\n`;
}

/**
 * 处理并入库
 * @returns 实际写入的块数
 */
export async function processAndIndexDoc(params: ProcessParams): Promise<number> {
  const { docId, kbId, filePath, onProgress } = params;
  onProgress('parsing', 5, '解析文档');

  const text = await extractText(filePath, params.mimeType, onProgress);
  if (!text || text.length < 10) {
    // 理论上 extractText 内部已 throw；这里是兜底
    throw new Error(`解析后文本仅 ${text?.length ?? 0} 字符。可能是文件内容实际为空。`);
  }

  const settings = getSettings();
  const rawChunks = splitChunks(text, settings.chunkSize, settings.chunkOverlap);
  if (rawChunks.length === 0) throw new Error('分块后无内容');

  // Contextual chunking：给每个 chunk 加文档级上下文前缀
  // 同样的带前缀 text 写入 vectra 与 BM25——LLM 检索时直接看到上下文，BM25 也吃 filename
  const prefix = buildContextPrefix(path.basename(filePath), text);
  const chunks = rawChunks.map((c) => prefix + c);

  onProgress('parsing', 25, `共 ${chunks.length} 个文本块`);

  // 决定使用哪个 Provider
  const provider = await resolveEmbeddingProvider();
  const apiKey = await SecureStore.getApiKey(provider.id);
  if (!apiKey) throw new Error('请先在设置中配置 API Key');

  // 批量 Embedding
  const vectors: number[][] = [];
  const BATCH = 10;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    onProgress('embedding', 25 + (i / chunks.length) * 50, `Embedding ${i + 1}-${i + batch.length}/${chunks.length}`);
    const vecs = await Promise.all(batch.map((c) => embedText(provider, apiKey, c)));
    vectors.push(...vecs);
  }

  onProgress('storing', 85, '写入向量库');
  await addChunks(kbId, docId, path.basename(filePath), chunks, vectors);

  return chunks.length;
}

/**
 * OCR 自检：在内存里用 @napi-rs/canvas 画一张已知文字的测试图，丢给 tesseract worker 识别，
 * 用于「设置 → 常规 → 测试 OCR」按钮——独立验证 OCR 管线，不依赖真实 PDF。
 *
 * @returns ok / text / latencyMs / modelPath / error
 */
export async function runOcrSelfTest(): Promise<{
  ok: boolean;
  text: string;
  latencyMs: number;
  modelPath: string;
  error?: string;
}> {
  const t0 = Date.now();
  try {
    // 1) 准备 worker（首次会触发模型下载）
    const initT0 = Date.now();
    const worker = await getTesseractWorker();
    const initMs = Date.now() - initT0;

    // 2) 用 canvas 画一张测试图：黑底白字、字号大、行距足，确保 OCR 能稳定认出来
    const W = 800, H = 200;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 56px sans-serif';
    ctx.textBaseline = 'middle';
    // Tesseract 对英文/数字最稳，中文用 latin 转写避免默认字体无 CJK 字形而画成空格
    ctx.fillText('LocalRAG OCR Test 2026', 40, 70);
    ctx.font = 'bold 40px sans-serif';
    ctx.fillText('Hello World 12345', 40, 150);
    const png = canvas.toBuffer('image/png');

    // 3) 跑 OCR（同步调用 worker.recognize，不走进度回调避免噪音）
    const recogT0 = Date.now();
    const { data } = await worker.recognize(png);
    const recogMs = Date.now() - recogT0;

    const text = (data.text || '').trim();
    const latencyMs = Date.now() - t0;
    return {
      ok: text.length > 0,
      text,
      latencyMs,
      modelPath: tesseractCacheDir(),
      error: text.length > 0
        ? undefined
        : `识别为空（init=${initMs}ms, recog=${recogMs}ms）。可能原因：模型下载失败 / WASM 加载失败 / 系统字体使 tesseract 没法定位字形。`,
    };
  } catch (e) {
    return {
      ok: false,
      text: '',
      latencyMs: Date.now() - t0,
      modelPath: tesseractCacheDir(),
      error: (e as Error).message,
    };
  }
}

/** 导出占位以便上层兼容；当前实现已无 Python 桥接 */
export const PYTHON_BRIDGE = { enabled: false };

/** 根据设置选取可用于 Embedding 的 Provider */
export async function resolveEmbeddingProvider() {
  const settings = getSettings();
  const providers = listProviders();
  // 优先用专门的 embeddingProviderId；为空则回退到 defaultProviderId / 第一个
  let provider = providers.find((p) => p.id === settings.embeddingProviderId);
  if (!provider) provider = providers.find((p) => p.id === settings.defaultProviderId);
  if (!provider) provider = providers[0];
  if (!provider) throw new Error('尚未配置任何 AI Provider');
  return provider;
}

/** 删除某文档的所有向量 */
export async function deleteDocChunks(kbId: string, docId: string) {
  await deleteChunksByDoc(kbId, docId);
}
