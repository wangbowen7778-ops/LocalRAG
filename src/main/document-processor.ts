/**
 * 文档处理：解析 → 分块 → Embedding → 写入 Vectra 本地索引
 * 支持 PDF / DOCX / MD / TXT
 */
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore - 没有官方类型
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { marked } from 'marked';
import iconv from 'iconv-lite';
import { listProviders } from './storage';
import { SecureStore } from './secure-store';
import { embedText } from './api-client';
import { addChunks, deleteChunksByDoc } from './vector-store';
import { getSettings } from './storage';
import type { DocProgressEvent } from '../shared/types';

interface ProcessParams {
  docId: string;
  kbId: string;
  filePath: string;
  mimeType: string;
  onProgress: (stage: DocProgressEvent['stage'], percent: number, message?: string) => void;
}

/** 解析文档为纯文本 */
async function extractText(filePath: string, mimeType: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);

  if (ext === '.pdf' || mimeType === 'application/pdf') {
    const data = await pdfParse(buf);
    return data.text;
  }

  if (ext === '.docx' || mimeType.includes('officedocument')) {
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value;
  }

  if (ext === '.md' || mimeType === 'text/markdown') {
    const html = await marked.parse(buf.toString('utf-8'));
    // 简单去除 HTML 标签
    return html.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n');
  }

  // 兜底当作 txt
  // 自动识别编码（GBK / UTF-8）
  if (buf[0] === 0xff && buf[1] === 0xfe) return iconv.decode(buf, 'utf-16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return iconv.decode(buf, 'utf-16be');
  if (buf[0] === 0xef && buf[1] === 0xbb) return buf.toString('utf-8');
  // 简单尝试 GBK，回退 UTF-8
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
 * 处理并入库
 * @returns 实际写入的块数
 */
export async function processAndIndexDoc(params: ProcessParams): Promise<number> {
  const { docId, kbId, filePath, onProgress } = params;
  onProgress('parsing', 5, '解析文档');

  const text = await extractText(filePath, params.mimeType);
  if (!text || text.length < 10) {
    throw new Error('文档内容为空或无法解析');
  }

  const settings = getSettings();
  const chunks = splitChunks(text, settings.chunkSize, settings.chunkOverlap);
  if (chunks.length === 0) throw new Error('分块后无内容');

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
