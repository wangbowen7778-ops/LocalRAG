/**
 * 文档面板：列表 + 上传 + 进度
 */
import type { Document, DocProgressEvent, KnowledgeBase } from '../../types';
import { LoadingSpinner } from '../Common/LoadingSpinner';

interface Props {
  activeKB: KnowledgeBase | null;
  docs: Document[];
  progressMap: Record<string, DocProgressEvent>;
  onUpload: () => void;
  onDelete: (docId: string) => void;
}

export function DocumentPanel({ activeKB, docs, progressMap, onUpload, onDelete }: Props) {
  if (!activeKB) {
    return (
      <div className="w-72 border-l border-slate-200 dark:border-slate-700 p-4 text-sm text-slate-500 flex items-center justify-center">
        请先选择知识库
      </div>
    );
  }

  return (
    <div className="w-72 border-l border-slate-200 dark:border-slate-700 flex flex-col bg-slate-50 dark:bg-surface-dark-2 h-full min-h-0">
      <div className="p-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
        <span className="text-sm font-semibold">文档</span>
        <button
          onClick={onUpload}
          className="text-xs px-2 py-1 rounded bg-primary-500 text-white hover:bg-primary-600"
        >
          + 上传
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {docs.length === 0 && (
          <div className="text-xs text-slate-500 text-center py-8">
            暂无文档
            <br />
            支持 PDF / DOCX / MD / TXT
          </div>
        )}
        {docs.map((d) => {
          const p = progressMap[d.id];
          return (
            <div
              key={d.id}
              className="p-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-surface-dark"
            >
              <div className="flex items-center justify-between">
                <div className="text-sm truncate flex-1" title={d.filename}>
                  {d.filename}
                </div>
                <button
                  onClick={() => {
                    if (confirm(`删除「${d.filename}」？`)) onDelete(d.id);
                  }}
                  className="text-xs text-red-500 hover:text-red-700 ml-2"
                >
                  ×
                </button>
              </div>
              <div className="flex items-center gap-2 mt-1">
                {d.status === 'processing' || p ? (
                  <>
                    <LoadingSpinner size={12} />
                    <div className="flex-1 h-1 bg-slate-200 dark:bg-slate-700 rounded">
                      <div
                        className="h-full bg-primary-500 rounded transition-all"
                        style={{ width: `${p?.percent ?? 30}%` }}
                      />
                    </div>
                    <span className="text-xs text-slate-500">
                      {p?.stage === 'parsing' ? '解析' : p?.stage === 'embedding' ? 'Embedding' : p?.stage === 'storing' ? '存储' : '完成'}
                    </span>
                  </>
                ) : (
                  <span
                    className={
                      'text-xs ' +
                      (d.status === 'ready'
                        ? 'text-emerald-500'
                        : d.status === 'failed'
                        ? 'text-red-500'
                        : 'text-slate-500')
                    }
                  >
                    {d.status === 'ready'
                      ? `${d.chunkCount} 片段`
                      : d.status === 'failed'
                      ? `失败：${d.errorMessage ?? ''}`
                      : '等待中'}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
