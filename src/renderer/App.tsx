/**
 * 主应用：组合三栏布局 + 全局 Toast
 */
import { useState, useEffect } from 'react';
import { Sidebar } from './components/Layout/Sidebar';
import { ChatArea } from './components/Layout/ChatArea';
import { DocumentPanel } from './components/Layout/DocumentPanel';
import { SettingsDialog } from './components/Settings/SettingsDialog';
import { useKnowledgeBase } from './hooks/useKnowledgeBase';
import { useSettings } from './hooks/useSettings';
import { onToast } from './services/electronAPI';

interface ToastItem {
  id: number;
  level: 'info' | 'success' | 'warn' | 'error';
  text: string;
}

export default function App() {
  const kb = useKnowledgeBase();
  const settings = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [docPanelOpen, setDocPanelOpen] = useState(true);

  // 全局 toast 订阅
  useEffect(() => {
    return onToast((level, text) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t, { id, level, text }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
    });
  }, []);

  // 首次启动：未配置 Provider 时弹出设置
  useEffect(() => {
    if (settings.providers.length === 0) {
      setSettingsOpen(true);
    }
  }, [settings.providers.length]);

  return (
    <div className="h-screen w-screen flex bg-slate-50 dark:bg-surface-dark text-slate-900 dark:text-slate-100 overflow-hidden">
      <Sidebar
        kbs={kb.kbs}
        activeKB={kb.activeKB}
        onSelect={(selected) => kb.setActiveKB(selected)}
        onCreate={async (name, description) => (await kb.create(name, description)) ?? undefined}
        onDelete={kb.remove}
        onRename={kb.rename}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenDataDir={() => window.api.app.openDataDir()}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-12 flex items-center justify-between px-4 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-surface-dark-2">
          <div className="flex items-center gap-3">
            <h1 className="font-semibold text-base">
              {kb.activeKB?.name ?? 'LocalRAG'}
            </h1>
            {kb.activeKB && (
              <span className="text-xs text-slate-500">
                {kb.activeKB.docCount} 文档 · {kb.activeKB.chunkCount} 片段
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="text-xs px-3 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700"
              onClick={() => setDocPanelOpen((v) => !v)}
            >
              {docPanelOpen ? '隐藏文档' : '显示文档'}
            </button>
          </div>
        </header>

        <main className="flex-1 flex min-h-0">
          <div className="flex-1 min-w-0 h-full min-h-0">
            <ChatArea
              activeKB={kb.activeKB}
              providers={settings.providers}
              onNeedProvider={() => setSettingsOpen(true)}
            />
          </div>
          {docPanelOpen && (
            <DocumentPanel
              activeKB={kb.activeKB}
              docs={kb.docs}
              progressMap={kb.progressMap}
              onUpload={() => kb.activeKB && kb.upload(kb.activeKB.id)}
              onDelete={kb.removeDoc}
            />
          )}
        </main>
      </div>

      <SettingsDialog
        key={`settings-${settingsOpen}-${settings.providers.length}-${settings.providers.map((p) => p.id).join('|')}`}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        providers={settings.providers}
        settings={settings.settings}
        onSave={async (p, s) => {
          if (p) {
            // 先 upsert 新列表里的 provider
            for (const x of p) await window.api.provider.upsert(x);
            // 再删 DB 里有但新列表里没有的 provider（修复「删除按钮没真删」bug）
            const existing = settings.providers;
            const newIds = new Set(p.map((x) => x.id));
            for (const old of existing) {
              if (!newIds.has(old.id)) await window.api.provider.delete(old.id);
            }
          }
          if (s) await settings.update(s);
          await settings.refresh();
          await kb.refresh();
          setSettingsOpen(false);
        }}
      />

      {/* Toast 列表 */}
      <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              'px-4 py-2 rounded shadow text-sm animate-fade-in ' +
              (t.level === 'error'
                ? 'bg-red-500 text-white'
                : t.level === 'warn'
                ? 'bg-amber-500 text-white'
                : t.level === 'success'
                ? 'bg-emerald-500 text-white'
                : 'bg-slate-700 text-white')
            }
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
