/**
 * 侧边栏：知识库列表 + 顶部操作
 * - 单选模式：点击 KB 设为 active（默认）
 * - 多选模式：勾选多个 KB 喂给 Agent 跨 KB 检索
 * - 创建 KB 时可填 description（Agent 模式下 LLM 用它判断 KB 相关性）
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
  /** 多选模式：是否开启 */
  multiSelectMode: boolean;
  onToggleMultiSelect: () => void;
  /** 多选模式：当前勾选的 KB id 集合 */
  selectedIds: Set<string>;
  onToggleKB: (id: string) => void;
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
  multiSelectMode,
  onToggleMultiSelect,
  selectedIds,
  onToggleKB,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const resetCreate = () => {
    setCreating(false);
    setName('');
    setDescription('');
  };

  const submitCreate = async () => {
    if (!name.trim()) return;
    await onCreate(name.trim(), description.trim() || undefined);
    resetCreate();
  };

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

      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 text-xs flex items-center gap-2">
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={multiSelectMode}
            onChange={onToggleMultiSelect}
            className="cursor-pointer"
          />
          <span className="text-slate-600 dark:text-slate-300">跨 KB 检索</span>
        </label>
        {multiSelectMode && (
          <span className="text-slate-500">已选 {selectedIds.size}</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {kbs.length === 0 && !creating && (
          <div className="px-4 text-sm text-slate-500 mt-8 text-center">
            还没有知识库
            <br />
            点击「＋ 新建」开始
          </div>
        )}

        {kbs.map((kb) => {
          const isSelected = multiSelectMode && selectedIds.has(kb.id);
          const isActive = !multiSelectMode && activeKB?.id === kb.id;
          return (
            <div
              key={kb.id}
              className={
                'group mx-2 my-1 px-3 py-2 rounded cursor-pointer flex items-center gap-2 ' +
                (isActive
                  ? 'bg-primary-50 dark:bg-primary-700/30 text-primary-700 dark:text-primary-200'
                  : isSelected
                  ? 'bg-amber-50 dark:bg-amber-900/20 ring-1 ring-amber-400'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-700/50')
              }
              onClick={() => {
                if (multiSelectMode) {
                  onToggleKB(kb.id);
                } else {
                  onSelect(kb);
                }
              }}
              onDoubleClick={() => !multiSelectMode && setEditingId(kb.id)}
            >
              {multiSelectMode && (
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggleKB(kb.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="cursor-pointer"
                />
              )}
              <div className="flex-1 min-w-0">
                {editingId === kb.id ? (
                  <input
                    autoFocus
                    defaultValue={kb.name}
                    className="w-full bg-transparent border-b border-primary-500 outline-none text-sm"
                    onBlur={async (e) => {
                      await onRename(kb.id, e.target.value.trim() || kb.name);
                      setEditingId(null);
                    }}
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter') {
                        await onRename(
                          kb.id,
                          (e.target as HTMLInputElement).value.trim() || kb.name,
                        );
                        setEditingId(null);
                      }
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <>
                    <div className="text-sm truncate">{kb.name}</div>
                    {kb.description && (
                      <div className="text-xs text-slate-500 truncate" title={kb.description}>
                        {kb.description}
                      </div>
                    )}
                    {!kb.description && (
                      <div className="text-xs text-slate-500">{kb.docCount} 文档</div>
                    )}
                  </>
                )}
              </div>
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
          );
        })}

        {creating && (
          <div className="mx-2 my-2 p-3 rounded border border-primary-300 bg-primary-50 dark:bg-primary-700/20 space-y-2">
            <input
              autoFocus
              placeholder="知识库名称"
              className="w-full px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter') await submitCreate();
                if (e.key === 'Escape') resetCreate();
              }}
            />
            <textarea
              placeholder="描述（可选；Agent 模式下 LLM 会用它判断是否相关）"
              className="w-full px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark resize-none"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                onClick={submitCreate}
                className="text-xs px-2 py-1 rounded bg-primary-500 text-white"
              >
                创建
              </button>
              <button onClick={resetCreate} className="text-xs px-2 py-1 rounded text-slate-500">
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
