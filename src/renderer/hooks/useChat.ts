/**
 * 聊天状态管理：会话列表、消息列表、流式响应
 * - 兼容 simple 模式（单轮 hybridSearch + 流式生成）
 * - 兼容 agent 模式（function_calling + 多轮 + 跨 KB；通过 agent 事件流式 build trace）
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { api, toast } from '../services/electronAPI';
import type {
  Session,
  Message,
  Citation,
  AgentTrace,
  ChatAgentPhaseEvent,
} from '../types';

export interface SendOptions {
  kbIds?: string[];
  mode?: 'simple' | 'agent';
}

export function useChat(kbId: string | null) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingCitations, setStreamingCitations] = useState<Citation[]>([]);
  /** agent 模式：流式 build 的 trace（done 时清空） */
  const [streamingTrace, setStreamingTrace] = useState<AgentTrace | null>(null);
  /** agent 模式：当前阶段文字（用于 spinner 提示） */
  const [streamingPhase, setStreamingPhase] = useState<string>('');

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
  const offAgentStepRef = useRef<(() => void) | null>(null);
  const offAgentPhaseRef = useRef<(() => void) | null>(null);

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

  // 记录当前正在流式的 sessionId——用于切会话时判断是否要清流式态。
  // streaming 是 useChat 局部 state，切会话不重挂载；若不处理，切走正在流式的会话后
  // 新会话会继承 streaming=true → 输入框禁用 + 显示等待气泡（"其他对话也显示等待"）。
  const streamingSessionRef = useRef<string | null>(null);

  // 切会话时：若切到的不是正在流式的会话，清流式态（新会话干净）。
  // 切回正在流式的会话时不动——事件订阅按 sessionId 过滤，token/done 仍会续上，不丢内容。
  useEffect(() => {
    const streamingSid = streamingSessionRef.current;
    if (streamingSid && activeSession?.id !== streamingSid) {
      setStreaming(false);
      setStreamingText('');
      setStreamingCitations([]);
      setStreamingTrace(null);
      setStreamingPhase('');
    }
  }, [activeSession]);

  // 卸载时清理订阅
  useEffect(() => {
    return () => {
      offTokenRef.current?.();
      offDoneRef.current?.();
      offCitationRef.current?.();
      offAgentStepRef.current?.();
      offAgentPhaseRef.current?.();
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
    async (
      content: string,
      providerId: string,
      model: string,
      topK?: number,
      options: SendOptions = {},
    ) => {
      if (!kbId || !content.trim()) return;
      // 防双发：上一次 send 还没走完就直接 return
      if (sendingRef.current) return;
      sendingRef.current = true;

      const currentSession = activeSessionRef.current;

      // 1) 关键修复：用户消息【立刻】塞进 messages
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
      streamingSessionRef.current = currentSession?.id ?? null;
      setStreamingText('');
      setStreamingCitations([]);
      setStreamingTrace(null);
      setStreamingPhase('');

      // 3) 先清理上次遗留订阅
      offTokenRef.current?.();
      offDoneRef.current?.();
      offCitationRef.current?.();
      offAgentStepRef.current?.();
      offAgentPhaseRef.current?.();
      offTokenRef.current = null;
      offDoneRef.current = null;
      offCitationRef.current = null;
      offAgentStepRef.current = null;
      offAgentPhaseRef.current = null;

      // 4) 订阅
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
            setStreamingText((t) => t + e.delta);
          }
        },
      );
      offAgentPhaseRef.current = api.on(
        'chat:agent-phase',
        (e: ChatAgentPhaseEvent) => {
          const sess = activeSessionRef.current;
          if (sess && e.sessionId !== sess.id) return;
          const phaseLabel: Record<string, string> = {
            'kb-select': '正在选择知识库...',
            'kb-select-done': '',
            planning: '正在规划检索...',
            searching: '正在检索...',
            critiquing: '正在评估结果...',
            finalizing: '正在生成回答...',
          };
          setStreamingPhase(phaseLabel[e.phase] ?? e.phase);
        },
      );
      offAgentStepRef.current = api.on(
        'chat:agent-step',
        (e: { sessionId: string; step: any; iteration: number }) => {
          const sess = activeSessionRef.current;
          if (sess && e.sessionId !== sess.id) return;
          setStreamingTrace((t) => ({
            steps: [...(t?.steps ?? []), e.step],
            totalLatencyMs: t?.totalLatencyMs ?? 0,
            kbIds: t?.kbIds ?? [],
            iterations: e.iteration,
            didKBSelection: t?.didKBSelection ?? false,
          }));
        },
      );
      offDoneRef.current = api.on(
        'chat:done',
        async (e: { sessionId: string; messageId?: string }) => {
          const sess = activeSessionRef.current;
          if (sess && e.sessionId !== sess.id) return;
          setStreaming(false);
          streamingSessionRef.current = null;
          setStreamingText('');
          setStreamingCitations([]);
          setStreamingTrace(null);
          setStreamingPhase('');
          sendingRef.current = false;
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
          kbIds: options.kbIds,
          mode: options.mode,
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
        streamingSessionRef.current = null;
        setStreamingText('');
        setStreamingCitations([]);
        setStreamingTrace(null);
        setStreamingPhase('');
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
    streamingTrace,
    streamingPhase,
    send,
    newSession,
    removeSession,
    refresh: refreshSessions,
  };
}
