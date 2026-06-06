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
              <Row label="OCR 识别（扫描件）">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={general.enableOcr ?? false}
                    onChange={(e) => setGeneral((g) => ({ ...g, enableOcr: e.target.checked }))}
                  />
                  <span className="text-xs text-slate-600 dark:text-slate-300">
                    对扫描件 PDF 自动 OCR
                  </span>
                </label>
              </Row>
              <div className="text-xs text-slate-500 -mt-1 px-1 leading-relaxed">
                开启后，纯文字提取失败的 PDF（扫描件 / 图片型）会自动 fallback 到本地 OCR（tesseract.js）。
                首次使用需联网下载中文 + 英文语言模型（~23MB），之后离线可用，识别 1-3 秒/页。
                关闭则保持纯文本提取，不下载模型、不占内存。
              </div>
              <Row label="混合检索 (BM25)">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={general.enableBm25 !== false}
                    onChange={(e) => setGeneral((g) => ({ ...g, enableBm25: e.target.checked }))}
                  />
                  <span className="text-xs text-slate-600 dark:text-slate-300">
                    向量 + BM25 双路融合（推荐）
                  </span>
                </label>
              </Row>
              <div className="text-xs text-slate-500 -mt-1 px-1 leading-relaxed">
                向量检索擅长语义相似（"忘记密码" ≈ "如何重置密码"），但对<strong>精确术语、错误码、API 名</strong>易失真。
                BM25 是经典词频检索，弥补上述短板，两路结果用 RRF 融合。
                关闭后仅用向量检索。v1.1.6 之前的老文档会在下次启动时自动回填 BM25 索引。
              </div>

              <Row label="Agent 模式 (v1.2.0)">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={general.enableAgent ?? false}
                    onChange={(e) => setGeneral((g) => ({ ...g, enableAgent: e.target.checked }))}
                  />
                  <span className="text-xs text-slate-600 dark:text-slate-300">
                    启用 Agentic RAG（function_calling + 多轮迭代 + 跨 KB）
                  </span>
                </label>
              </Row>
              <div className="text-xs text-slate-500 -mt-1 px-1 leading-relaxed">
                关闭时与旧版行为一致（单轮混合检索 + 直接生成）。开启后 LLM 可以自主决定：
                是否检索、用什么子问题检索、检索几次、信息够不够。
                需要 Provider 支持 <strong>function_calling</strong>（OpenAI / DeepSeek / 通义千问 / 硅基流动 均支持）。
                Agent 模式首问会比简单模式慢 2-5 秒，可在 ChatArea 顶部临时切换。
              </div>
              <Row label="最大迭代次数">
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={general.agentMaxIterations ?? 4}
                  onChange={(e) =>
                    setGeneral((g) => ({ ...g, agentMaxIterations: +e.target.value }))
                  }
                  className="w-24 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                />
              </Row>
              <div className="text-xs text-slate-500 -mt-1 px-1 leading-relaxed">
                LLM 最多循环几次「检索 → 评估」。超过自动进入"基于已收集资料直接回答"模式，
                不会死循环。建议 3-5。值越大越可能用更多 token，越小越快。
              </div>
              <Row label="LLM 自选 KB">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={general.enableKBSelector !== false}
                    onChange={(e) =>
                      setGeneral((g) => ({ ...g, enableKBSelector: e.target.checked }))
                    }
                  />
                  <span className="text-xs text-slate-600 dark:text-slate-300">
                    把 KB 描述喂给 LLM 让它自己挑
                  </span>
                </label>
              </Row>
              <div className="text-xs text-slate-500 -mt-1 px-1 leading-relaxed">
                启用后，多 KB 场景下第一轮会先问一次 LLM"哪些 KB 可能相关"，只检索选中的。
                关闭则检索全部已选 KB。给 KB 加<strong>准确的 description</strong>（在左侧新建时填写）效果更佳。
              </div>
              <Row label="单次检索 Top-K">
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={general.agentTopKPerQuery ?? 5}
                  onChange={(e) =>
                    setGeneral((g) => ({ ...g, agentTopKPerQuery: +e.target.value }))
                  }
                  className="w-24 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark"
                />
              </Row>
              <div className="text-xs text-slate-500 -mt-1 px-1 leading-relaxed">
                每次子问题检索召回的片段数（多 KB 融合后取 topK）。
                值越大 LLM 看到越多上下文（也越费 token），越小越精炼。
              </div>
              <div className="flex items-center gap-2 pl-1">
                <button
                  onClick={async () => {
                    toast('info', '正在跑 OCR 自检（首次会下载 ~23MB 模型）...');
                    try {
                      const r = await api.ocrTest();
                      if (r.ok) {
                        toast(
                          'success',
                          `OCR 正常 (${r.latencyMs}ms)：${r.text.slice(0, 60) || '（识别为空）'}`,
                        );
                      } else {
                        toast('error', `OCR 失败：${r.error || '未知错误'}（${r.latencyMs}ms）`);
                      }
                    } catch (e: any) {
                      toast('error', `OCR 自检调用失败：${e?.message || JSON.stringify(e)}`);
                    }
                  }}
                  className="text-xs px-3 py-1 rounded border border-primary-500 text-primary-500 hover:bg-primary-50"
                >
                  测试 OCR
                </button>
                <span className="text-xs text-slate-500">
                  独立验证 OCR 管线（不依赖 PDF）
                </span>
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
              <Row label="引用分数阈值">
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={general.citationScoreThreshold ?? 0.4}
                    onChange={(e) =>
                      setGeneral((g) => ({ ...g, citationScoreThreshold: +e.target.value }))
                    }
                    className="w-24"
                  />
                  <span className="text-xs text-slate-600 dark:text-slate-300 w-10 text-right">
                    {(general.citationScoreThreshold ?? 0.4).toFixed(2)}
                  </span>
                </div>
              </Row>
              <div className="text-xs text-slate-500 -mt-1 px-1 leading-relaxed">
                相似度阈值。检索结果中分数低于此值的片段不会喂给 LLM、也不会展示为引用。
                设为 0 关闭过滤。
                <strong>纯向量</strong>：cosine similarity，OpenAI / 多数模型相关片段通常 0.5+，可以拉到 0.5-0.6 解决"多个相似文档都引用了"的问题。
                <strong>混合检索</strong>：score 已归一化到 [0,1]（1.0 = 两路都最强，0.5 = 单路最强），
                0.4 ≈ "至少一路进 top 1-2"；想更严格调到 0.5，想更宽松调到 0.2。
              </div>
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
