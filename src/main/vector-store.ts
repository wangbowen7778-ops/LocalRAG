/**
 * Vectra 本地向量库封装 + BM25 混合检索
 * 替代原 ChromaDB（python-bridge）。纯 JS 实现，零外部依赖。
 * 每个知识库在 userData/index/<kbId> 下：
 *   - index.json            主索引（Vectra 管理）
 *   - chunks.json           文本内容映射（id -> text）  ← 因为 IndexItem 不存 text
 *   - bm25.docs.json        BM25 索引的主文档映射（id -> {text, docId, filename, chunkIndex}）
 *
 * 块 ID 格式：`<docId>__<chunkIndex>`（双下划线避免碰撞），vectra 与 BM25 共用
 * 块元数据：{ docId, filename, chunkIndex }
 *
 * 检索：vectorSearch（纯向量）保留为内部；上层用 hybridSearch 走 RRF 融合向量 + BM25
 */
import fs from 'node:fs';
import path from 'node:path';
// 直接 require 子模块，避免 vectra/index 拉入 WebFetcher → cheerio → undici（依赖浏览器 File API）
import { LocalIndex } from 'vectra/lib/LocalIndex';
import type { MetadataFilter } from 'vectra/lib/types';
import { getUserDataDir } from './storage';
import { VECTRA } from '../shared/constants';
import { bm25AddDocs, bm25RemoveDocsByDocId, bm25Clear, bm25BulkLoad, bm25Search } from './bm25-store';

export interface SearchHit {
  docId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  score: number;
}

export interface DocChunk {
  chunkIndex: number;
  text: string;
}

interface ItemMeta {
  docId: string;
  filename: string;
  chunkIndex: number;
}

const indexCache = new Map<string, LocalIndex>();
const textCache = new Map<string, Record<string, string>>(); // kbId -> { itemId: text }

