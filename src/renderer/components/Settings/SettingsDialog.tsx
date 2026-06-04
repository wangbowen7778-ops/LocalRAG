/**
 * 设置对话框：Provider 管理 + 通用设置
 */
import { useState, useEffect } from 'react';
import type { ProviderConfig, Settings } from '../../types';
import { PROVIDER_PRESETS } from '../../../shared/constants';
import { api, toast } from '../../services/electronAPI';

interface Props {
  open: boolean;
  onClose: () => void;
  providers: ProviderConfig[];
  settings: Settings | null;
  onSave: (
    providers?: (Omit<ProviderConfig, 'hasApiKey'> & { apiKey?: string })[],
    settings?: Partial<Settings>,
  ) => Promise<void>;
}

type ProviderRow = Omit<ProviderConfig, 'hasApiKey'> & { apiKey?: string };

export function SettingsDialog({ open, onClose, providers, settings, onSave }: Props) {
  const [tab, setTab] = useState<'provider' | 'general'>('provider');
  const [list, setList] = useState<ProviderRow[]>([]);
  const [general, setGeneral] = useState<Partial<Settings>>({});

  useEffect(() => {
    if (!open) return;
    setList(
      providers.map((p) => ({
        id: p.id,
        label: p.label,
        baseUrl: p.baseUrl,
        chatModel: p.chatModel,
        embeddingModel: p.embeddingModel,
        reasoningModel: p.reasoningModel,
      })),
    );
    setGeneral(settings ?? {});
  }, [open, providers, settings]);

  if (!open) return null;

  const addProvider = (presetId: keyof typeof PROVIDER_PRESETS) => {
    const preset = PROVIDER_PRESETS[presetId];
    setList((l) => [
      ...l,
      {
        id: preset.id + '_' + Date.now().toString(36),
        label: preset.label,
        baseUrl: preset.baseUrl,
        chatModel: preset.chatModel,
        embeddingModel: preset.embeddingModel,
        reasoningModel: preset.reasoningModel,
        apiKey: '',
      },
    ]);
  };

  const updateRow = (idx: number, patch: Partial<(typeof list)[number]>) => {
    setList((l) => l.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  };

  const removeRow = (idx: number) => {
    setList((l) => l.filter((_, i) => i !== idx));
  };

  const testRow = async (idx: number) => {
    const row = list[idx];
    if (!row.baseUrl || !row.chatModel) {
      toast('error', '请先填写 Base URL 和 Chat 模型');
      return;
    }
    toast('info', '正在测试...');
    try {
      const r = await api.testProvider(
        {
          id: row.id,
          label: row.label,
          baseUrl: row.baseUrl,
          chatModel: row.chatModel,
          embeddingModel: row.embeddingModel,
          reasoningModel: row.reasoningModel,
        },
        row.apiKey,
      );
      toast(r.ok ? 'success' : 'error', `${r.message} (${r.latencyMs}ms)`);
    } catch (e: any) {
      const msg = e?.message || JSON.stringify(e);
      toast('error', `测试失败：${msg}`);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-surface-dark-2 rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="text-lg font-semibold">设置</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700">
            ×
          </button>
        </div>

        <div className="flex border-b border-slate-200 dark:border-slate-700 text-sm">
          {(['provider', 'general'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                'px-4 py-2 ' +
                (tab === t
                  ? 'border-b-2 border-primary-500 text-primary-500 font-semibold'
                  : 'text-slate-500')
              }
            >
              {t === 'provider' ? 'AI 服务' : '常规'}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'provider' && (
            <div className="space-y-3">
              {list.map((row, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded border border-slate-200 dark:border-slate-700 space-y-2"
                >
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      placeholder="显示名"
                      value={row.label}
                      onChange={(e) => updateRow(idx, { label: e.target.value })}
                      className="px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                    />
                    <input
                      placeholder="ID（唯一）"
                      value={row.id}
                      onChange={(e) => updateRow(idx, { id: e.target.value })}
                      className="px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                    />
                  </div>
                  <input
                    placeholder="Base URL"
                    value={row.baseUrl}
                    onChange={(e) => updateRow(idx, { baseUrl: e.target.value })}
                    className="w-full px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      placeholder="Chat 模型"
                      value={row.chatModel}
                      onChange={(e) => updateRow(idx, { chatModel: e.target.value })}
                      className="px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                    />
                    <input
                      placeholder="Embedding 模型"
                      value={row.embeddingModel}
                      onChange={(e) => updateRow(idx, { embeddingModel: e.target.value })}
                      className="px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                    />
                  </div>
                  <input
                    placeholder="Thinking 模型（可选，推理用）"
                    value={row.reasoningModel ?? ''}
                    onChange={(e) => updateRow(idx, { reasoningModel: e.target.value })}
                    className="w-full px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                  />
                  <input
                    type="password"
                    placeholder={providers.find((p) => p.id === row.id)?.hasApiKey ? '已保存（留空保持不变）' : 'API Key'}
                    value={row.apiKey ?? ''}
                    onChange={(e) => updateRow(idx, { apiKey: e.target.value })}
                    className="w-full px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => testRow(idx)}
                      className="text-xs px-3 py-1 rounded border border-primary-500 text-primary-500 hover:bg-primary-50"
                    >
                      测试连接
                    </button>
                    <button
                      onClick={() => removeRow(idx)}
                      className="text-xs px-3 py-1 rounded text-red-500 hover:bg-red-50"
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}

              <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200 dark:border-slate-700">
                <span className="text-xs text-slate-500 self-center">快速添加：</span>
                {Object.entries(PROVIDER_PRESETS).map(([k, v]) => (
                  <button
                    key={k}
                    onClick={() => addProvider(k as keyof typeof PROVIDER_PRESETS)}
                    className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700"
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {tab === 'general' && (
            <div className="space-y-3 text-sm">
              <Row label="主题">
                <select
                  value={general.theme ?? 'system'}
                  onChange={(e) => setGeneral((g) => ({ ...g, theme: e.target.value as any }))}
                  className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                >
                  <option value="system">跟随系统</option>
                  <option value="light">亮色</option>
                  <option value="dark">暗色</option>
                </select>
              </Row>
              <Row label="默认 Provider">
                <select
                  value={general.defaultProviderId ?? ''}
                  onChange={(e) => setGeneral((g) => ({ ...g, defaultProviderId: e.target.value }))}
                  className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                >
                  <option value="">（不指定）</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Embedding Provider">
                <select
                  value={general.embeddingProviderId ?? ''}
                  onChange={(e) => setGeneral((g) => ({ ...g, embeddingProviderId: e.target.value }))}
                  className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                >
                  <option value="">（与 Chat 共用）</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Row>
              <div className="text-xs text-slate-500 -mt-1 px-1 leading-relaxed">
                Embedding 是「把文本转成向量数字」的能力，用于相似度检索，与 Chat 回答问题是不同的接口。
                DeepSeek 只提供 Chat，没有 Embedding 接口——如果你只用 DeepSeek，请新增一个 OpenAI / 通义千问 Provider 并在此选择它作为 Embedding Provider。
              </div>
              <Row label="Chunk Size">
                <input
                  type="number"
                  min={100}
                  max={2000}
                  value={general.chunkSize ?? 500}
                  onChange={(e) => setGeneral((g) => ({ ...g, chunkSize: +e.target.value }))}
                  className="w-24 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                />
              </Row>
              <Row label="Chunk Overlap">
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={general.chunkOverlap ?? 50}
                  onChange={(e) => setGeneral((g) => ({ ...g, chunkOverlap: +e.target.value }))}
                  className="w-24 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                />
              </Row>
              <Row label="Top-K">
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={general.topK ?? 5}
                  onChange={(e) => setGeneral((g) => ({ ...g, topK: +e.target.value }))}
                  className="w-24 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                />
              </Row>
              <Row label="Temperature">
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={general.temperature ?? 0.7}
                  onChange={(e) => setGeneral((g) => ({ ...g, temperature: +e.target.value }))}
                  className="w-24 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                />
              </Row>
              <Row label="语言">
                <select
                  value={general.language ?? 'zh-CN'}
                  onChange={(e) => setGeneral((g) => ({ ...g, language: e.target.value as any }))}
                  className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                >
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English</option>
                </select>
              </Row>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded text-sm text-slate-600 hover:bg-slate-100"
          >
            取消
          </button>
          <button
            onClick={async () => {
              // 同时保存 provider 列表和通用设置（不再依赖当前 tab，
              // 避免用户在 general 标签下点保存时漏掉 provider 改动）
              await onSave(list, Object.keys(general).length > 0 ? general : undefined);
            }}
            className="px-4 py-2 rounded text-sm bg-primary-500 text-white hover:bg-primary-600"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-slate-600 dark:text-slate-300">{label}</span>
      {children}
    </div>
  );
}
