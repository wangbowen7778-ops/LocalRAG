/**
 * 聊天状态管理：会话列表、消息列表、流式响应
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { api, toast } from '../services/electronAPI';
import type { Session, Message, Citation } from '../types';

export function useChat(kbId: string | null) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingCitations, setStreamingCitations] = useState<Citation[]>([]);

  // 用 ref 持有最新 activeSession，避开闭包陈旧（关键）
  const activeSessionRef = useRef<Session | null>(null);
  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  // 防止极快连点 Enter / 「发送」触发两次 send
  const sendingRef = useRef(false);

  // 取消订阅句柄
  const offTokenRef = useRef<(() => void) | null>(null);
  const offDoneRef = useRef<(() => void) | null>(null);
  const offCitationRef = useRef<(() => void) | null>(null);

  // 加载会话列表
  const refreshSessions = useCallback(async () => {
    if (!kbId) {
      setSessions([]);
      return;
    }
    try {
      const list = await api.listSessions(kbId);
      setSessions(list);
    } catch (e: any) {
      toast('error', '加载会话失败：' + (e?.message ?? ''));
    }
  }, [kbId]);

  useEffect(() => {
    refreshSessions();
    setActiveSession(null);
    setMessages([]);
  }, [refreshSessions]);

  // 加载消息
  useEffect(() => {
    if (!activeSession) {
      setMessages([]);
      return;
    }
    api.listMessages(activeSession.id).then(setMessages).catch(() => setMessages([]));
  }, [activeSession]);

  // 卸载时清理订阅
  useEffect(() => {
    return () => {
      offTokenRef.current?.();
      offDoneRef.current?.();
      offCitationRef.current?.();
    };
  }, []);

  const newSession = () => {
    setActiveSession(null);
    setMessages([]);
  };

  const removeSession = async (id: string) => {
    await api.deleteSession(id);
    if (activeSession?.id === id) newSession();
    await refreshSessions();
  };

  const send = useCallback(
    async (content: string, providerId: string, model: string, topK?: number) => {
      if (!kbId || !content.trim()) return;
      // 防双发：上一次 send 还没走完就直接 return
      if (sendingRef.current) return;
      sendingRef.current = true;

      const currentSession = activeSessionRef.current;

      // 1) 关键修复：用户消息【立刻】塞进 messages（用临时 id，
      //    等 chat:done 时用 DB 真实数据回填覆盖）
      const tempUserId =
        'temp_user_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const tempUserMsg: Message = {
        id: tempUserId,
        sessionId: currentSession?.id ?? '',
        role: 'user',
        content,
        createdAt: Date.now(),
      };
      setMessages((m) => [...m, tempUserMsg]);

      // 2) 进入流式态
      setStreaming(true);
      setStreamingText('');
      setStreamingCitations([]);

      // 3) 先清理上次遗留订阅，避免「老 listener + 新 listener 同时 append」造成重复
      offTokenRef.current?.();
      offDoneRef.current?.();
      offCitationRef.current?.();
      offTokenRef.current = null;
      offDoneRef.current = null;
      offCitationRef.current = null;

      // 4) 订阅 — 用 ref 读 activeSession，闭包永远是最新的
      offCitationRef.current = api.on(
        'chat:citation',
        (e: { sessionId: string; citations: Citation[] }) => {
          const sess = activeSessionRef.current;
          if (sess && e.sessionId !== sess.id) return;
          setStreamingCitations(e.citations);
        },
      );
      offTokenRef.current = api.on(
        'chat:token',
        (e: { sessionId: string; delta: string; done: boolean }) => {
          const sess = activeSessionRef.current;
          if (sess && e.sessionId !== sess.id) return;
          if (e.delta) {
            // 关键：函数式 setState 追加，绝对不要 setStreamingText(e.delta) 替换
            setStreamingText((t) => t + e.delta);
          }
        },
      );
      offDoneRef.current = api.on(
        'chat:done',
        async (e: { sessionId: string; messageId?: string }) => {
          const sess = activeSessionRef.current;
          if (sess && e.sessionId !== sess.id) return;
          setStreaming(false);
          setStreamingText('');
          setStreamingCitations([]);
          sendingRef.current = false;
          // 用 DB 真实消息替换本地列表（含真正入库的 user 消息和 assistant 消息）
          if (e.sessionId) {
            const list = await api.listMessages(e.sessionId);
            setMessages(list);
          }
          await refreshSessions();
        },
      );

      // 5) 发起请求
      try {
        const session = await api.sendChat({
          kbId,
          sessionId: currentSession?.id,
          content,
          providerId,
          model,
          topK,
        });
        if (!currentSession) {
          setActiveSession(session);
          activeSessionRef.current = session;
        }
      } catch (e: any) {
        sendingRef.current = false;
        setStreaming(false);
        setStreamingText('');
        setStreamingCitations([]);
        // 失败：把刚塞进 messages 的临时用户消息回滚掉
        setMessages((m) => m.filter((x) => x.id !== tempUserId));
        toast('error', '发送失败：' + (e?.message ?? ''));
      }
    },
    [kbId, refreshSessions],
  );

  return {
    sessions,
    activeSession,
    setActiveSession,
    messages,
    streaming,
    streamingText,
    streamingCitations,
    send,
    newSession,
    removeSession,
    refresh: refreshSessions,
  };
}
