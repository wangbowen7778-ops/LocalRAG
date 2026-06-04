/**
 * 本地持久化：基于 sql.js（纯 WASM SQLite），无需 native 编译
 * - 全量数据先加载到内存；每次写操作后 export 落盘
 * - 适合桌面场景：单用户、写入不频繁、数据量 < 100MB
 *
 * 关键点：
 * - sql.js 的 initSqlJs() 是异步的（加载 WASM），所以 initStorage() 改为 async
 * - 其余函数保持同步；调用方需在 app.whenReady 后先 await initStorage()
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import type { Settings, KnowledgeBase, Document, Session, Message, ProviderConfig } from '../shared/types';

let userDataDir = '';
let SQL: SqlJsStatic | null = null;
let db: Database | null = null;

const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  chunkSize: 500,
  chunkOverlap: 50,
  topK: 5,
  temperature: 0.7,
  language: 'zh-CN',
  autoLaunch: false,
};

// ===== 基础工具 =====
export function getUserDataDir(): string {
  if (!userDataDir) userDataDir = app.getPath('userData');
  return userDataDir;
}

function dbFilePath(): string {
  return path.join(getUserDataDir(), 'chat.db');
}

function persist() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(dbFilePath(), Buffer.from(data));
}

function getDb(): Database {
  if (!db) throw new Error('Storage not initialized. Call await initStorage() first.');
  return db;
}

/**
 * 类似 better-sqlite3 的 prepare 包装：
 *   stmt.run(...args)  stmt.get(...args)  stmt.all(...args)
 */
function prep(sql: string) {
  return {
    run: (...params: (string | number | boolean | null)[]) => {
      const s = getDb().prepare(sql);
      try {
        s.run(params as any);
      } finally {
        s.free();
      }
      persist();
    },
    get: (...params: (string | number | boolean | null)[]): Record<string, unknown> | null => {
      const s = getDb().prepare(sql);
      try {
        if (params.length) s.bind(params as any);
        const has = s.step();
        return has ? (s.getAsObject() as Record<string, unknown>) : null;
      } finally {
        s.free();
      }
    },
    all: (...params: (string | number | boolean | null)[]): Record<string, unknown>[] => {
      const s = getDb().prepare(sql);
      try {
        if (params.length) s.bind(params as any);
        const rows: Record<string, unknown>[] = [];
        while (s.step()) rows.push(s.getAsObject() as Record<string, unknown>);
        return rows;
      } finally {
        s.free();
      }
    },
  };
}

function exec(sql: string) {
  getDb().exec(sql);
  persist();
}

