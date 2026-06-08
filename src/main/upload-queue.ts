/**
 * 主进程上传队列：
 * - DOC_UPLOAD 立即返回（轻量：只写一条 status='pending' 的文档记录），
 *   把重活（解析 / OCR / Embedding / 写向量索引）丢进这个队列后台慢慢跑
 * - 全局并发限制，避免 1000 个文件同时触发 Embedding API 限流 / sql.js 写锁风暴
 * - 应用重启时未完成的 pending/processing 文档由调用方决定如何恢复
 */
import { IPC } from '../shared/constants';
import { processAndIndexDoc } from './document-processor';
import { updateDocStatus, updateKBStats } from './storage';
import type { DocProgressEvent } from '../shared/types';

export interface UploadJob {
  docId: string;
  kbId: string;
  filePath: string;
  mimeType: string;
}

/** 极简的「拿主窗口」接口，避免这里再 import electron 整套 */
export type WindowGetter = () => { webContents: { send: (ch: string, data: unknown) => void }; isDestroyed: () => boolean } | null;

export class UploadQueue {
  private queue: UploadJob[] = [];
  private running = 0;
  // 全局并发：3 是经验值——既不撞 Embedding 限流，又让用户看着进度条在动
  private readonly MAX_CONCURRENCY = 3;

  constructor(private getMainWindow: WindowGetter) {}

  /** 当前正在跑 + 排队等待的总数（用于 UI 显示「N 个待处理」） */
  get pendingCount(): number {
    return this.running + this.queue.length;
  }

  enqueue(job: UploadJob): void {
    this.queue.push(job);
    this.tick();
  }

  private tick(): void {
    while (this.running < this.MAX_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      // finally 兜底：单个失败不影响后续 worker
      this.processJob(job).finally(() => {
        this.running--;
        this.tick();
      });
    }
  }

  private emitProgress(
    docId: string,
    stage: DocProgressEvent['stage'],
    percent: number,
    message?: string,
  ): void {
    const w = this.getMainWindow();
    if (w && !w.isDestroyed()) {
      w.webContents.send(IPC.EVT_DOC_PROGRESS, { docId, stage, percent, message });
    }
  }

  private async processJob(job: UploadJob): Promise<void> {
    try {
      // 切到 processing：UI 立即看到状态变化（独立 docId 各自的进度条会动起来）
      updateDocStatus(job.docId, 'processing', 0);
      const chunkCount = await processAndIndexDoc({
        docId: job.docId,
        kbId: job.kbId,
        filePath: job.filePath,
        mimeType: job.mimeType,
        onProgress: (stage, percent, message) =>
          this.emitProgress(job.docId, stage, percent, message),
      });
      updateDocStatus(job.docId, 'ready', chunkCount);
      updateKBStats(job.kbId, 1, chunkCount);
      this.emitProgress(job.docId, 'done', 100);
    } catch (e) {
      const err = e as Error;
      const msg = err.message ?? String(e);
      // 主进程日志里打完整堆栈，方便定位"reading 'items'"等隐式 bug
      console.error(`[upload] 失败：${job.filePath}\n${err.stack ?? msg}`);
      updateDocStatus(job.docId, 'failed', 0, msg);
      // 仍然发 done 事件，让渲染端的 progressMap 清理掉
      this.emitProgress(job.docId, 'done', 100, msg);
    }
  }
}
