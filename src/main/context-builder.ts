/**
 * 智能 chat 上下文构造（v1.2.4）
 *
 * 设计目标：
 * - 替代 v1.2.2/v1.2.3 的「硬切 last 8 + 周期摘要」组合
 * - 优先把**完整对话历史**塞进 LLM context（多轮 RAG 的指代由 LLM 看到全 history 自然消解）
 * - 超出模型 context window 时智能截断：首条 user（话题锚点）必带 + 末尾尽量多 + 中间调 LLM 压缩
 * - 不再调「改写 LLM」——指代 / 实体补全在 LLM 看到全 history 时是无成本的
 *
 * 与 v1.2.3 的关系：
 * - 删除：query rewriting（v1.2.2）和 history slice(-8) 截断
 * - 保留：session_summaries 表 + searchSessionSummaries（跨 session 摘要召回由调用方在 user prompt 注入）
 *
 * 触发截断的概率（粗估）：
 * - DeepSeek-V3 64K：avg 1.5K/turn，~40 turn 才开始截断
 * - Qwen-Plus 128K：~80 turn
 * - gpt-4o-mini 128K：~80 turn
 * - 80% 用户的 session 不会触发
 */
import { listMessages } from './storage';
import { chatCompletion } from './api-client';
import { resolveSummaryProvider } from './document-processor';
import { SecureStore } from './secure-store';
import { countTokens } from './chunkers/tokenizer';
import type { ChatMessage, Message, Settings } from '../shared/types';

/**
 * 各 chat 模型的 context window 上限（tokens）。
 * 未知模型 fallback 32K（保守估算，避免超限）。
 * 加新模型在此补一行。
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  // DeepSeek
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
  // 通义千问
  'qwen-turbo': 1_000_000,
  'qwen-plus': 128_000,
  'qwen-max': 128_000,
  'qwen-long': 10_000_000,
  'qwq-plus': 128_000,
  // 默认
  default: 32_000,
};

function getModelContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? MODEL_CONTEXT_WINDOWS.default;
}

export interface BuildHistoryOptions {
  sessionId: string;
  currentUserMsgId: string;
  model: string;
  /** 排除的 role，默认 ['tool']。Agent 模式下 tool 是流程消息，不需要进 history */
  excludeRoles?: Array<Message['role']>;
  /** 非 history 部分的 prompt（用于预算计算） */
  promptOverhead?: {
    sysPrompt?: string;
    currentUserPrompt?: string;
    summaryBlock?: string;
  };
  /** 触发 middle 压缩时需要：取 chat provider / key */
  settings?: Settings;
}

export interface BuildHistoryResult {
  /** 构造好的 history（不含 system 和 current user） */
  history: ChatMessage[];
  /** 如果触发了截断：被压缩的中间部分的摘要（建议注入到 system prompt） */
  middleSummary?: string;
  /** 实际占用的 history tokens（含 middleSummary） */
  usedTokens: number;
  /** 是否触发了截断 */
  truncated: boolean;
}

/**
 * 智能构造 history：
 * 1. 从 DB 拿全部消息
 * 2. 过滤掉 currentUserMsgId + 排除的 role
 * 3. 估算 token 数，能塞下就全塞
 * 4. 超 budget：firstUser（必带）+ 中间调 LLM 压缩 + 末尾尽量多
 */
