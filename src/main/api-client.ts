/**
 * 多提供商 AI 客户端
 * 统一抽象：chatStream / embedText
 * 兼容 OpenAI Chat Completions 协议（OpenAI / DeepSeek / DashScope 兼容模式）
 */
import axios, { AxiosInstance } from 'axios';
import type { ProviderConfig } from '../shared/types';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
 * 流式 Chat：逐 token 回调
 * 不同 provider 的 SSE 格式略有差异，这里做归一化
 */
export async function chatStream(
  provider: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  temperature: number,
  onDelta: (delta: string) => void,
): Promise<void> {
  const c = buildClient(provider, apiKey);
  const resp = await c.post(
    '/chat/completions',
    {
      model,
      messages,
      temperature,
      stream: true,
    },
    { responseType: 'stream' },
  );

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
            const delta: string =
              json.choices?.[0]?.delta?.content ??
              json.choices?.[0]?.message?.content ??
              '';
            if (delta) onDelta(delta);
          } catch {
            // 忽略无法解析的片段
          }
        }
      }
    });
    stream.on('end', () => resolve());
    stream.on('error', (err: Error) => reject(err));
  });
}
