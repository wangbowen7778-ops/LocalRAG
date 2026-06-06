/**
 * 消息列表：滚动到底 + 流式占位
 * - 流式态：把 streamingText / streamingCitations / streamingTrace 传进 bubble
 * - agent 模式：MessageList 末尾的占位 bubble 也用 AgentTraceView
 */
import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import type { Message, Citation, AgentTrace } from '../../types';
import { LoadingSpinner } from '../Common/LoadingSpinner';

interface Props {
  messages: Message[];
  streaming: boolean;
  streamingText: string;
  streamingCitations: Citation[];
  streamingTrace?: AgentTrace | null;
  streamingPhase?: string;
}

export function MessageList({
  messages,
  streaming,
  streamingText,
  streamingCitations,
  streamingTrace,
  streamingPhase,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, streamingText, streamingTrace]);

  return (
    <div ref={ref} className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
      {messages.length === 0 && !streaming && (
        <div className="text-center text-slate-500 py-16">
          <div className="text-4xl mb-2">💬</div>
          <div className="text-sm">开始提问吧</div>
        </div>
      )}

      {messages.map((m) => (
        <MessageBubble
          key={m.id}
          role={m.role}
          content={m.content}
          citations={m.citations}
          agentTrace={m.agentTrace}
        />
      ))}

      {streaming && (
        <MessageBubble
          role="assistant"
          content={streamingText}
          citations={streamingCitations}
          streamingAgentTrace={streamingTrace ?? undefined}
          streamingAgentPhase={streamingPhase}
        />
      )}

      {streaming && !streamingText && !streamingTrace && (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-lg px-4 py-2 bg-white dark:bg-surface-dark-2 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <LoadingSpinner size={14} /> 正在检索与生成...
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
