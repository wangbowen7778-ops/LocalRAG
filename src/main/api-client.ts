/**
 * 多提供商 AI 客户端
 * 统一抽象：chatStream / chatCompletion / embedText / summarizeConversation
 * 兼容 OpenAI Chat Completions 协议（OpenAI / DeepSeek / DashScope 兼容模式）
 */
import axios, { AxiosInstance } from 'axios';
import type { ProviderConfig, ChatMessage, ToolDef, ToolCall } from '../shared/types';

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

// ===== 对话摘要生成（v1.2.3）=====
// 跨 session 摘要：每个 session 每 N user turn 生成一次，落库到 session_summaries 表，
// 供后续轮 searchSessionSummaries 跨 session 召回。
// v1.2.4 改动：移除了 v1.2.2 的"改写"相关代码（rewriteQuery / buildRewriteHistory /
// ANAPHORIC_RE / 改写缓存）。本文件的 summarizeConversation 是 v1.2.3 跨 session 摘要，
// 不受 v1.2.4 改动影响（v1.2.4 新增的 intra-session middle 压缩在 context-builder.ts 里，
// 走 resolveSummaryProvider，复用同一个 LLM 通道）。

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
 * @param provider / apiKey — Chat Provider + Key（默认走 defaultProviderId，v1.2.4 起复用 Chat 模型）
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
