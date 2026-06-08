// gpt-tokenizer 子路径 import 的类型 shim
// 原因：包 package.json 的 "exports" 字段没声明 "types" 条件，
// TypeScript moduleResolution=Node 跟不上，无法从子路径解析出 .d.ts。
// 运行时 import 是没问题的（exports 把 ./* 映射到 ./esm/* 或 ./cjs/*），这里只为 typecheck。

declare module 'gpt-tokenizer/encoding/cl100k_base' {
  import { GptEncoding } from 'gpt-tokenizer/cjs/encoding/cl100k_base';
  export const encode: GptEncoding['encode'];
  export const decode: GptEncoding['decode'];
  export const countTokens: GptEncoding['countTokens'];
}

declare module 'gpt-tokenizer/cjs/encoding/cl100k_base' {
  export interface GptEncoding {
    encode: (lineToEncode: string) => number[];
    decode: (inputTokensToDecode: Iterable<number>) => string;
    countTokens: (input: string) => number;
  }
  const api: GptEncoding;
  export default api;
  export const encode: GptEncoding['encode'];
  export const decode: GptEncoding['decode'];
  export const countTokens: GptEncoding['countTokens'];
}
