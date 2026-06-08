/**
 * PDF 版面感知：把 pdfjs text items 重排为带段落结构的纯文本
 *
 * 输入约束（轻量版）：
 * - 不做分栏检测（双栏论文容易误判）
 * - 只做：按 (页, y 降序, x 升序) 排版阅读序
 * - y-gap > 行高 * 1.5 时插段落分隔 \n\n（同一段内的多行不插）
 * - 跨页重复文字视为页眉/页脚，跳过（> 50% 页面出现且 y 落在上下边带 5%）
 *
 * 输出是普通字符串，后续交给 recursiveSplit 切 token。
 *
 * 注意：OCR 路径拿不到带坐标的 items，这一步不适用——文本层 PDF 才走这里。
 */
/** pdfjs text item 投影后的最小字段（与 pdfjs 自身解耦，便于单测） */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  hasEOL: boolean;
  page: number;        // 0-indexed
}

/** pdfjs 视口高度（同一文档各页一致；不一致时取最大值） */
export interface PdfItemsContext {
  items: PdfTextItem[];
  pageHeight: number;
}

/** 把 items 重排为带段落的纯文本 */
export function pdfItemsToText(ctx: PdfItemsContext): string {
  // 防御：ctx / items 为 undefined 时返回空串，避免上层"reading 'items'"崩溃
  if (!ctx || !Array.isArray(ctx.items)) return '';
  const { items, pageHeight } = ctx;
  if (items.length === 0) return '';

  // 1) 算行高（中位数 y 间距），用于判定"是否换行"和"是否换段"
  const ySorted = items.map((it) => it.y).sort((a, b) => b - a);
  const lineHeight = estimateLineHeight(ySorted, pageHeight);
  const paragraphGap = lineHeight * 1.6;

  // 2) 按页聚合；同一页内按 y 降序 + x 升序
  const byPage = new Map<number, PdfTextItem[]>();
  for (const it of items) {
    const p = it.page ?? 0;
    if (!byPage.has(p)) byPage.set(p, []);
    byPage.get(p)!.push(it);
  }
  const pageNums = Array.from(byPage.keys()).sort((a, b) => a - b);

  // 3) 检测页眉/页脚：在 ≥ 50% 页面的顶部 5% / 底部 5% y 区域出现的文字视为页眉/页脚
  const headerFooterMask = detectHeaderFooter(items, pageHeight, pageNums.length);
  const totalPages = pageNums.length;

  const lines: string[] = [];
  let prevY: number | null = null;

  for (let pageIdx = 0; pageIdx < pageNums.length; pageIdx++) {
    const p = pageNums[pageIdx];
    const pageItems = byPage.get(p)!.sort((a, b) => {
      // y 降序（PDF 坐标 y=0 在底部，y 大在上）；同 y 按 x 升序
      if (Math.abs(a.y - b.y) > lineHeight * 0.4) return b.y - a.y;
      return a.x - b.x;
    });

    // 跨页：每个新页面前插一次段落分隔
    if (pageIdx > 0 && lines.length && !lines[lines.length - 1].endsWith('\n\n')) {
      lines.push('\n\n');
    }

    for (const it of pageItems) {
      // 跳过页眉/页脚
      if (headerFooterMask.has(it.str.trim())) continue;

      // 同页内：y 差判定换行/换段
      if (prevY !== null) {
        const dy = prevY - it.y;
        if (dy > paragraphGap) {
          if (lines.length && !lines[lines.length - 1].endsWith('\n\n')) {
            lines.push('\n\n');
          }
        } else if (dy > lineHeight * 0.4) {
          if (lines.length && !lines[lines.length - 1].endsWith('\n')) {
            lines.push('\n');
          }
        }
        // 同行：不主动补空格——靠 item 自身的 hasEOL/whitespace 处理
      }

      // 推 item 内容（空白 item 只让 hasEOL 生效）
      if (it.str.length > 0) {
        const last = lines.length > 0 ? lines[lines.length - 1] : '';
        // 有实际内容时：若上一个 chunk 末尾不是空白/换行，补一个空格
        if (it.str.trim() && last && !last.endsWith(' ') && !last.endsWith('\n')) {
          lines.push(' ');
        }
        lines.push(it.str);
      }
      if (it.hasEOL) lines.push('\n');
      prevY = it.y;
    }
  }
  void totalPages;
  return lines.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function estimateLineHeight(ySortedDesc: number[], pageHeight: number): number {
  if (ySortedDesc.length < 2) return pageHeight / 50;   // 兜底：约 50 行/页
  // 找相邻 y 差值的中位数
  const diffs: number[] = [];
  for (let i = 1; i < ySortedDesc.length; i++) {
    const d = Math.abs(ySortedDesc[i] - ySortedDesc[i - 1]);
    if (d > 0 && d < pageHeight / 5) diffs.push(d);   // 排除跨段的大间隔
  }
  if (diffs.length === 0) return pageHeight / 50;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] || pageHeight / 50;
}

function detectHeaderFooter(items: PdfTextItem[], pageHeight: number, totalPages: number): Set<string> {
  // 上下边带 5% 算页眉/页脚区
  const topBand = pageHeight * 0.95;
  const bottomBand = pageHeight * 0.05;
  // 把数字归一化为 'N'，这样 "第 1 页" / "第 2 页" / "第 3 页" 共享同一 key
  const rawToKey = new Map<string, string>();
  const occurrence = new Map<string, Set<number>>();
  for (const it of items) {
    if (it.y >= topBand || it.y <= bottomBand) {
      const raw = it.str.trim();
      if (!raw) continue;
      const key = raw.replace(/\d+/g, 'N');
      rawToKey.set(raw, key);
      if (!occurrence.has(key)) occurrence.set(key, new Set());
      occurrence.get(key)!.add(it.page ?? 0);
    }
  }
  // 出现页面数 ≥ 一半的视为页眉/页脚；返回原始 raw 集合以便精确查询
  const skipRaws = new Set<string>();
  const threshold = Math.max(2, Math.ceil(totalPages * 0.5));
  for (const [r, k] of rawToKey) {
    if ((occurrence.get(k)?.size ?? 0) >= threshold) skipRaws.add(r);
  }
  return skipRaws;
}
