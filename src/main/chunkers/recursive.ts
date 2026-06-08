/**
 * 递归分隔符切分（LangChain RecursiveCharacterTextSplitter 思路，但用 token 计数）
 *
 * 算法：
 * 1. 按分隔符优先级 [段落 → 行 → 句号群 → 词 → 字符] 逐级尝试
 * 2. 切出"够小"的片段后，把相邻的合并起来填满 chunkSize
 * 3. 单片段仍超过 chunkSize 时，下沉到下一级分隔符递归
 * 4. 合并时若上一个 chunk 已有内容，从其尾部取 overlap tokens 作为新 chunk 的开头
 *
 * 与原 splitChunks 的差异：
 * - 单位是 token 不是 char（cl100k_base）
 * - 句号/问号/感叹号/分号作句子边界
 * - 段落不足时不再按 char 硬切，而是按句子、按词逐级退避
 * - overlap 同样按 token 计算，避免切在 token 中间
 */
import { countTokens, tailTokens } from './tokenizer';

/** 分隔符优先级。首字符为 '[' 的当作 regex 走。 */
const SEPARATORS: string[] = [
  '\n\n',                          // 段落
  '\n',                            // 行
  '[。！？!?，,；;]+',             // 中英文句子/从句边界
  ' ',                             // 词
  '',                              // 字符级兜底
];

export interface RecursiveOptions {
  chunkSize: number;       // tokens
  chunkOverlap: number;    // tokens，必须 < chunkSize
}

export function recursiveSplit(text: string, opts: RecursiveOptions): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!cleaned) return [];
  const safeOpts: RecursiveOptions = opts.chunkOverlap >= opts.chunkSize
    ? { ...opts, chunkOverlap: Math.max(0, Math.floor(opts.chunkSize * 0.1)) }
    : opts;
  return splitRecursive(cleaned, SEPARATORS, safeOpts);
}

function splitRecursive(text: string, seps: string[], opts: RecursiveOptions): string[] {
  if (countTokens(text) <= opts.chunkSize) {
    return text.trim() ? [text.trim()] : [];
  }

  const sep = seps[0];
  const remaining = seps.slice(1);
  const pieces = splitOn(text, sep, opts.chunkSize);
  const joiner = pickJoiner(sep);

  const out: string[] = [];
  let buf: string[] = [];
  let bufTokens = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const joined = buf.join(joiner).trim();
    if (joined) out.push(joined);
    buf = [];
    bufTokens = 0;
  };

  for (const piece of pieces) {
    if (!piece.trim()) continue;
    const pTokens = countTokens(piece);

    if (pTokens > opts.chunkSize) {
      flush();
      const subChunks = splitRecursive(piece, remaining, opts);
      for (const sc of subChunks) {
        if (out.length > 0 && opts.chunkOverlap > 0) {
          const tail = tailTokens(out[out.length - 1], opts.chunkOverlap);
          out.push((tail ? tail + ' ' : '') + sc);
        } else {
          out.push(sc);
        }
      }
      continue;
    }

    if (bufTokens + pTokens > opts.chunkSize) {
      flush();
      if (opts.chunkOverlap > 0 && out.length > 0) {
        const tail = tailTokens(out[out.length - 1], opts.chunkOverlap);
        buf = tail ? [tail, piece] : [piece];
      } else {
        buf = [piece];
      }
    } else {
      buf.push(piece);
    }
    bufTokens = countTokens(buf.join(joiner));
  }
  flush();
  return out;
}

function splitOn(text: string, sep: string, chunkSize: number): string[] {
  // 防御：text 为空或非字符串时直接返回空数组
  if (typeof text !== 'string' || text.length === 0) return [];
  if (sep === '') {
    // 字符级兜底：按"约 chunkSize 个 token 对应的字符数"硬切
    const sampleLen = Math.min(text.length, 4000);
    const sampleTokens = countTokens(text.slice(0, sampleLen)) || 1;
    const charsPerToken = sampleLen / sampleTokens;
    const target = Math.max(64, Math.floor(chunkSize * charsPerToken * 0.9));
    const out: string[] = [];
    for (let i = 0; i < text.length; i += target) out.push(text.slice(i, i + target));
    return out;
  }
  if (sep[0] === '[') {
    // regex 分隔符（句号群等）
    try {
      return text.split(new RegExp(sep)).map((s) => s.trim()).filter(Boolean);
    } catch {
      // regex 编译失败（极端情况）→ 退化到字符级兜底
      return splitOn(text, '', chunkSize);
    }
  }
  return text.split(sep);
}

function pickJoiner(sep: string): string {
  if (sep === '' || sep[0] === '[') return ' ';
  return sep;
}
