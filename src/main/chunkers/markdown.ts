/**
 * Markdown 结构感知切分（B 方案）
 *
 * 用 marked.lexer 解析为 token 序列，按"标题层级 → 代码块/表格原子 → 段落聚合"切分：
 * 1. 标题更新面包屑（breadcrumb），所有后续 chunk 在前缀里带上当前 heading 路径
 *    → 检索时 LLM 看到的不只是孤立片段，而是"它在文档哪一节"
 * 2. 代码块、表格作为原子单位：若超长则内部按行切，每段保留 fence / 表头
 * 3. 普通段落、列表、引用按行累积，token 达 chunkSize 时 flush
 *    → 累积中遇单段仍超 chunkSize，退到 recursiveSplit 切分
 *
 * 输入：原始 markdown 文本（不要预转 HTML——那样会丢结构）
 */
import { marked } from 'marked';
import { recursiveSplit, type RecursiveOptions } from './recursive';
import { countTokens } from './tokenizer';

interface MdToken {
  type: string;
  text?: string;
  depth?: number;
  lang?: string;
  header?: Array<{ text: string }>;
  rows?: Array<Array<{ text: string }>>;
  align?: Array<'left' | 'right' | 'center' | null>;
  tokens?: any[];
  items?: any[];
}

export function markdownChunk(source: string, opts: RecursiveOptions): string[] {
  const md = source.replace(/\r\n/g, '\n');
  if (!md.trim()) return [];

  const tokens: MdToken[] = marked.lexer(md) as any;
  const out: string[] = [];
  const breadcrumb: string[] = [];   // breadcrumb[0]=H1, [1]=H2 ...
  let buf = '';
  let bufTokens = 0;

  /** 把 buf 写出去（带 prefix），处理 buf 自身 > chunkSize 的情况 */
  const flushBuf = () => {
    const t = buf.trim();
    if (!t) { buf = ''; bufTokens = 0; return; }
    const prefixed = prefixBreadcrumb(t, breadcrumb);
    if (countTokens(prefixed) <= opts.chunkSize) {
      out.push(prefixed);
    } else {
      // buf 仍超长：去掉 prefix 递归切，最后再统一加 prefix
      const subs = recursiveSplit(t, opts);
      for (const s of subs) out.push(prefixBreadcrumb(s, breadcrumb));
    }
    buf = '';
    bufTokens = 0;
  };

  for (const tok of tokens) {
    // 安全：marked.lexer 理论上不会返回 undefined/非对象 token，但加防御避免
    // "Cannot read properties of undefined (reading 'type'|'items'|'rows')" 类崩溃
    if (!tok || typeof tok !== 'object') continue;
    switch (tok.type) {
      case 'heading': {
        flushBuf();
        const depth = tok.depth ?? 1;
        while (breadcrumb.length >= depth) breadcrumb.pop();
        breadcrumb.push((tok.text ?? '').trim());
        break;
      }
      case 'code': {
        flushBuf();
        const lang = tok.lang || '';
        const body = tok.text ?? '';
        const wrapped = '```' + lang + '\n' + body + '\n```';
        if (countTokens(wrapped) <= opts.chunkSize) {
          out.push(prefixBreadcrumb(wrapped, breadcrumb));
        } else {
          // 切 code body，每段包同 fence
          const lines = body.split('\n');
          const fenceOpen = '```' + lang + '\n';
          const fenceClose = '\n```';
          const overhead = countTokens(fenceOpen + fenceClose);
          const limit = Math.max(64, opts.chunkSize - overhead);
          const sub: string[] = [];
          let cur = '';
          let curT = 0;
          for (const line of lines) {
            const lt = countTokens(line + '\n');
            if (curT + lt > limit && cur.trim()) {
              sub.push(fenceOpen + cur + fenceClose);
              cur = line + '\n';
              curT = lt;
            } else {
              cur += line + '\n';
              curT += lt;
            }
          }
          if (cur.trim()) sub.push(fenceOpen + cur + fenceClose);
          for (const s of sub) out.push(prefixBreadcrumb(s, breadcrumb));
        }
        break;
      }
      case 'table': {
        flushBuf();
        const mdTable = renderTable(tok);
        if (countTokens(mdTable) <= opts.chunkSize) {
          out.push(prefixBreadcrumb(mdTable, breadcrumb));
        } else {
          // 切表格行，每段保留 header
          const headerMd = renderTable(tok, true);
          const headerT = countTokens(headerMd);
          const limit = Math.max(64, opts.chunkSize - headerT - 1);
          const sub: string[] = [];
          let cur = headerMd;
          let curT = headerT;
          for (const row of Array.isArray(tok.rows) ? tok.rows : []) {
            if (!Array.isArray(row)) continue;
            const rowText = '| ' + row.map((c) => ((c && c.text) ?? '').replace(/\|/g, '\\|')).join(' | ') + ' |';
            const rt = countTokens(rowText + '\n');
            if (curT + rt > limit && cur.trim() !== headerMd.trim()) {
              sub.push(cur);
              cur = headerMd + '\n' + rowText;
              curT = headerT + rt;
            } else {
              cur += '\n' + rowText;
              curT += rt;
            }
          }
          if (cur.trim()) sub.push(cur);
          for (const s of sub) out.push(prefixBreadcrumb(s, breadcrumb));
        }
        break;
      }
      case 'paragraph': {
        const text = tok.text ?? '';
        const t = countTokens(text);
        if (bufTokens + t > opts.chunkSize && buf.trim()) flushBuf();
        buf = buf ? buf + '\n\n' + text : text;
        bufTokens = countTokens(buf);
        break;
      }
      case 'list': {
        const items = Array.isArray(tok.items) ? tok.items : [];
        for (const it of items) {
          if (!it) continue;
          const text = (it.text ?? '').replace(/\n/g, '\n  ');
          const t = countTokens(text);
          if (bufTokens + t > opts.chunkSize && buf.trim()) flushBuf();
          buf = buf ? buf + '\n' + text : text;
          bufTokens = countTokens(buf);
        }
        break;
      }
      case 'blockquote': {
        const text = (tok.text ?? '').split('\n').map((l) => '> ' + l).join('\n');
        const t = countTokens(text);
        if (bufTokens + t > opts.chunkSize && buf.trim()) flushBuf();
        buf = buf ? buf + '\n\n' + text : text;
        bufTokens = countTokens(buf);
        break;
      }
      case 'hr':
        flushBuf();
        out.push(prefixBreadcrumb('---', breadcrumb));
        break;
      case 'space':
      case 'def':
        break;
      default:
        if (tok.text) {
          const t = countTokens(tok.text);
          if (bufTokens + t > opts.chunkSize && buf.trim()) flushBuf();
          buf = buf ? buf + '\n\n' + tok.text : tok.text;
          bufTokens = countTokens(buf);
        }
        break;
    }
  }
  flushBuf();
  return out;
}

function prefixBreadcrumb(text: string, breadcrumb: string[]): string {
  if (breadcrumb.length === 0) return text;
  return `【${breadcrumb.join(' > ')}】\n\n` + text;
}

function renderTable(tok: MdToken, headerOnly = false): string {
  const align = tok.align ?? [];
  const cells = (c: { text: string }) => (c.text ?? '').replace(/\|/g, '\\|');
  const headerLine = '| ' + (tok.header ?? []).map(cells).join(' | ') + ' |';
  const sepLine = '| ' + (tok.header ?? []).map((_, i) => {
    const a = align[i];
    if (a === 'left') return ':---';
    if (a === 'right') return '---:';
    if (a === 'center') return ':---:';
    return '---';
  }).join(' | ') + ' |';
  if (headerOnly) return headerLine + '\n' + sepLine;
  const rows = (tok.rows ?? []).map((r) => '| ' + r.map(cells).join(' | ') + ' |').join('\n');
  return headerLine + '\n' + sepLine + '\n' + rows;
}
