/**
 * 多提供商 AI 客户端
 * 统一抽象：chatStream / chatCompletion / embedText
 * 兼容 OpenAI Chat Completions 协议（OpenAI / DeepSeek / DashScope 兼容模式）
 */
import axios, { AxiosInstance } from 'axios';
import type { ProviderConfig, ChatMessage, ToolDef, ToolCall, Message } from '../shared/types';

export type { ChatMessage, ToolDef, ToolCall };

export interface ChatDelta {
  /** 文本片段 */
  content?: string;
  /** 工具调用片段（按 index 累积） */
  toolCallFragments?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
}

export interface ChatStreamOptions {
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

export interface ChatResponse {
  /** 完整文本（content 字段拼接） */
  content: string;
  /** 累积后的 tool_calls（按 index 排序） */
  toolCalls: ToolCall[];
  /** 最后一帧的 finish_reason：'stop' | 'tool_calls' | 'length' | ... */
  finishReason: string;
}

function buildClient(p: ProviderConfig, apiKey: string): AxiosInstance {
  return axios.create({
    baseURL: p.baseUrl.replace(/\/+$/, ''),
    timeout: 60_000,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
}

/** 调用 Embedding */
export async function embedText(
  provider: ProviderConfig,
  apiKey: string,
  text: string,
): Promise<number[]> {
  const c = buildClient(provider, apiKey);
  try {
    // Qwen / OpenAI / 任何 OpenAI 兼容服务都用同一格式：
    //   { model, input: "text" }，响应 { data: [{ embedding: [...] }] }
    // 之前 Qwen 走的是老 DashScope v3 的 { input: { texts: [...] } } 格式，
    // 与预设的 OpenAI 兼容 baseUrl（/compatible-mode/v1）不匹配，会 404。
    const r = await c.post('/embeddings', {
      model: provider.embeddingModel,
      input: text,
    });
    const vec = r.data?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) throw new Error('Embedding 返回格式异常');
    return vec as number[];
  } catch (e: any) {
    // 把 404 转成对用户友好的提示
    if (e?.response?.status === 404) {
      throw new Error(
        `${provider.label} 不支持 embedding 接口（HTTP 404）。` +
          `说明：embedding 是把文本转成向量数字（用于相似度检索），是 AI 服务的另一种能力接口，` +
          `与 chat 回答问题不是同一回事。DeepSeek 等只提供 chat 的服务无论填什么模型名都会 404；` +
          `OpenAI / 通义千问 等支持 embedding 的服务，请确认 baseUrl 走的是 OpenAI 兼容模式（如 Qwen 的 https://dashscope.aliyuncs.com/compatible-mode/v1），` +
          `且 Embedding 模型名拼写正确（OpenAI→text-embedding-3-small、Qwen→text-embedding-v3）。`,
      );
    }
    throw e;
  }
}

/**
 * 非流式 Chat：plan / critique 等中间步骤用，省一层 SSE 解析。
 * 支持 tools（function_calling）参数和 tool_calls 解析。
 */
export async function chatCompletion(
  provider: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  temperature: number,
  options: ChatStreamOptions = {},
): Promise<ChatResponse> {
  const c = buildClient(provider, apiKey);
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    stream: false,
  };
  if (options.tools?.length) body.tools = options.tools;
  if (options.toolChoice) body.tool_choice = options.toolChoice;

  try {
    const r = await c.post('/chat/completions', body, { timeout: 120_000 });
    const choice = r.data?.choices?.[0];
    if (!choice) throw new Error('LLM 返回空 choices');
    const msg = choice.message ?? {};
    return {
      content: typeof msg.content === 'string' ? msg.content : '',
      toolCalls: Array.isArray(msg.tool_calls) ? (msg.tool_calls as ToolCall[]) : [],
      finishReason: choice.finish_reason ?? 'stop',
    };
  } catch (e: any) {
    // 400/422 通常意味着 Provider 不支持 tools——让上层 catch 后降级到 simple 模式
    if (e?.response?.status === 400 || e?.response?.status === 422) {
      const detail = e?.response?.data?.error?.message ?? e?.message ?? '未知错误';
      throw new Error(`LLM 不支持 function_calling（HTTP ${e.response.status}）：${detail}`);
    }
    throw e;
  }
}

/**
 * 流式 Chat：逐 token 回调
 * 不同 provider 的 SSE 格式略有差异，这里做归一化
 * 支持 tools（function_calling）：POST body 加 tools 字段，SSE 解析 delta.tool_calls
 * 累积返回完整 content + toolCalls + finishReason
 */
export async function chatStream(
  provider: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  temperature: number,
  onDelta: (delta: ChatDelta) => void,
  options: ChatStreamOptions = {},
): Promise<ChatResponse> {
  const c = buildClient(provider, apiKey);
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    stream: true,
  };
  if (options.tools?.length) body.tools = options.tools;
  if (options.toolChoice) body.tool_choice = options.toolChoice;

