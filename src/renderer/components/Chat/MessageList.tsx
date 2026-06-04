/**
 * 消息列表：滚动到底 + 流式占位
 */
import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import type { Message, Citation } from '../../types';
import { LoadingSpinner } from '../Common/LoadingSpinner';

interface Props {
  messages: Message[];
  streaming: boolean;
  streamingText: string;
  streamingCitations: Citation[];
}

export function MessageList({ messages, streaming, streamingText, streamingCitations }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, streamingText]);

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
        />
      ))}

      {streaming && (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-lg px-4 py-2 bg-white dark:bg-surface-dark-2 border border-slate-200 dark:border-slate-700">
            {streamingText ? (
              <div className="markdown-body typing-cursor">{streamingText}</div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <LoadingSpinner size={14} /> 正在检索与生成...
              </div>
            )}
            {streamingCitations.length > 0 && (
              <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-600 text-xs">
                <div className="font-semibold text-slate-500 mb-1">引用来源</div>
                <ol className="list-decimal pl-4 space-y-1">
                  {streamingCitations.map((c, i) => (
                    <li key={i} className="text-slate-600 dark:text-slate-300">
                      <span className="text-primary-500">{c.filename}</span> · {c.chunk}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
