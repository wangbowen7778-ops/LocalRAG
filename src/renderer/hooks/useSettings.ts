/**
 * 全局设置：主题、Provider 列表、当前默认
 */
import { useEffect, useState, useCallback } from 'react';
import { api, safeCall, toast } from '../services/electronAPI';
import type { Settings, ProviderConfig } from '../types';

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);

  const refresh = useCallback(async () => {
    const [s, p] = await Promise.all([api.getSettings(), api.listProviders()]);
    setSettings(s);
    setProviders(p);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 主题同步到 document
  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const apply = () => {
      const isDark =
        settings.theme === 'dark' ||
        (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.classList.toggle('dark', isDark);
    };
    apply();
    if (settings.theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [settings?.theme]);

  const update = async (partial: Partial<Settings>) => {
    const next = await safeCall(() => api.updateSettings(partial), '保存失败');
    if (next) {
      setSettings(next);
      toast('success', '已保存');
    }
  };

  return { settings, providers, update, refresh };
}
