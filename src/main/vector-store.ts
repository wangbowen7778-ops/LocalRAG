/**
 * Vectra 本地向量库封装
 * 替代原 ChromaDB（python-bridge）。纯 JS 实现，零外部依赖。
 * 每个知识库在 userData/index/<kbId> 下：
 *   - index.json            主索引（Vectra 管理）
 *   - chunks.json           文本内容映射（id -> text）  ← 因为 IndexItem 不存 text
 *
 * 块 ID 格式：`<docId>__<chunkIndex>`（双下划线避免碰撞）
 * 块元数据：{ docId, filename, chunkIndex }
 */
import fs from 'node:fs';
import path from 'node:path';
// 直接 require 子模块，避免 vectra/index 拉入 WebFetcher → cheerio → undici（依赖浏览器 File API）
import { LocalIndex } from 'vectra/lib/LocalIndex';
import type { MetadataFilter } from 'vectra/lib/types';
import { getUserDataDir } from './storage';
import { VECTRA } from '../shared/constants';

export interface SearchHit {
  docId: string;
  filename: string;
  text: string;
  score: number;
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

/** 写入文本块 + 向量 */
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
}

/** 相似度检索 */
export async function vectorSearch(
  kbId: string,
  queryVec: number[],
  topK: number,
): Promise<SearchHit[]> {
  const index = await getIndex(kbId);
  const textMap = loadTextMap(kbId);
  // vectra 0.15+ 签名: queryItems(vector, queryText, topK, filter?, isBm25?)
  // 我们只做向量检索，queryText 传空串关闭 BM25
  const results = await index.queryItems(queryVec, '', topK);
  return results.map((r) => {
    const meta = r.item.metadata as unknown as ItemMeta;
    return {
      docId: meta.docId ?? '',
      filename: meta.filename ?? '',
      text: textMap[r.item.id] ?? '',
      score: r.score,
    };
  });
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
}

/** 删除整个知识库的索引目录 */
export async function deleteCollection(kbId: string) {
  indexCache.delete(kbId);
  textCache.delete(kbId);
  const dir = path.join(getUserDataDir(), VECTRA.INDEX_DIR, kbId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
