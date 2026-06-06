/**
 * 多提供商 AI 客户端
 * 统一抽象：chatStream / chatCompletion / embedText
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
