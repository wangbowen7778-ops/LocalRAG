/**
 * BM25 文本索引模块
 *
 * 与 vector-store 平行：vectra 负责向量检索，本模块负责 BM25 词频检索。
 * 检索层在 vector-store.ts 的 hybridSearch 中用 RRF 融合两路结果。
 *
 * 持久化策略：
 * - `bm25.docs.json`：主文档映射（id → {text, docId, filename, chunkIndex}）
 *   这是 source of truth；engine 是 derived view，每次变更后从主映射重建
 * - 不持久化 engine 状态本身——wink-bm25 不允许 consolidate 之后 addDoc，
 *   所以"增量更新"在它身上不成立；用"小内存重建"代替"增量更新"
 *
 * 分词策略（自实现，避免引入 nodejieba 等 native 依赖）：
 * - 英文：[a-z0-9]+ 切 + lowercase，长度 >= 2，过滤停用词
 * - 中文：每个 CJK 字符单独成 unigram（Character n-gram trick，
 *   与 Lucene CJKAnalyzer 同思路，对中文短文本召回 OK）
 *
 * 性能：
 * - 重建 N 个 chunk 的 engine ≈ N × 0.1ms（典型），5000 chunks 约 0.5s
 * - 每次 addChunks 触发一次完整重建（addDoc/removeDoc 后必须重新 consolidate）
 */
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore - wink-bm25-text-search 无 .d.ts
import bm25 from 'wink-bm25-text-search';
import { getUserDataDir } from './storage';
import { VECTRA } from '../shared/constants';

export interface Bm25Meta {
  docId: string;
  filename: string;
  chunkIndex: number;
}
export interface Bm25Item extends Bm25Meta {
  id: string;
  text: string;
}

interface IndexState {
  engine: any;
  docs: Map<string, Bm25Item>;
  /** engine 是否已 consolidate——consolidate 后 addDoc 会抛错，需先 rebuild */
  consolidated: boolean;
}

const cache = new Map<string, IndexState>();

// 常见中英文停用词。BM25 召回前过滤，避免高频无意义词冲掉重要词的 IDF 贡献。
const STOPWORDS = new Set([
  // 中文
  '的', '了', '是', '在', '和', '与', '或', '及', '等', '也', '就', '都', '我', '你', '他', '她', '它', '们', '这', '那', '有', '没', '不', '要', '会', '能', '可', '把', '被', '从', '到', '给', '为', '上', '下', '中', '对', '以', '让', '但', '而', '并', '或', '之', '其', '此', '该', '此', '本', '上', '下',
  // 英文
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'of', 'to', 'in', 'on', 'at', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'with', 'by', 'as', 'this', 'that', 'these', 'those', 'it', 'its', 'we', 'you', 'they', 'i',
]);

/**
 * 轻量中英文分词：
 * - CJK（基本汉字区 U+4E00-U+9FFF）：每个字符作为一个 unigram token
 *   这是 BM25 在中文上的经典退化方案，对短文本召回尚可
 * - 拉丁/数字：连续 [a-z0-9]+ 作为一个 token，lowercase，长度 < 2 的丢掉
 * - 其它字符：跳过
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const s = text.toLowerCase();
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    // CJK Unified Ideographs: 0x4E00 - 0x9FFF
    if (c >= 0x4e00 && c <= 0x9fff) {
      tokens.push(s[i]);
      i++;
    } else if ((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a)) {
      // 数字 0-9, 字母 a-z
      let j = i;
      while (j < n) {
        const cc = s.charCodeAt(j);
        if (!((cc >= 0x30 && cc <= 0x39) || (cc >= 0x61 && cc <= 0x7a))) break;
        j++;
      }
      const w = s.slice(i, j);
      if (w.length >= 2 && !STOPWORDS.has(w)) tokens.push(w);
      i = j;
    } else {
      i++;
    }
  }
  return tokens;
}

function docsFilePath(kbId: string): string {
  return path.join(getUserDataDir(), VECTRA.INDEX_DIR, kbId, 'bm25.docs.json');
}

function ensureDir(kbId: string) {
  const dir = path.join(getUserDataDir(), VECTRA.INDEX_DIR, kbId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadDocsFromDisk(kbId: string): Map<string, Bm25Item> {
  const p = docsFilePath(kbId);
  if (!fs.existsSync(p)) return new Map();
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, Bm25Item>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function saveDocsToDisk(kbId: string, docs: Map<string, Bm25Item>) {
  ensureDir(kbId);
  const obj: Record<string, Bm25Item> = {};
  for (const [k, v] of docs) obj[k] = v;
  fs.writeFileSync(docsFilePath(kbId), JSON.stringify(obj));
}

/** 创建一个全新未 consolidate 的 engine（后续 addDoc 后再 consolidate） */
function createEngine() {
  const engine = bm25();
  // fldWeights 决定每个 field 对最终分数的权重（BM25F 的 F）。
  // 我们只用一个 field 'text'，权重 1；保留 docId/filename/chunkIndex 是为了
  // search 返回结果后能直接从 documents[id].fieldValues 里读到 meta，不必再查外部 map。
  // v1.2.9：b 0.75（wink-bm25 默认）→ 0.5——弱化 length normalization 力度。
  //   用户实测：长整章 chunk（"第一章/第二章/第三章/第六章" + 全部条款）含 query
  //   关键词次数多，tf 命中数 × IDF 远超 b=0.75 的 length norm 压低 → 整章 chunk
  //   把第四章子 chunk（第十九-二十二条，答案）顶到 BM25 rank=12。b=0.5 让 length norm
  //   力度减半，答案 chunk 的 BM25 排名能上移到 6-8 名。
  //   风险：短 chunk（FAQ/标题）可能相对冲前，但本项目 chunkSize=800 token 偏大，
  //   短 chunk 场景少；如果实测有副作用可再降到 0.3。
  engine.defineConfig({
    fldWeights: { text: 1 },
    ovFieldNames: ['docId', 'filename', 'chunkIndex'],
    b: 0.5,
  });
  engine.definePrepTasks([tokenize]);
  return engine;
}

