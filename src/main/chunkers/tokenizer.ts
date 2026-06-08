/**
 * Token 计数：gpt-tokenizer cl100k_base 封装
 *
 * 为什么选 cl100k_base：
 * - 与 OpenAI text-embedding-3-small/large、gpt-3.5/4 系列同源
 * - 国内主流 Qwen / DeepSeek / SiliconFlow embedding 也大多兼容 BPE 或
 *   token 密度差异 < 10%，对切分 size 控制影响可忽略
 *
 * 性能：
 * - 1.5MB 字典加载一次后，encode 约 1-3 MB/s（C++ native 不可用，纯 JS 跑）
 * - 一个 1 万字符的中文文档约 1-5ms 计数
 */
import { encode, decode, countTokens as gptCount } from 'gpt-tokenizer/encoding/cl100k_base';

export function countTokens(text: string): number {
  if (!text) return 0;
  return gptCount(text);
}

/**
 * 取字符串最后 N 个 token。
 * 用 encode + decode 严格按 token 边界切，避免按 char 切到 token 中间产生脏数据。
 */
export function tailTokens(text: string, n: number): string {
  if (n <= 0 || !text) return '';
  const tokens = encode(text);
  if (tokens.length <= n) return text;
  return decode(tokens.slice(tokens.length - n));
}