  const resp = await c.post('/chat/completions', body, { responseType: 'stream' });

  // 累积状态
  let fullContent = '';
  const toolAcc = new Map<number, ToolCall>();
  let finishReason = 'stop';

  await new Promise<void>((resolve, reject) => {
    const stream = resp.data;
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let idx: number;
      // SSE 消息以 \n\n 分隔
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split('\n')) {
          const m = line.match(/^data:\s?(.*)$/);
          if (!m) continue;
          const payload = m[1].trim();
          if (payload === '[DONE]') return resolve();
          if (!payload) continue;
          try {
            const json = JSON.parse(payload);
            const choice = json.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta ?? {};
            if (choice.finish_reason) finishReason = choice.finish_reason;

            // 文本片段
            if (delta.content) {
              fullContent += delta.content;
              onDelta({ content: delta.content });
            }

            // 工具调用：按 index 累积
            if (Array.isArray(delta.tool_calls)) {
              const fragments: ChatDelta['toolCallFragments'] = [];
              for (const tc of delta.tool_calls) {
                const i = tc.index ?? 0;
                if (!toolAcc.has(i)) {
                  toolAcc.set(i, {
                    id: tc.id ?? '',
                    type: 'function',
                    function: { name: tc.function?.name ?? '', arguments: '' },
                  });
                }
                const acc = toolAcc.get(i)!;
                if (tc.id) acc.id = tc.id;
                if (tc.type) acc.type = tc.type;
                if (tc.function?.name) acc.function.name += tc.function.name;
                if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
                fragments.push({
                  index: i,
                  id: tc.id,
                  type: tc.type,
                  function: { name: tc.function?.name, arguments: tc.function?.arguments },
                });
              }
              onDelta({ toolCallFragments: fragments });
            }
          } catch {
            // 忽略无法解析的片段
          }
        }
      }
    });
    stream.on('end', () => resolve());
    stream.on('error', (err: Error) => reject(err));
  });

  return {
    content: fullContent,
    toolCalls: Array.from(toolAcc.values()),
    finishReason,
  };
}

// ===== 查询改写（多轮对话 coreference / entity omission 修复）=====

/**
 * 改写思路（LangChain `createHistoryAwareRetriever` / LlamaIndex `CondenseQuestionChatEngine`
 * 同一范式）：把"对话历史 + 最新问题"喂给 LLM，让它输出一个自包含的检索 query——
 * 消除指代（"那"、"它"、"刚才那个"）并补全省略的实体。
 *
 * 跳过条件：query 长度 ≥ 6 且不含指代词 → 几乎肯定是自包含的，省一次 LLM 调用。
 * 失败回退：LLM 调用报错 / 返回空 → 直接返回原 query，不影响主流程。
 * 缓存：进程内 Map，按 (lastUserKey, currentQuery) 做 key。同一 session 同一 query 复用结果。
 *
 * ANAPHORIC_RE 只列"几乎只在指代语境出现"的字/词——"上"、"的"、"个"这类常见字会大量
 * 出现在"上下文"、"模型的"、"第一个"等自包含句子里，命中它们会造成大量假阳性。
 * `它/他/她/这/那` 是 5 个最常见的独立指示代词；`刚才/那个` 是高频时间/远指短语。
 */
const ANAPHORIC_RE = /[它他她这那]|刚才|那个/;

// ===== 改写历史构造（v1.2.3）=====
// 设计目标：长 session 也能精准消解指代，同时控制 token 开销
// - 必带首条 user msg（话题锚点：解决"turn 1 提到 X，turn 20 问它"）
// - 最多带最近 10 条（5 轮 user/assistant 交替）作为短期记忆
// - 单条 assistant > 500 字截到 300 字（assistant 的中间论证对改写没价值，结论和引用才有用）
// - 总字符数 ≤ 2500（粗估 ≈ 2500 token；CJK 1 字 ≈ 1 token，ASCII 1 字符 ≈ 0.25 token）
//   超限时优先砍"中间的 assistant 长消息"，保留 firstUser + 末尾若干条
const REWRITE_HISTORY = {
  MAX_MESSAGES: 10,
  ASSISTANT_TRUNCATE_THRESHOLD: 500,
  ASSISTANT_TRUNCATE_LENGTH: 300,
  MAX_CHARS: 2500,
} as const;

/**
 * 构造改写用的历史消息序列
 * @param messages session 全部消息（已按 created_at ASC 排序）
 * @param currentMsgId 当前 user msg id（不参与改写；写入时再独立处理）
 * @returns 给 LLM 看的"系统"之外的历史
 */
