/**
 * 文档分块查看器：列出某文档被向量化的所有 chunk 完整文本
 * - 用来验证「文档截断」到底是数据问题还是 LLM 风格选择
 * - 也方便排查 OCR / 分块参数效果
 */
import { useEffect, useState, useMemo } from 'react';
import type { Document } from '../../types';

export interface DocChunk {
  chunkIndex: number;
  text: string;
}

interface Props {
  open: boolean;
  doc: Document | null;
  chunks: DocChunk[] | null;
  loading: boolean;
  onClose: () => void;
}

export function ChunkViewerDialog({ open, doc, chunks, loading, onClose }: Props) {
  const [filter, setFilter] = useState('');
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!open) {
      setFilter('');
      setCopiedIdx(null);
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!chunks) return [];
    const q = filter.trim();
    if (!q) return chunks;
    return chunks.filter((c) => c.text.toLowerCase().includes(q.toLowerCase()));
  }, [chunks, filter]);

  if (!open || !doc) return null;

  const totalChars = chunks?.reduce((sum, c) => sum + c.text.length, 0) ?? 0;

  const copyChunk = async (idx: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1200);
    } catch {
      // 忽略
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-surface-dark-2 rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold truncate" title={doc.filename}>
              分块：{doc.filename}
            </h2>
            <div className="text-xs text-slate-500 mt-0.5">
              {loading
                ? '加载中…'
                : chunks
                ? `${chunks.length} 个片段 · 共 ${totalChars.toLocaleString()} 字`
                : ''}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700 text-xl px-2">
            ×
          </button>
        </div>

        <div className="p-3 border-b border-slate-200 dark:border-slate-700">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="在分块内搜索…"
            className="w-full px-3 py-1.5 text-sm rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loading && (
            <div className="text-sm text-slate-500 text-center py-8">加载中…</div>
          )}
          {!loading && chunks && chunks.length === 0 && (
            <div className="text-sm text-slate-500 text-center py-8">
              该文档尚无分块（可能还在处理中或解析失败）
            </div>
          )}
          {!loading && filtered.length === 0 && chunks && chunks.length > 0 && (
            <div className="text-sm text-slate-500 text-center py-8">无匹配分块</div>
          )}
          {filtered.map((c) => (
            <div
              key={c.chunkIndex}
              className="rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-surface-dark"
            >
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 dark:border-slate-800 text-xs text-slate-500">
                <span>
                  片段 #{c.chunkIndex + 1} · {c.text.length.toLocaleString()} 字
                </span>
                <button
                  onClick={() => copyChunk(c.chunkIndex, c.text)}
                  className="text-primary-500 hover:text-primary-600"
                >
                  {copiedIdx === c.chunkIndex ? '已复制' : '复制'}
                </button>
              </div>
              <pre className="px-3 py-2 text-sm whitespace-pre-wrap break-words font-sans text-slate-800 dark:text-slate-200">
                {c.text}
              </pre>
            </div>
          ))}
        </div>

        <div className="p-3 border-t border-slate-200 dark:border-slate-700 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded text-sm text-slate-600 hover:bg-slate-100"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
