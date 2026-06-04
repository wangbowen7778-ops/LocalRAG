// 直接 require 编译产物（dist/main），但把 storage 里的 userData 切到临时目录
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// 改写 storage.ts 里 getUserDataDir 的实现路径
import fs from 'node:fs';
import path from 'node:path';

// 直接跑一个 CommonJS 入口
const { spawnSync } = require('node:child_process');
const out = spawnSync(process.execPath, [
  '-e',
  `
  const { app } = require('electron');
  app.setPath('userData', 'D:/code/LocalRAG/_test_userdata');
  const { initStorage, listProviders, upsertProvider } = require('./dist/main/storage.js');
  (async () => {
    await initStorage();
    console.log('INITIAL:', JSON.stringify(listProviders()));
    upsertProvider({
      id: 'deepseek_test_123',
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      chatModel: 'deepseek-chat',
      embeddingModel: 'deepseek-reasoner',
    });
    console.log('AFTER INSERT:', JSON.stringify(listProviders()));
  })().catch(e => { console.error('ERR:', e); process.exit(1); });
  `,
], { encoding: 'utf-8' });
console.log('STDOUT:', out.stdout);
console.log('STDERR:', out.stderr);
