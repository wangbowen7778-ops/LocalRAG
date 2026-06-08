/**
 * Agentic RAG 思考过程折叠展示
 *
 * 显示规则：
 * - 默认折叠（避免打扰普通问答）
 * - 流式 build 阶段：显示"思考中（已完成 N 步）"+ spinner
 * - 完成态：显示"已思考 N 步 · 跨 KB · 1234ms"
 * - 展开后按时间顺序列出每步：icon + 标题 + 工具名 + 耗时 + 思考 + 子问题 + 命中数
 */
import { useState } from 'react';
import type { AgentStep, AgentTrace } from '../../../shared/types';
import { LoadingSpinner } from '../Common/LoadingSpinner';

interface Props {
  trace: AgentTrace;
  /** 流式 build 阶段传 true（显示 spinner + 进行中阶段） */
  pending?: boolean;
  /** 当前阶段文字（来自 streamingPhase） */
  activePhase?: string;
}

const KIND_META: Record<AgentStep['kind'], { icon: string; title: string }> = {
  plan: { icon: '🧭', title: '规划' },
  search: { icon: '🔍', title: '检索' },
  skip: { icon: '⏭️', title: '跳过检索' },
  critique: { icon: '🪞', title: '评估' },
};

export function AgentTraceView({ trace, pending, activePhase }: Props) {
  const [open, setOpen] = useState(false);
  const total = trace.steps.length;

  return (
    <div className="mb-2 pb-2 border-b border-slate-200 dark:border-slate-600 text-xs">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 cursor-pointer"
      >
        <span
          className={'inline-block transition-transform select-none ' + (open ? 'rotate-90' : '')}
        >
          ▶
        </span>
        {pending ? (
          <span className="flex items-center gap-1.5">
            <LoadingSpinner size={10} />
            {activePhase || '思考中'}（已完成 {total} 步）
          </span>
        ) : (
          <span>
            已思考 {total} 步{trace.didKBSelection ? ' · 跨 KB' : ''} ·{' '}
            {(trace.totalLatencyMs / 1000).toFixed(1)}s
          </span>
        )}
      </button>

      {open && (
        <ol className="mt-2 space-y-1.5 pl-3 border-l-2 border-slate-200 dark:border-slate-700">
          {trace.steps.map((s, i) => (
            <li key={i}>
              <StepView step={s} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function StepView({ step }: { step: AgentStep }) {
  const meta = KIND_META[step.kind] ?? { icon: '•', title: step.kind };

  return (
    <div className="leading-relaxed">
      <div className="font-mono text-slate-500">
        <span className="mr-1">{meta.icon}</span>
        {meta.title}
        {step.toolName && <span className="ml-1 text-slate-400">→ {step.toolName}</span>}
        {step.latencyMs !== undefined && step.latencyMs > 0 && (
          <span className="ml-1 text-slate-400">({step.latencyMs}ms)</span>
        )}
      </div>
      {step.thought && (
        <div className="text-slate-600 dark:text-slate-300 mt-0.5 italic">"{step.thought}"</div>
      )}
      {step.subQueries && step.subQueries.length > 0 && (
        <div className="text-slate-500 mt-0.5">
          子问题：<span className="font-mono">{step.subQueries.join(' / ')}</span>
        </div>
      )}
      {step.kbIds && step.kbIds.length > 0 && (
        <div className="text-slate-500 mt-0.5">检索 KB：{step.kbIds.length} 个</div>
      )}
      {step.hitCount !== undefined && step.hitCount > 0 && (
        <div className="text-slate-500 mt-0.5">→ 命中 {step.hitCount} 个片段</div>
      )}
      {step.kind === 'skip' && step.hitCount === undefined && (
        <div className="text-slate-500 mt-0.5">→ 不检索，直接通识回答</div>
      )}
    </div>
  );
}
