/**
 * Electron 主进程入口
 * 职责：创建窗口、注册 IPC、管理应用生命周期
 * 已切换为纯 JS 栈（vectra + sql.js），无外部进程依赖
 */
import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from './ipc-handlers';
import { initStorage } from './storage';
import { APP_NAME } from '../shared/constants';

const isDev = process.env.NODE_ENV === 'development';

// 单实例锁：避免多开
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#0f172a',
    show: false, // 等渲染就绪再显示，避免白屏闪烁
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需要 keytar 等 Node API
    },
  });

  // 加载 Vite 开发服务器或生产构建
  if (isDev) {
    await mainWindow.loadURL('http://127.0.0.1:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // 外部链接走系统默认浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  // 1. 初始化存储（异步：加载 sql.js WASM）
  try {
    await initStorage();
  } catch (err) {
    app.quit();
    console.error('[initStorage] 失败', err);
    return;
  }

  // 2. 注册 IPC
  registerIpcHandlers(() => mainWindow);

  // 3. 创建窗口
  await createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 暴露给 ipc-handlers 用
export function getMainWindow() {
  return mainWindow;
}
