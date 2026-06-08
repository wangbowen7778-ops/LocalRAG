/**
 * npm install 后的清理脚本
 * 1) 删除 pdfjs-dist 带来的可选依赖 node_modules/canvas（运行时根本不用，
 *    实际用的是 @napi-rs/canvas；canvas 会被 electron-builder 当成 native
 *    模块 rebuild，但 Electron 28 的 prebuilt 404 + 缺 VS 工具链会导致打包失败）
 * 2) 提示 keytar 需要针对 Electron 重新编译
 */
const fs = require('fs');
const path = require('path');

const canvasDir = path.join(__dirname, '..', 'node_modules', 'canvas');
if (fs.existsSync(canvasDir)) {
  try {
    fs.rmSync(canvasDir, { recursive: true, force: true });
    console.log('[postinstall] 已删除 node_modules/canvas（pdfjs-dist 的 optionalDependency，本项目未使用）');
  } catch (e) {
    console.warn('[postinstall] 删除 node_modules/canvas 失败：', e.message);
  }
}

console.log('[postinstall] 如果 Electron 加载 keytar 失败，请运行：npm run rebuild:keytar');