/** 从 state.docs 完整重建 engine 并 consolidate。state.engine 被原子替换。 */
function rebuildEngine(state: IndexState) {
  const newEngine = createEngine();
  for (const [id, item] of state.docs) {
    newEngine.addDoc(
      { text: item.text, docId: item.docId, filename: item.filename, chunkIndex: item.chunkIndex },
      id,
    );
  }
  if (state.docs.size > 0) newEngine.consolidate();
  state.engine = newEngine;
  state.consolidated = state.docs.size > 0;
}

/** 加载或返回缓存的 index state。空 KB 也返回合法 state。 */
function loadIndex(kbId: string): IndexState {
  const cached = cache.get(kbId);
  if (cached) return cached;
  ensureDir(kbId);
  const docs = loadDocsFromDisk(kbId);
  const state: IndexState = { engine: createEngine(), docs, consolidated: false };
  if (docs.size > 0) rebuildEngine(state);
  cache.set(kbId, state);
  return state;
}

/**
 * 批量添加 chunks 到 BM25 索引（一次写入触发一次完整 rebuild，开销可接受）。
 * 同 id 已存在则覆盖（reindex 场景）。
 */
export function bm25AddDocs(kbId: string, items: Bm25Item[]): void {
  if (items.length === 0) return;
  const state = loadIndex(kbId);
  for (const it of items) {
    state.docs.set(it.id, { ...it });
  }
  saveDocsToDisk(kbId, state.docs);
  rebuildEngine(state);
}

/** 移除某文档的全部 chunks（删除文档时调用） */
export function bm25RemoveDocsByDocId(kbId: string, docId: string): void {
  const state = loadIndex(kbId);
  let changed = false;
  for (const [id, item] of state.docs) {
    if (item.docId === docId) {
      state.docs.delete(id);
      changed = true;
    }
  }
  if (!changed) return;
  saveDocsToDisk(kbId, state.docs);
  rebuildEngine(state);
}

/**
 * BM25 检索
 * @returns `[{ id, score }, ...]` 按 BM25 原始分数降序
 */
export function bm25Search(kbId: string, query: string, topK: number): Array<{ id: string; score: number }> {
  const state = loadIndex(kbId);
  if (!state.consolidated || state.docs.size === 0) return [];
  // wink-bm25.search 返回 [[id, score], ...]
  const raw: Array<[string, number]> = state.engine.search(query, Math.max(topK, 1));
  return raw.map(([id, score]) => ({ id, score }));
}

/** 清空某 KB 的 BM25 索引（删除整个知识库时调用） */
export function bm25Clear(kbId: string): void {
  cache.delete(kbId);
  const p = docsFilePath(kbId);
  if (fs.existsSync(p)) fs.rmSync(p, { force: true });
}

/** 重建某 KB 的 BM25 索引（从外部提供的 items 全量替换） */
export function bm25BulkLoad(kbId: string, items: Bm25Item[]): void {
  const state: IndexState = { engine: createEngine(), docs: new Map(), consolidated: false };
  for (const it of items) {
    state.docs.set(it.id, { ...it });
  }
  saveDocsToDisk(kbId, state.docs);
  rebuildEngine(state);
  cache.set(kbId, state);
}

/** 调试 / UI 用：当前索引里的 chunk 数 */
export function bm25DocCount(kbId: string): number {
  const state = loadIndex(kbId);
  return state.docs.size;
}
