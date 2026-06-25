/**
 * 检索结果 preview 格式化（v1.2.7 新增）
 *
 * v1.2.4 把每个 hit 截 200 字符 + `…` 喂给 LLM，但 LLM 经常把 `…` 当成自然结尾，
 * 不去调 read_chunk 拿全文——结果是 LLM 基于截断的 preview 回答，漏掉后面的内容。
 * 用户实测："第十三条 (一)~(六) 条款" 漏答 (六) 设立分支机构，就是 preview 200 字符被截在
 * "（五）变更持股5%以上的股东，变更…" 之后 LLM 以为这就是全部。
 *
 * v1.2.7 修复——三件套：
 * 1. preview 末尾加显式 `[TRUNCATED: 共 N 字，仅显示前 M 字]` 标记
 *    ——让 LLM 一眼能看出"这里被砍了 K 字"
 * 2. 配合 system prompt 硬规则（"preview 末尾有 [TRUNCATED...] 标记 + 内容像条款/列举/编号
 *    → 必须先 read_chunk 才能引用"）——强制 LLM 在列举型内容上不偷懒
 * 3. Citation.chunk 改存全文（不只是 200 字符）——UI 引用来源、readContext 备份上下文
 *    都能看到完整内容
 *
 * 调用方：
 * - `src/main/ipc-handlers.ts::runSimpleChatWithTools`（简单模式）
 * - `src/main/agent.ts` 主循环 `search_kb` 工具响应（Agent 模式）
 *
 * 自检：scripts/citation-preview-selftest.js
 */

export interface ChunkPreviewInput {
  docId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  score: number;
}

const PREVIEW_MAX_CHARS = 200;

/**
 * 格式化单条检索 hit 的 preview（给 LLM 看的"索引 + 节选"）
 *
 * 输出格式：
 *   [#N 文件名 | score=0.85]
 *   Preview: <前 200 字>
 *   [TRUNCATED: 共 380 字，仅显示前 200 字；列举/条款/编号型内容请先 read_chunk(N)]
 *
 * 关键设计点：
 * - `…` 单独使用容易被 LLM 当成自然结尾——必须配合 `[TRUNCATED: 共 N 字...]` 才显眼
 * - "列举/条款/编号型内容请先 read_chunk(N)" 是 LLM 直接可执行的指令
 * - text.length <= 200 时不加 TRUNCATED 标记（避免 LLM 在短问题上多调 read_chunk）
 */
export function formatChunkPreview(hit: ChunkPreviewInput, chunkId: string): string {
  const previewText = hit.text.slice(0, PREVIEW_MAX_CHARS);
  const isTruncated = hit.text.length > PREVIEW_MAX_CHARS;
  const header = `[#${chunkId} ${hit.filename} | score=${hit.score.toFixed(2)}]`;
  const preview = `Preview: ${previewText}${isTruncated ? '…' : ''}`;
  if (!isTruncated) {
    return `${header}\n${preview}`;
  }
  const truncationNote = `[TRUNCATED: 共 ${hit.text.length} 字，仅显示前 ${PREVIEW_MAX_CHARS} 字；列举/条款/编号型内容请先 read_chunk(${chunkId}) 取完整内容再引用]`;
  return `${header}\n${preview}\n${truncationNote}`;
}

/**
 * 构造 previewLines（多条 hit 拼接）
 * 调用方负责 join('\n\n') 和在末尾追加"调 read_chunk"提示
 */
export function buildPreviewLines(hits: ChunkPreviewInput[]): string[] {
  return hits.map((h, idx) => formatChunkPreview(h, String(idx + 1)));
}
