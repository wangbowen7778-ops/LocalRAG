/**
 * 输入框：多行 + Ctrl+Enter 发送
 */
import { useState, useRef, KeyboardEvent } from 'react';

interface Props {
  disabled?: boolean;
  onSend: (text: string) => void;
}

export function InputBox({ disabled, onSend }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const v = text.trim();
    if (!v || disabled) return;
    onSend(v);
    setText('');
    if (ref.current) ref.current.style.height = 'auto';
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const autoSize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  return (
    <div className="border-t border-slate-200 dark:border-slate-700 p-3 bg-white dark:bg-surface-dark-2 flex-shrink-0">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            autoSize(e.target);
          }}
          onKeyDown={onKey}
          placeholder="输入问题，Enter 发送，Shift+Enter 换行"
          className="flex-1 resize-none px-3 py-2 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-surface-dark focus:outline-none focus:border-primary-500 text-sm max-h-48"
        />
        <button
          onClick={submit}
          disabled={disabled || !text.trim()}
          className="px-4 py-2 rounded bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
        >
          发送
        </button>
      </div>
    </div>
  );
}
