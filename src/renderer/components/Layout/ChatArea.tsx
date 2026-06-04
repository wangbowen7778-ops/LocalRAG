/**
 * 对话区域：会话侧栏 + 消息列表 + 输入框
 */
import { useState, useEffect } from 'react';
import type { KnowledgeBase, ProviderConfig } from '../../types';
import { useChat } from '../../hooks/useChat';
import { MessageList } from '../Chat/MessageList';
import { InputBox } from '../Chat/InputBox';

interface Props {
  activeKB: KnowledgeBase | null;
  providers: ProviderConfig[];
  onNeedProvider: () => void;
}

export function ChatArea({ activeKB, providers, onNeedProvider }: Props) {
  const chat = useChat(activeKB?.id ?? null);
  const [providerId, setProviderId] = useState<string>('');
  const [model, setModel] = useState<string>('');

  useEffect(() => {
    if (providers.length > 0) {
      setProviderId((p) => p || providers[0].id);
    }
  }, [providers]);

  useEffect(() => {
    const p = providers.find((x) => x.id === providerId);
    if (p) setModel(p.chatModel);
  }, [providerId, providers]);

  if (!activeKB) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500">
        请在左侧选择或创建一个知识库
      </div>
    );
  }

  if (providers.length === 0 || providers.every((p) => !p.hasApiKey)) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-slate-500 gap-3">
        <div>尚未配置任何 AI 服务</div>
        <button
          onClick={onNeedProvider}
          className="px-4 py-2 rounded bg-primary-500 text-white hover:bg-primary-600 text-sm"
        >
          前往设置
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex min-w-0 h-full min-h-0">
      {/* 会话侧栏 */}
      <div className="w-48 border-r border-slate-200 dark:border-slate-700 flex flex-col bg-slate-50 dark:bg-surface-dark-2">
        <button
          onClick={chat.newSession}
          className="m-2 text-xs px-2 py-1 rounded bg-primary-500 text-white hover:bg-primary-600"
        >
          ＋ 新对话
        </button>
        <div className="flex-1 overflow-y-auto px-1">
          {chat.sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => chat.setActiveSession(s)}
              className={
                'group px-2 py-1.5 rounded text-sm cursor-pointer truncate ' +
                (chat.activeSession?.id === s.id
                  ? 'bg-primary-100 dark:bg-primary-700/30 text-primary-700 dark:text-primary-200'
                  : 'hover:bg-slate-200/50 dark:hover:bg-slate-700/50')
              }
              title={s.title}
            >
              {s.title}
            </div>
          ))}
        </div>
      </div>

      {/* 主对话区 */}
      <div className="flex-1 flex flex-col min-w-0 h-full min-h-0">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-200 dark:border-slate-700 text-xs text-slate-500">
          <select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark text-slate-700 dark:text-slate-200"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark text-slate-700 dark:text-slate-200 flex-1 min-w-0"
          />
        </div>

        <MessageList
          messages={chat.messages}
          streaming={chat.streaming}
          streamingText={chat.streamingText}
          streamingCitations={chat.streamingCitations}
        />

        {/* 输入区：锚定页面底部（不随消息滚动） */}
        <InputBox
          disabled={chat.streaming}
          onSend={(text) => chat.send(text, providerId, model)}
        />
      </div>
    </div>
  );
}
