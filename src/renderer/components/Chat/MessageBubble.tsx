/**
 * 单条消息气泡
 * - agent 模式：在内容上方渲染 AgentTraceView（折叠）
 * - 引用来源：内容下方
 */
import { marked } from 'marked';
import type { Message, Citation, AgentTrace } from '../../types';
import { AgentTraceView } from './AgentTraceView';

interface Props {
  role: Message['role'];
  content: string;
  citations?: Citation[];
  agentTrace?: AgentTrace;
  /** 流式态：传入当前阶段 + 部分 trace（实时 build） */
  streamingAgentTrace?: AgentTrace;
  streamingAgentPhase?: string;
}

export function MessageBubble({
  role,
  content,
  citations,
  agentTrace,
  streamingAgentTrace,
  streamingAgentPhase,
}: Props) {
  const isUser = role === 'user';
  const trace = agentTrace ?? streamingAgentTrace;
  const isPending = !!streamingAgentTrace && !agentTrace;
  const html = content ? (marked.parse(content, { async: false }) as string) : '';

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
        {/* agent 模式：trace 折叠放在内容上方 */}
        {trace && !isUser && (
          <AgentTraceView trace={trace} pending={isPending} activePhase={streamingAgentPhase} />
        )}

        {content ? (
          <div
            className="markdown-body"
            // 简单实现：生产环境应配合 DOMPurify
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : isPending ? null : null}

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
