/**
 * 知识库相关状态管理
 */
import { useEffect, useState, useCallback } from 'react';
import { api, safeCall, toast } from '../services/electronAPI';
import type { KnowledgeBase, Document, DocProgressEvent } from '../types';

export function useKnowledgeBase() {
  const [kbs, setKBs] = useState<KnowledgeBase[]>([]);
  const [activeKB, setActiveKB] = useState<KnowledgeBase | null>(null);
  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(false);
  const [progressMap, setProgressMap] = useState<Record<string, DocProgressEvent>>({});

  // 加载知识库列表
  const refreshKBs = useCallback(async () => {
    setLoading(true);
    const list = (await safeCall(api.listKBs, '加载知识库失败')) ?? [];
    setKBs(list);
    setLoading(false);

    // 自动选中第一个
    setActiveKB((cur) => {
      if (cur && list.find((k) => k.id === cur.id)) return cur;
      return list[0] ?? null;
    });
  }, []);

  useEffect(() => {
    refreshKBs();
  }, [refreshKBs]);

  // 切换 KB 时加载文档
  useEffect(() => {
    if (!activeKB) {
      setDocs([]);
      return;
    }
    (async () => {
      const list = (await safeCall(() => api.listDocs(activeKB.id), '加载文档失败')) ?? [];
      setDocs(list);
    })();
  }, [activeKB]);

  // 订阅文档上传进度
  useEffect(() => {
    const off = api.on('doc:progress', (e: DocProgressEvent) => {
      setProgressMap((m) => ({ ...m, [e.docId]: e }));
      if (e.stage === 'done') {
        // 完成后刷新列表
        if (activeKB) {
          api.listDocs(activeKB.id).then((list) => setDocs(list));
          refreshKBs();
        }
        setTimeout(() => {
          setProgressMap((m) => {
            const { [e.docId]: _, ...rest } = m;
            return rest;
          });
        }, 1500);
      }
    });
    return off;
  }, [activeKB, refreshKBs]);

  const create = async (name: string, description?: string) => {
    const kb = await safeCall(() => api.createKB(name, description), '创建失败');
    if (kb) {
      toast('success', `已创建「${kb.name}」`);
      await refreshKBs();
      setActiveKB(kb);
    }
    return kb;
  };

  const remove = async (id: string) => {
    const ok = await safeCall(() => api.deleteKB(id), '删除失败');
    if (ok !== null) {
      toast('success', '已删除');
      await refreshKBs();
    }
  };

  const rename = async (id: string, name: string) => {
    const ok = await safeCall(() => api.renameKB(id, name), '重命名失败');
    if (ok !== null) {
      toast('success', '已重命名');
      await refreshKBs();
    }
  };

  const upload = async (kbId: string) => {
    const fps = await window.api.doc.pick();
    if (!fps || fps.length === 0) return [];

    // 立即并发提交：每个 doc 写一条 status=pending 记录就返回，1000 个文件也在秒级完成
    // 重活（解析/OCR/Embedding）由主进程上传队列全局限并发（3）慢慢跑
    const registered = await Promise.all(
      fps.map((fp) =>
        safeCall(() => window.api.doc.upload(kbId, fp), `上传失败：${fp.split(/[\\/]/).pop()}`),
      ),
    );
    const ok = registered.filter((d): d is Document => d !== null);
    if (ok.length === 0) return [];

    toast(
      'info',
      ok.length === 1
        ? `已加入队列：${ok[0].filename}`
        : `已加入队列：${ok.length} 个文档（后台异步处理）`,
    );

    // 立即刷一次列表——所有 pending 文档瞬间可见
    if (activeKB?.id === kbId) {
      const list = (await safeCall(() => api.listDocs(kbId), '加载文档失败')) ?? [];
      setDocs(list);
    }
    await refreshKBs();

    return ok;
  };

  const removeDoc = async (docId: string) => {
    const ok = await safeCall(() => api.deleteDoc(docId), '删除文档失败');
    if (ok !== null && activeKB) {
      const list = (await safeCall(() => api.listDocs(activeKB.id), '刷新失败')) ?? [];
      setDocs(list);
      await refreshKBs();
    }
  };

  const getDocChunks = async (docId: string) => {
    if (!activeKB) return [];
    return safeCall(() => api.getDocChunks(activeKB.id, docId), '加载分块失败') ?? [];
  };

  return {
    kbs,
    activeKB,
    setActiveKB,
    docs,
    loading,
    progressMap,
    create,
    remove,
    rename,
    upload,
    removeDoc,
    getDocChunks,
    refresh: refreshKBs,
  };
}
