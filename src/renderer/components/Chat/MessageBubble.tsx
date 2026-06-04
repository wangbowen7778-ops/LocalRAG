/**
 * 单条消息气泡
 */
import { marked } from 'marked';
import type { Message, Citation } from '../../types';

interface Props {
  role: Message['role'];
  content: string;
  citations?: Citation[];
}

export function MessageBubble({ role, content, citations }: Props) {
  const isUser = role === 'user';
  const html = marked.parse(content, { async: false }) as string;

  return (
    <div className={'flex ' + (isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={
          'max-w-[80%] rounded-lg px-4 py-2 ' +
          (isUser
            ? 'bg-primary-500 text-white'
            : 'bg-white dark:bg-surface-dark-2 border border-slate-200 dark:border-slate-700')
        }
      >
        <div
          className="markdown-body"
          // 简单实现：生产环境应配合 DOMPurify
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {citations && citations.length > 0 && !isUser && (
          <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-600 text-xs">
            <div className="font-semibold text-slate-500 mb-1">引用来源</div>
            <ol className="list-decimal pl-4 space-y-1">
              {citations.map((c, i) => (
                <li key={i} className="text-slate-600 dark:text-slate-300">
                  <span className="text-primary-500">{c.filename}</span> · {c.chunk}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
