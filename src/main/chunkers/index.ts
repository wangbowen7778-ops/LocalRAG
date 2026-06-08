/**
 * 切片分发器：按输入类型挑 chunker
 *
 * 两种入参：
 * - markdown：原始 markdown 字符串 → markdown 结构感知（B+A+C）
 * - plain：纯文本（DOCX/TXT 解析产物、OCR 后的 PDF、或 PDF 经 pdfItemsToText 重建后的文本）→ recursive（A+C）
 *
 * PDF 文本层调用方先跑 pdfItemsToText 把 items 重建为带段落的纯文本再传入本函数。
 * 这是因为上层（document-processor）还要拿这份文本构造文档级 prefix。
 */
import { recursiveSplit, type RecursiveOptions } from './recursive';
import { markdownChunk } from './markdown';

export type ChunkInput =
  | { type: 'markdown'; text: string }
  | { type: 'plain'; text: string };

export function chunkDocument(input: ChunkInput, opts: RecursiveOptions): string[] {
  if (input.type === 'plain') {
    return recursiveSplit(input.text, opts);
  }
  // markdown：先试结构感知切分；遇到 marked 输出异常（罕见 markdown 边角
  // 触发 "Cannot read properties of undefined (reading 'items'|'rows')" 等）
  // 时静默回退到 recursive，文档仍可入库（只是丢掉标题面包屑）
  try {
    return markdownChunk(input.text, opts);
  } catch (e) {
    console.warn(`[chunkers] markdown 结构感知失败，回退到 recursive：${(e as Error).message}`);
    return recursiveSplit(input.text, opts);
  }
}

export { recursiveSplit, markdownChunk };
export { pdfItemsToText, type PdfItemsContext, type PdfTextItem } from './pdf-layout';
export type { RecursiveOptions };