export function buildRewriteHistory(
  messages: Message[],
  currentMsgId: string,
): ChatMessage[] {
  // 1. 排除当前 user msg + tool role（tool 是给主 LLM 看的元数据，改写 LLM 不需要）
  const candidates = messages
    .filter((m) => m.id !== currentMsgId && m.role !== 'tool')
    .map((m) => ({
      role: m.role as ChatMessage['role'],
      content: m.content,
    }));

  // 2. 首条 user msg：话题锚点（"turn 1 提了《XX条例》，turn 20 问它"全靠它）
  const firstUser = candidates.find((m) => m.role === 'user');

  // 3. 短期记忆：最近 N 条
  const recent = candidates.slice(-REWRITE_HISTORY.MAX_MESSAGES);

  // 4. 合并：firstUser 必带 + recent 去重追加
  const seen = new Set<object>();
  const merged: ChatMessage[] = [];
  if (firstUser) {
    merged.push(firstUser);
    seen.add(firstUser);
  }
  for (const m of recent) {
    if (!seen.has(m)) {
      merged.push(m);
      seen.add(m);
    }
  }

  // 5. 截断长 assistant：长 assistant 消息对改写没价值（论证、列举、引用尾巴）
  //    只保留前 N 字 + "..."，足够让改写 LLM 看到结论和引用
  const truncated = merged.map((m) => {
    if (
      m.role === 'assistant' &&
      typeof m.content === 'string' &&
      m.content.length > REWRITE_HISTORY.ASSISTANT_TRUNCATE_THRESHOLD
    ) {
      return {
        ...m,
        content: m.content.slice(0, REWRITE_HISTORY.ASSISTANT_TRUNCATE_LENGTH) + '…',
      };
    }
    return m;
  });

  // 6. Token 预算裁剪：超 MAX_CHARS 时从中间砍
  //    优先级：firstUser 永远在 + 末尾尽量保留（末尾是"刚聊的"，指代概率最大）
  let totalChars = 0;
  const out: ChatMessage[] = [];
  // 反向遍历：先加末尾，凑满后再回头补 firstUser
  for (let i = truncated.length - 1; i >= 0; i--) {
    const m = truncated[i];
    const chars = (m.content?.length ?? 0) + 16; // 16 字元数据开销
    if (out.length > 0 && totalChars + chars > REWRITE_HISTORY.MAX_CHARS) {
      break;
    }
    out.unshift(m);
    totalChars += chars;
  }
  // 确保 firstUser 必在
  if (firstUser && !out.includes(firstUser)) {
    out.unshift(firstUser);
  }

  return out;
}

const REWRITE_SYSTEM_PROMPT = `你是一个查询改写助手。给定对话历史和用户的最新问题，把它改写成一个自包含、可独立检索的查询：
- 消除指代（"那"、"它"、"这个"、"刚才那个" → 替换为对话历史中实际出现的具体名词）
- 补充省略的实体（"哪一章？" → "《XX条例》第一条属于哪一章？"）
- 保留全部关键名词（错误码、API 名、专有名词、文件名等不要简化）
- 如果原问题已自包含（不含指代词且不省略实体），原样输出
只输出改写后的查询文本，不要任何解释、标点、引号、Markdown。`;

interface RewriteCacheEntry {
  lastUserKey: string;
  currentQuery: string;
  rewritten: string;
}
const rewriteCache = new Map<string, RewriteCacheEntry>();

/**
 * 改写 query：把多轮对话中"上下文相关"的简短问题展开为自包含的检索 query。
 *
 * v1.2.3：内部用 `buildRewriteHistory()` 构造历史——首条 user 必带 + 最近 10 条 +
 * assistant 截断 + token 预算。短 query + 含指代词才走 LLM，其余跳过。
 *
 * @param provider / apiKey — 改写用的 Chat Provider + Key（独立于 embedding provider）
 * @param model — 改写用的模型名；不传则用 provider.chatModel
 * @param messages — session 全部消息（listMessages 结果）
 * @param currentMsgId — 当前 user msg id；改写时把它从 history 排除
 * @param currentQuery — 用户最新一条消息
 * @param sessionId — 缓存 key；同一 session 同一 query 复用结果
 */