export async function buildHistory(opts: BuildHistoryOptions): Promise<BuildHistoryResult> {
  const allMessages = listMessages(opts.sessionId);
  const excludeRoles = opts.excludeRoles ?? (['tool'] as const);
  const filtered = allMessages.filter(
    (m) => m.id !== opts.currentUserMsgId && !excludeRoles.includes(m.role as any),
  );

  const modelMax = getModelContextWindow(opts.model);
  const overheadTokens =
    countTokens(opts.promptOverhead?.sysPrompt ?? '') +
    countTokens(opts.promptOverhead?.currentUserPrompt ?? '') +
    countTokens(opts.promptOverhead?.summaryBlock ?? '') +
    200; // 消息结构元数据 buffer
  // 留 20% 给 LLM 输出 + 余量
  const budget = Math.max(0, Math.floor(modelMax * 0.8) - overheadTokens);

  const historyItems = filtered.map((m) => ({
    msg: m,
    chatMessage: toChatMessage(m),
    tokens: countTokens(m.content ?? '') + 16, // 16 字 = role + 结构元数据
  }));
  const totalTokens = historyItems.reduce((sum, x) => sum + x.tokens, 0);

  if (totalTokens <= budget) {
    return {
      history: historyItems.map((x) => x.chatMessage),
      usedTokens: totalTokens,
      truncated: false,
    };
  }

  // 触发截断：firstUser（话题锚点）必带 + 末尾尽量多 + 中间压缩
  const firstUserIdx = historyItems.findIndex((x) => x.msg.role === 'user');
  if (firstUserIdx < 0) {
    // 极端情况：全 session 没有 user 消息（只剩 tool）—— 直接取最近能塞下的
    const recent = takeFromTail(historyItems, budget);
    return {
      history: recent.map((x) => x.chatMessage),
      usedTokens: recent.reduce((s, x) => s + x.tokens, 0),
      truncated: recent.length < historyItems.length,
    };
  }

  const firstUser = historyItems[firstUserIdx];
  // 给 middle summary 留 300 tokens 输出预算
  const recentBudget = budget - firstUser.tokens - 300;
  if (recentBudget <= 0) {
    return {
      history: [firstUser.chatMessage],
      usedTokens: firstUser.tokens + 300,
      truncated: true,
      middleSummary: '（早期对话因 context 限制已被截断）',
    };
  }

  const recent = takeFromTail(historyItems, recentBudget);
  // middle：firstUser 之后、recent 之前的部分
  const recentStartIdx = historyItems.length - recent.length;
  const middle = historyItems.slice(firstUserIdx + 1, recentStartIdx);

  let middleSummary: string | undefined;
  if (middle.length > 0 && opts.settings) {
    middleSummary = await quickCompressMiddle(middle, opts.settings).catch((e) => {
      console.warn('[context-builder] middle 压缩失败，使用占位摘要：', (e as Error).message);
      return undefined;
    });
  }
  middleSummary ??= '（早期对话因 context 限制已被截断）';

  return {
    history: [firstUser.chatMessage, ...recent.map((x) => x.chatMessage)],
    usedTokens:
      firstUser.tokens +
      recent.reduce((s, x) => s + x.tokens, 0) +
      countTokens(middleSummary),
    truncated: true,
    middleSummary,
  };
}

/**
 * 从尾部往头部取 messages，直到 budget 耗尽。
 * 返回的数组保持原始时间顺序。
 */
function takeFromTail<T extends { tokens: number }>(items: T[], budget: number): T[] {
  const out: T[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (used + items[i].tokens > budget) break;
    out.unshift(items[i]);
    used += items[i].tokens;
  }
  return out;
}

function toChatMessage(m: Message): ChatMessage {
  const chat: ChatMessage = {
    role: m.role as ChatMessage['role'],
    content: m.content,
  };
  if (m.toolCallId) chat.tool_call_id = m.toolCallId;
  if (m.name) chat.name = m.name;
  return chat;
}

/**
 * 把一段 history 压缩成 200-400 字摘要（intra-session middle 压缩）。
 * 失败返回 undefined（调用方回退到占位文字）。
 * 不复用 api-client.summarizeConversation（那是跨 session 用的，存储到 session_summaries）。
 */
async function quickCompressMiddle(
  items: Array<{ msg: Message }>,
  settings: Settings,
): Promise<string | undefined> {
  const { provider, model } = resolveSummaryProvider(settings);
  const apiKey = await SecureStore.getApiKey(provider.id);
  if (!apiKey) return undefined;

  const compact = items
    .filter((x) => x.msg.role === 'user' || x.msg.role === 'assistant')
    .map((x) => {
      const c = (x.msg.content ?? '').replace(/\s+/g, ' ').trim();
      const label = x.msg.role === 'user' ? '用户' : '助手';
      return `${label}：${c.length > 400 ? c.slice(0, 400) + '…' : c}`;
    })
    .join('\n');
  if (!compact) return undefined;

  const promptMessages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是一个对话摘要助手。给定一段 user/assistant 早期对话，输出 200-400 字中文摘要，' +
        '覆盖对话主题、关键结论、用户关注点。保留专有名词（条例名、文件名、错误码、API 名）。' +
        '只输出摘要文本，不要任何解释、Markdown、JSON。',
    },
    { role: 'user', content: compact },
  ];

  const r = await chatCompletion(provider, apiKey, model, promptMessages, 0.2);
  const summary = (r.content || '').trim();
  return summary || undefined;
}