async function getIndex(kbId: string): Promise<LocalIndex> {
  const cached = indexCache.get(kbId);
  if (cached) return cached;

  const dir = path.join(getUserDataDir(), VECTRA.INDEX_DIR, kbId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const index = new LocalIndex(dir);
  if (!(await index.isIndexCreated())) {
    // 首次创建时把 docId 设为可过滤字段
    await index.createIndex({
      version: 1,
      metadata_config: { indexed: ['docId'] },
    });
  }
  indexCache.set(kbId, index);
  return index;
}

function textFilePath(kbId: string) {
  return path.join(getUserDataDir(), VECTRA.INDEX_DIR, kbId, 'chunks.json');
}

function loadTextMap(kbId: string): Record<string, string> {
  const cached = textCache.get(kbId);
  if (cached) return cached;
  const p = textFilePath(kbId);
  if (fs.existsSync(p)) {
    try {
      const map = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, string>;
      textCache.set(kbId, map);
      return map;
    } catch {
      return {};
    }
  }
  return {};
}

function saveTextMap(kbId: string, map: Record<string, string>) {
  textCache.set(kbId, map);
  const p = textFilePath(kbId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(map));
}

/** 写入文本块 + 向量（同时同步更新 BM25 索引） */
export async function addChunks(
  kbId: string,
  docId: string,
  filename: string,
  chunks: string[],
  vectors: number[][],
) {
  if (chunks.length !== vectors.length) throw new Error('chunks 与 vectors 长度不一致');
  if (chunks.length === 0) return;

  const index = await getIndex(kbId);
  const textMap = loadTextMap(kbId);

  for (let i = 0; i < chunks.length; i++) {
    const id = `${docId}__${i}`;
    const meta: ItemMeta = { docId, filename, chunkIndex: i };
    // upsertItem 行为：存在则替换；不存在则插入
    await index.upsertItem({
      id,
      vector: vectors[i],
      metadata: meta as unknown as Record<string, string | number | boolean>,
    });
    textMap[id] = chunks[i];
  }

  saveTextMap(kbId, textMap);

  // 同步 BM25：与 vectra 共用 id 格式，便于 hybridSearch 对齐
  bm25AddDocs(
    kbId,
    chunks.map((text, i) => ({
      id: `${docId}__${i}`,
      text,
      docId,
      filename,
      chunkIndex: i,
    })),
  );
}

/** 相似度检索（纯向量；上层请用 hybridSearch 走 RRF 融合 BM25） */
export async function vectorSearch(
  kbId: string,
  queryVec: number[],
  topK: number,
): Promise<SearchHit[]> {
  const index = await getIndex(kbId);
  const textMap = loadTextMap(kbId);
  // vectra 0.10.1 不支持 BM25 / hybrid。queryItems 的 queryText 参数被忽略。
  const results = await index.queryItems(queryVec, '', topK);
  return results.map((r) => {
    const meta = r.item.metadata as unknown as ItemMeta;
    return {
      docId: meta.docId ?? '',
      filename: meta.filename ?? '',
      chunkIndex: meta.chunkIndex ?? 0,
      text: textMap[r.item.id] ?? '',
      score: r.score,
    };
  });
}

/**
 * 混合检索：向量 + BM25，RRF（Reciprocal Rank Fusion）融合
 *
 * 公式：score(d) = Σ 1 / (k + rank_i(d))，k=60 是 RRF 论文推荐值
 * - 不依赖两路原始 score 的量级（BM25 无界、cos similarity [0,1]），绕开归一化难题
 * - 任一路为空 → 自动退化为只用另一路
 *
 * 对齐 key：`docId + '|' + chunkIndex`（chunks 唯一）
 * - 向量路召回的 chunk 用 `chunkIndex` 字段识别
 * - BM25 召回的 chunk 用 id 解析 `docId__<chunkIndex>`，再批量从 vectra 拉 meta
 *
 * @param enableBm25 false 时退化为纯向量检索（设置开关）
 */
export async function hybridSearch(
  kbId: string,
  queryText: string,
  queryVec: number[],
  topK: number,
  options: { enableBm25?: boolean } = {},
): Promise<SearchHit[]> {
  // 召回更多候选，让 RRF 融合后阈值过滤有意义。fetchK=4×topK 是个折衷：
  // 太小（2×）→ 候选都是各自 top-N，归一化后都过线，阈值等于失效
  // 太大（10×）→ 召回 + 融合成本上升
  const fetchK = topK * 4;
  const enableBm25 = options.enableBm25 !== false;

  // 两路并发
  const [vecHits, bm25Hits] = await Promise.all([
    vectorSearch(kbId, queryVec, fetchK),
    enableBm25 && queryText.trim()
      ? Promise.resolve(bm25Search(kbId, queryText, fetchK))
      : Promise.resolve([] as Array<{ id: string; score: number }>),
  ]);

  const RRF_K = 60;
  const fused = new Map<string, { hit: SearchHit; rrf: number }>();

  // 向量路：vecHits 已按 score 降序，rank 即数组下标
  for (let rank = 0; rank < vecHits.length; rank++) {
    const h = vecHits[rank];
    const key = h.docId + '|' + h.chunkIndex;
    const rrf = 1 / (RRF_K + rank + 1);
    fused.set(key, { hit: h, rrf });
  }

  // BM25 路：先尝试命中已有的（累加 rrf），没有的再去 vectra 拉 meta
  if (bm25Hits.length > 0) {
    const textMap = loadTextMap(kbId);
    const index = await getIndex(kbId);

    // 收集需要回查 vectra 的 id
    const needLookup: string[] = [];
    for (const b of bm25Hits) {
      const parts = b.id.split('__');
      const chunkIndex = parseInt(parts[parts.length - 1], 10);
      const docIdGuess = parts.slice(0, -1).join('__');
      const key = docIdGuess + '|' + chunkIndex;
      if (!fused.has(key)) needLookup.push(b.id);
    }

    // vectra 0.10.1 只有 getItem(id) 单查；顺序 await（fetchK=topK*2 不会太多）
    const looked: Record<string, { docId: string; filename: string; chunkIndex: number }> = {};
    for (const id of needLookup) {
      try {
        const it = await index.getItem(id);
        if (it) {
          const meta = it.metadata as unknown as ItemMeta;
          looked[id] = { docId: meta.docId, filename: meta.filename, chunkIndex: meta.chunkIndex };
        }
      } catch {
        // 单条失败不影响整体
      }
    }

    for (let rank = 0; rank < bm25Hits.length; rank++) {
      const b = bm25Hits[rank];
      const parts = b.id.split('__');
      const chunkIndex = parseInt(parts[parts.length - 1], 10);
      const docIdGuess = parts.slice(0, -1).join('__');
      const key = docIdGuess + '|' + chunkIndex;
      const rrf = 1 / (RRF_K + rank + 1);

      const existing = fused.get(key);
      if (existing) {
        existing.rrf += rrf;
        continue;
      }

      // BM25 独有命中：构造 SearchHit
      const meta = looked[b.id];
      const text = textMap[b.id] ?? '';
      if (!text || !meta) continue;
      fused.set(key, {
        hit: { docId: meta.docId, filename: meta.filename ?? '', chunkIndex, text, score: b.score },
        rrf,
      });
    }
  }

  // 按 rrf 降序取 topK；输出 score 归一化到 [0,1] 让既有 citationScoreThreshold 仍能工作。
  // 归一化公式：rrf / (2/(RRF_K+1)) = rrf * (RRF_K+1) / 2
  // 含义：1.0 = top of both lists；0.5 = top of one list only；0.0+ = 落在候选集尾部的"擦边"匹配
  // 阈值 0.4 在混合模式下 ≈ "在至少一路里进 top 1-2"
  const NORMALIZER = (RRF_K + 1) / 2; // 30.5
  return Array.from(fused.values())
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, topK)
    .map((f) => ({ ...f.hit, score: f.rrf * NORMALIZER }));
}

/**
 * 跨 KB 检索：每个 KB 并发调 hybridSearch（每路 fetchK=topK*3 留融合余量），
 * 用 docId|chunkIndex 做 key 全局 RRF 融合，输出 score 仍归一化到 [0,1]。
 *
 * - 单 KB 时直接走 hybridSearch 走 fastpath，省一层融合
 * - 多 KB 时各路并发；空 KB / 抛错时降级为"其他 KB 也能用"
 *
 * 适用：Agentic RAG 的 search_kb 工具（user 勾选多 KB 时）。
 */