export async function rewriteQuery(
  provider: ProviderConfig,
  apiKey: string,
  model: string | undefined,
  messages: Message[],
  currentMsgId: string,
  currentQuery: string,
  sessionId?: string,
): Promise<string> {
  const q = (currentQuery || '').trim();
  if (!q) return q;

  // 自包含快速判断：长度 + 无指代词 → 直接返回
  if (q.length >= 6 && !ANAPHORIC_RE.test(q)) {
    return q;
  }

  // 缓存命中：同一 (sessionId, lastUserKey, currentQuery) 复用结果
  // lastUserKey 用"倒数第二条 user msg 的内容前 80 字"——同 session 同一 query 重发场景
  const lastUserKey = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.id !== currentMsgId)?.content?.slice(0, 80) ?? '';
  if (sessionId) {
    const cached = rewriteCache.get(sessionId);
    if (cached && cached.lastUserKey === lastUserKey && cached.currentQuery === q) {
      return cached.rewritten;
    }
  }

  // 构造改写 prompt：用 buildRewriteHistory 处理长 session（首条锚点 + token 预算）
  const history = buildRewriteHistory(messages, currentMsgId);
  const promptMessages: ChatMessage[] = [
    { role: 'system', content: REWRITE_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: `请改写：${q}` },
  ];

  try {
    const r = await chatCompletion(
      provider,
      apiKey,
      model || provider.chatModel,
      promptMessages,
      0, // 改写要确定性，temperature=0
    );
    // 清洗：去掉首尾空白、引号、句号、解释尾巴
    let rewritten = (r.content || '').trim();
    rewritten = rewritten.replace(/^["'`「」『』]+|["'`「」『』]+$/g, '');
    rewritten = rewritten.split('\n')[0].trim(); // 截掉 LLM 偶尔追加的解释
    if (!rewritten) return q;

    if (sessionId) {
      rewriteCache.set(sessionId, { lastUserKey, currentQuery: q, rewritten });
    }
    return rewritten;
  } catch (e) {
    console.warn('[rewriteQuery] failed, fallback to original:', (e as Error).message);
    return q;
  }
}

/** 清除缓存（测试 / 设置变更时用） */
export function clearRewriteCache(): void {
  rewriteCache.clear();
}

// ===== 对话摘要生成（v1.2.3）=====

const SUMMARY_SYSTEM_PROMPT = `你是一个对话摘要助手。给定一段 user/assistant 多轮对话历史，输出严格 JSON：
{
  "summary": "200-400 字中文摘要，覆盖对话主题、关键结论、用户关注点",
  "key_topics": ["主题1", "主题2", ...],   // 3-8 个，对话中反复出现的核心话题
  "key_entities": [{"type": "...", "value": "..."}, ...]  // 关键实体，type ∈ regulation/person/file/term/other
}
要求：
- 摘要用第三人称："用户询问了 X，助手回答了 Y"
- 保留所有专有名词（条例名、文件名、人名、错误码、API 名）
- 不要评价对话质量、不要解释 JSON 结构
- 严格输出 JSON，可放在 \`\`\`json ... \`\`\` 代码块里
只输出 JSON，不要其他文字。`;

export interface ConversationSummary {
  summary: string;
  keyTopics: string[];
  keyEntities: Array<{ type: string; value: string }>;
}

/**
 * 用 LLM 给一段对话历史生成摘要 + 关键主题 + 关键实体。
 * 失败回退：返回 null（调用方应跳过本次摘要，不影响主流程）。
 *
 * @param provider / apiKey — Chat Provider + Key（默认走 rewriter / chat 模型）
 * @param model — 摘要用模型；不传则用 provider.chatModel
 * @param messages — 待摘要的 user/assistant 消息（最近 N 条，user/assistant 交替）
 */
export async function summarizeConversation(
  provider: ProviderConfig,
  apiKey: string,
  model: string | undefined,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<ConversationSummary | null> {
  if (messages.length === 0) return null;

  const promptMessages: ChatMessage[] = [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    // 摘要 LLM 看到的是 user/assistant 交替的对话
    ...messages.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: '请按 schema 输出这段对话的摘要 JSON。' },
  ];

  try {
    const r = await chatCompletion(
      provider,
      apiKey,
      model || provider.chatModel,
      promptMessages,
      0.2, // 摘要允许一点点创造性，但温度不能太高
    );
    const jsonStr = extractFirstJson(r.content);
    if (!jsonStr) {
      console.warn('[summarizeConversation] no JSON in LLM response:', r.content.slice(0, 100));
      return null;
    }
    const parsed = JSON.parse(jsonStr);
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
      keyTopics: Array.isArray(parsed.key_topics)
        ? parsed.key_topics.filter((x: unknown): x is string => typeof x === 'string')
        : [],
      keyEntities: Array.isArray(parsed.key_entities)
        ? parsed.key_entities
            .filter(
              (x: any) => x && typeof x.type === 'string' && typeof x.value === 'string',
            )
            .map((x: any) => ({ type: x.type, value: x.value }))
        : [],
    };
  } catch (e) {
    console.warn('[summarizeConversation] failed:', (e as Error).message);
    return null;
  }
}

/** 从 LLM 输出中抠出第一个 JSON 对象（容忍 ```json fences） */
function extractFirstJson(s: string): string | null {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const bare = s.match(/\{[\s\S]*\}/);
  return bare ? bare[0] : null;
}
