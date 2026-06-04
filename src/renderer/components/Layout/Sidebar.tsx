/**
 * 侧边栏：知识库列表 + 顶部操作
 */
import { useState } from 'react';
import type { KnowledgeBase } from '../../types';

interface Props {
  kbs: KnowledgeBase[];
  activeKB: KnowledgeBase | null;
  onSelect: (kb: KnowledgeBase) => void;
  onCreate: (name: string, description?: string) => Promise<KnowledgeBase | undefined>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onOpenSettings: () => void;
  onOpenDataDir: () => void;
}

export function Sidebar({
  kbs,
  activeKB,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onOpenSettings,
  onOpenDataDir,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <aside className="w-60 shrink-0 border-r border-slate-200 dark:border-slate-700 bg-white dark:bg-surface-dark-2 flex flex-col">
      <div className="h-12 flex items-center justify-between px-4 border-b border-slate-200 dark:border-slate-700">
        <span className="font-bold text-primary-500">LocalRAG</span>
        <button
          onClick={() => setCreating(true)}
          className="text-xs px-2 py-1 rounded bg-primary-500 text-white hover:bg-primary-600"
        >
          ＋ 新建
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {kbs.length === 0 && !creating && (
          <div className="px-4 text-sm text-slate-500 mt-8 text-center">
            还没有知识库
            <br />
            点击「＋ 新建」开始
          </div>
        )}

        {kbs.map((kb) => (
          <div
            key={kb.id}
            className={
              'group mx-2 my-1 px-3 py-2 rounded cursor-pointer flex items-center justify-between ' +
              (activeKB?.id === kb.id
                ? 'bg-primary-50 dark:bg-primary-700/30 text-primary-700 dark:text-primary-200'
                : 'hover:bg-slate-100 dark:hover:bg-slate-700/50')
            }
            onClick={() => onSelect(kb)}
            onDoubleClick={() => setEditingId(kb.id)}
          >
            {editingId === kb.id ? (
              <input
                autoFocus
                defaultValue={kb.name}
                className="flex-1 bg-transparent border-b border-primary-500 outline-none text-sm"
                onBlur={async (e) => {
                  await onRename(kb.id, e.target.value.trim() || kb.name);
                  setEditingId(null);
                }}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter') {
                    await onRename(kb.id, (e.target as HTMLInputElement).value.trim() || kb.name);
                    setEditingId(null);
                  }
                  if (e.key === 'Escape') setEditingId(null);
                }}
              />
            ) : (
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{kb.name}</div>
                <div className="text-xs text-slate-500">{kb.docCount} 文档</div>
              </div>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`删除「${kb.name}」及其所有文档？`)) onDelete(kb.id);
              }}
              className="opacity-0 group-hover:opacity-100 text-xs text-red-500 hover:text-red-700"
            >
              ×
            </button>
          </div>
        ))}

        {creating && (
          <div className="mx-2 my-2 p-3 rounded border border-primary-300 bg-primary-50 dark:bg-primary-700/20">
            <input
              autoFocus
              placeholder="知识库名称"
              className="w-full px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && name.trim()) {
                  await onCreate(name.trim());
                  setName('');
                  setCreating(false);
                }
                if (e.key === 'Escape') setCreating(false);
              }}
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={async () => {
                  if (name.trim()) {
                    await onCreate(name.trim());
                    setName('');
                    setCreating(false);
                  }
                }}
                className="text-xs px-2 py-1 rounded bg-primary-500 text-white"
              >
                创建
              </button>
              <button
                onClick={() => {
                  setCreating(false);
                  setName('');
                }}
                className="text-xs px-2 py-1 rounded text-slate-500"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-slate-200 dark:border-slate-700 p-2 flex flex-col gap-1">
        <button
          onClick={onOpenSettings}
          className="text-left text-sm px-3 py-2 rounded hover:bg-slate-100 dark:hover:bg-slate-700/50"
        >
          ⚙️ 设置
        </button>
        <button
          onClick={onOpenDataDir}
          className="text-left text-sm px-3 py-2 rounded hover:bg-slate-100 dark:hover:bg-slate-700/50"
        >
          📁 数据目录
        </button>
      </div>
    </aside>
  );
}
