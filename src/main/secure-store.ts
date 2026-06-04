/**
 * API Key 安全存储：使用 keytar 写入 Windows 凭据管理器
 * 凭据条目命名：service=LocalRAG, account=<providerId>
 */
import keytar from 'keytar';
import { KEYTAR_SERVICE } from '../shared/constants';

export class SecureStore {
  /**
   * 写入或更新 API Key
   */
  static async setApiKey(providerId: string, apiKey: string): Promise<void> {
    if (!providerId) throw new Error('providerId 不能为空');
    if (!apiKey) throw new Error('apiKey 不能为空');
    await keytar.setPassword(KEYTAR_SERVICE, providerId, apiKey);
  }

  /**
   * 读取 API Key，未找到返回 null
   */
  static async getApiKey(providerId: string): Promise<string | null> {
    return await keytar.getPassword(KEYTAR_SERVICE, providerId);
  }

  /**
   * 删除 API Key
   */
  static async deleteApiKey(providerId: string): Promise<boolean> {
    return await keytar.deletePassword(KEYTAR_SERVICE, providerId);
  }

  /**
   * 检测是否已存在 Key（不返回明文）
   */
  static async hasApiKey(providerId: string): Promise<boolean> {
    const k = await keytar.getPassword(KEYTAR_SERVICE, providerId);
    return !!k;
  }

  /**
   * 应用卸载时清理（NSIS 可调用）
   */
  static async clearAll(): Promise<void> {
    const creds = await keytar.findCredentials(KEYTAR_SERVICE);
    await Promise.all(creds.map((c) => keytar.deletePassword(KEYTAR_SERVICE, c.account)));
  }
}
