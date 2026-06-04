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
    const doc = await api.pickAndUpload(kbId);
    if (doc) {
      toast('info', `已加入队列：${doc.filename}`);
      if (activeKB?.id === kbId) {
        const list = (await safeCall(() => api.listDocs(kbId), '加载文档失败')) ?? [];
        setDocs(list);
      }
    }
    return doc;
  };

  const removeDoc = async (docId: string) => {
    const ok = await safeCall(() => api.deleteDoc(docId), '删除文档失败');
    if (ok !== null && activeKB) {
      const list = (await safeCall(() => api.listDocs(activeKB.id), '刷新失败')) ?? [];
      setDocs(list);
      await refreshKBs();
    }
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
    refresh: refreshKBs,
  };
}