// ===== 初始化 =====
export async function initStorage(): Promise<void> {
  const dir = getUserDataDir();
  for (const sub of ['', 'index', 'cache', 'logs', 'tmp']) {
    const p = path.join(dir, sub);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }

  if (!SQL) {
    // 定位 WASM 文件：sql.js 的 package.json 已被 exports 屏蔽，
    // 直接用入口文件路径反推 dist 目录
    const sqlJsEntry = require.resolve('sql.js'); // → .../sql.js/dist/sql-wasm.js
    const distDir = path.dirname(sqlJsEntry); // → .../sql.js/dist
    SQL = await initSqlJs({
      locateFile: (file: string) => path.join(distDir, file),
    });
  }

  if (db) return;

  const file = dbFilePath();
  let data: Uint8Array | undefined;
  if (fs.existsSync(file)) {
    data = new Uint8Array(fs.readFileSync(file));
  }
  db = data ? new SQL.Database(data) : new SQL.Database();

  // 迁移：建表
  exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      base_url TEXT NOT NULL,
      chat_model TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      reasoning_model TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      doc_count INTEGER DEFAULT 0,
      chunk_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      status TEXT NOT NULL,
      chunk_count INTEGER DEFAULT 0,
      error_message TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_documents_kb ON documents(kb_id);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_kb ON sessions(kb_id);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      citations TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  `);

  // 初始化默认设置
  const row = prep('SELECT value FROM settings WHERE key = ?').get('main');
  if (!row) {
    prep('INSERT INTO settings (key, value) VALUES (?, ?)').run('main', JSON.stringify(DEFAULT_SETTINGS));
  }

  // 迁移：v1.1.4 之前 embedding_model 字段曾被误用为「思考模型」，
  // 这里把旧值搬到 reasoning_model 列，embedding_model 重置为合理默认
  const provCols = prep("PRAGMA table_info(providers)").all() as { name: string }[];
  if (!provCols.some((c) => c.name === 'reasoning_model')) {
    exec('ALTER TABLE providers ADD COLUMN reasoning_model TEXT');
    // 旧值是「思考模型」；按 id 关键词回填 reasoning_model 并把 embedding_model 复位
    const rows = prep('SELECT id, embedding_model FROM providers').all() as {
      id: string;
      embedding_model: string;
    }[];
    for (const r of rows) {
      const rid = (r.id || '').toLowerCase();
      const fallbackReasoning = r.embedding_model; // 旧值直接搬到 reasoning
      const fallbackEmbedding = rid.startsWith('qwen')
        ? 'text-embedding-v3'
        : 'text-embedding-3-small';
      prep('UPDATE providers SET reasoning_model = ?, embedding_model = ? WHERE id = ?').run(
        fallbackReasoning,
        fallbackEmbedding,
        r.id,
      );
    }
  }
}

// ===== Settings =====
export function getSettings(): Settings {
  const row = prep('SELECT value FROM settings WHERE key = ?').get('main') as
    | { value: string }
    | null;
  return row ? { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) } : DEFAULT_SETTINGS;
}

export function updateSettings(partial: Partial<Settings>): Settings {
  const current = getSettings();
  const next = { ...current, ...partial };
  prep('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('main', JSON.stringify(next));
  return next;
}

// ===== Providers =====
export function listProviders(): ProviderConfig[] {
  return (
    prep('SELECT * FROM providers ORDER BY created_at ASC').all() as any[]
  ).map((r) => ({
    id: r.id,
    label: r.label,
    baseUrl: r.base_url,
    chatModel: r.chat_model,
    embeddingModel: r.embedding_model,
    reasoningModel: r.reasoning_model ?? undefined,
    hasApiKey: false, // 由 IPC 层补
  }));
}

export function upsertProvider(p: Omit<ProviderConfig, 'hasApiKey'>): void {
  prep(
    `INSERT INTO providers (id, label, base_url, chat_model, embedding_model, reasoning_model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       label=excluded.label,
       base_url=excluded.base_url,
       chat_model=excluded.chat_model,
       embedding_model=excluded.embedding_model,
       reasoning_model=excluded.reasoning_model`,
  ).run(
    p.id,
    p.label,
    p.baseUrl,
    p.chatModel,
    p.embeddingModel,
    p.reasoningModel ?? null,
    Date.now(),
  );
}

export function deleteProviderRow(id: string): void {
  prep('DELETE FROM providers WHERE id = ?').run(id);
}

// ===== KnowledgeBase =====
export function listKBs(): KnowledgeBase[] {
  return (prep('SELECT * FROM knowledge_bases ORDER BY created_at DESC').all() as any[]).map(mapKB);
}

export function getKB(id: string): KnowledgeBase | null {
  const r = prep('SELECT * FROM knowledge_bases WHERE id = ?').get(id) as any;
  return r ? mapKB(r) : null;
}

export function createKB(name: string, description?: string): KnowledgeBase {
  const id = 'kb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = Date.now();
  prep(
    `INSERT INTO knowledge_bases (id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, description ?? null, now, now);
  return {
    id,
    name,
    description,
    docCount: 0,
    chunkCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function renameKB(id: string, name: string): void {
  prep('UPDATE knowledge_bases SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
}

export function deleteKB(id: string): void {
  prep('DELETE FROM knowledge_bases WHERE id = ?').run(id);
}

export function updateKBStats(id: string, docDelta: number, chunkDelta: number): void {
  prep(
    `UPDATE knowledge_bases
     SET doc_count = doc_count + ?,
         chunk_count = chunk_count + ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(docDelta, chunkDelta, Date.now(), id);
}

function mapKB(r: any): KnowledgeBase {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    docCount: r.doc_count,
    chunkCount: r.chunk_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ===== Documents =====
export function listDocs(kbId: string): Document[] {
  return (prep('SELECT * FROM documents WHERE kb_id = ? ORDER BY created_at DESC').all(kbId) as any[]).map(
    (r) => ({
      id: r.id,
      kbId: r.kb_id,
      filename: r.filename,
      size: r.size,
      mimeType: r.mime_type,
      status: r.status,
      chunkCount: r.chunk_count,
      errorMessage: r.error_message ?? undefined,
      createdAt: r.created_at,
    }),
  );
}

export function createDoc(d: Omit<Document, 'chunkCount' | 'createdAt'> & { chunkCount?: number }): void {
  prep(
    `INSERT INTO documents (id, kb_id, filename, size, mime_type, status, chunk_count, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    d.id,
    d.kbId,
    d.filename,
    d.size,
    d.mimeType,
    d.status,
    d.chunkCount ?? 0,
    d.errorMessage ?? null,
    Date.now(),
  );
}

export function updateDocStatus(
  id: string,
  status: Document['status'],
  chunkCount?: number,
  errorMessage?: string,
): void {
  if (chunkCount !== undefined) {
    prep('UPDATE documents SET status = ?, chunk_count = ?, error_message = ? WHERE id = ?').run(
      status,
      chunkCount,
      errorMessage ?? null,
      id,
    );
  } else {
    prep('UPDATE documents SET status = ?, error_message = ? WHERE id = ?').run(
      status,
      errorMessage ?? null,
      id,
    );
  }
}

export function getDoc(id: string): Document | null {
  const r = prep('SELECT * FROM documents WHERE id = ?').get(id) as any;
  if (!r) return null;
  return {
    id: r.id,
    kbId: r.kb_id,
    filename: r.filename,
    size: r.size,
    mimeType: r.mime_type,
    status: r.status,
    chunkCount: r.chunk_count,
    errorMessage: r.error_message ?? undefined,
    createdAt: r.created_at,
  };
}

export function deleteDoc(id: string): void {
  prep('DELETE FROM documents WHERE id = ?').run(id);
}

// ===== Sessions & Messages =====
export function createSession(kbId: string, title = '新对话'): Session {
  const id = 'sess_' + Date.now().toString(36);
  const now = Date.now();
  prep('INSERT INTO sessions (id, kb_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    kbId,
    title,
    now,
    now,
  );
  return { id, kbId, title, createdAt: now, updatedAt: now, messageCount: 0 };
}

export function listSessions(kbId?: string): Session[] {
  const rows = kbId
    ? (prep('SELECT * FROM sessions WHERE kb_id = ? ORDER BY updated_at DESC').all(kbId) as any[])
    : (prep('SELECT * FROM sessions ORDER BY updated_at DESC').all() as any[]);
  return rows.map((r) => {
    const cnt = (prep('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(r.id) as any).c;
    return {
      id: r.id,
      kbId: r.kb_id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      messageCount: cnt,
    };
  });
}

export function getSession(id: string): Session | null {
  const r = prep('SELECT * FROM sessions WHERE id = ?').get(id) as any;
  if (!r) return null;
  const cnt = (prep('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(id) as any).c;
  return {
    id: r.id,
    kbId: r.kb_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: cnt,
  };
}

export function touchSession(id: string, title?: string): void {
  if (title) {
    prep('UPDATE sessions SET updated_at = ?, title = ? WHERE id = ?').run(Date.now(), title, id);
  } else {
    prep('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }
}

export function deleteSession(id: string): void {
  prep('DELETE FROM sessions WHERE id = ?').run(id);
}

export function addMessage(m: Omit<Message, 'createdAt'>): void {
  prep(
    'INSERT INTO messages (id, session_id, role, content, citations, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    m.id,
    m.sessionId,
    m.role,
    m.content,
    m.citations ? JSON.stringify(m.citations) : null,
    Date.now(),
  );
}

export function listMessages(sessionId: string): Message[] {
  return (prep('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as any[]).map(
    (r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      content: r.content,
      citations: r.citations ? JSON.parse(r.citations) : undefined,
      createdAt: r.created_at,
    }),
  );
}

export function closeStorage(): void {
  if (db) {
    persist();
    db.close();
    db = null;
  }
}