export async function hybridSearchMulti(
  kbIds: string[],
  queryText: string,
  queryVec: number[],
  topK: number,
  options: { enableBm25?: boolean } = {},
): Promise<SearchHit[]> {
  if (kbIds.length === 0) return [];
  if (kbIds.length === 1) {
    return hybridSearch(kbIds[0], queryText, queryVec, topK, options);
  }

  const fetchK = topK * 3;
  // 任一 KB 检索失败不阻塞其他 KB
  const settled = await Promise.allSettled(
    kbIds.map((id) => hybridSearch(id, queryText, queryVec, fetchK, options)),
  );

  const RRF_K = 60;
  const NORMALIZER = (RRF_K + 1) / 2;
  const fused = new Map<string, { hit: SearchHit; rrf: number }>();

  settled.forEach((res) => {
    if (res.status !== 'fulfilled') return;
    const hits = res.value;
    hits.forEach((h, rank) => {
      const key = h.docId + '|' + h.chunkIndex;
      const rrf = 1 / (RRF_K + rank + 1);
      const existing = fused.get(key);
      if (existing) {
        existing.rrf += rrf;
      } else {
        fused.set(key, { hit: h, rrf });
      }
    });
  });

  return Array.from(fused.values())
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, topK)
    .map((f) => ({ ...f.hit, score: f.rrf * NORMALIZER }));
}

/**
 * 从 vectra 已有数据重建 BM25 索引（启动恢复时调用）。
 * 旧知识库可能只有 chunks.json + index.json，没有 bm25.docs.json——这里把 vectra 的
 * item meta + chunks.json 的 text 拼起来喂给 BM25 索引。
 *
 * 若 bm25.docs.json 已存在则跳过（避免覆盖运行期已写入的新数据）。
 */
export async function bm25RebuildFromVectra(kbId: string): Promise<number> {
  const dir = path.join(getUserDataDir(), VECTRA.INDEX_DIR, kbId);
  if (!fs.existsSync(dir)) return 0;

  // chunks.json 必须存在才需要重建（没有 chunks 就没有 BM25 内容可建）
  const chunksPath = path.join(dir, 'chunks.json');
  if (!fs.existsSync(chunksPath)) return 0;

  // 已存在 BM25 索引 → 跳过（保留运行期新增）
  const bm25Path = path.join(dir, 'bm25.docs.json');
  if (fs.existsSync(bm25Path)) return 0;

  const index = await getIndex(kbId);
  const textMap = loadTextMap(kbId);
  // vectra 0.10.1：listItems() 无参返回全部 item
  const allItems = await index.listItems();

  const items: Array<{ id: string; text: string; docId: string; filename: string; chunkIndex: number }> = [];
  for (const it of allItems) {
    const text = textMap[it.id];
    if (!text) continue;
    const meta = it.metadata as unknown as ItemMeta;
    items.push({
      id: it.id,
      text,
      docId: meta.docId,
      filename: meta.filename,
      chunkIndex: meta.chunkIndex ?? 0,
    });
  }

  bm25BulkLoad(kbId, items);
  return items.length;
}

/** 列出某文档的所有 chunk（按 chunkIndex 排序）——用于 UI 调试 / 验证向量化结果 */
export async function listChunksByDoc(kbId: string, docId: string): Promise<DocChunk[]> {
  const index = await getIndex(kbId);
  const items = await index.listItemsByMetadata({ docId });
  const textMap = loadTextMap(kbId);
  const out: DocChunk[] = items
    .map((it) => {
      const meta = it.metadata as unknown as ItemMeta;
      return {
        chunkIndex: meta.chunkIndex ?? 0,
        text: textMap[it.id] ?? '',
      };
    })
    .sort((a, b) => a.chunkIndex - b.chunkIndex);
  return out;
}

/** 删除某文档的所有块 */
export async function deleteChunksByDoc(kbId: string, docId: string) {
  const index = await getIndex(kbId);
  const filter: MetadataFilter = { docId };
  const items = await index.listItemsByMetadata(filter);
  for (const item of items) {
    await index.deleteItem(item.id);
  }
  const textMap = loadTextMap(kbId);
  let modified = false;
  for (const item of items) {
    if (textMap[item.id]) {
      delete textMap[item.id];
      modified = true;
    }
  }
  if (modified) saveTextMap(kbId, textMap);
  // 同步删除 BM25 中的 chunks
  bm25RemoveDocsByDocId(kbId, docId);
}

/** 删除整个知识库的索引目录 */
export async function deleteCollection(kbId: string) {
  indexCache.delete(kbId);
  textCache.delete(kbId);
  const dir = path.join(getUserDataDir(), VECTRA.INDEX_DIR, kbId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // 同步清空 BM25 缓存（实际文件已被上面 rmSync 一并删除）
  bm25Clear(kbId);
}
