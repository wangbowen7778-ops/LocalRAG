# 资源目录

本目录用于存放应用图标、安装包资源等。

## 图标

请将以下文件放入此目录：

| 文件 | 用途 | 规格 |
| --- | --- | --- |
| `icon.ico` | Windows 应用图标 | 256x256 ICO |
| `icon.png` | 通用图标 | 512x512 PNG |
| `installerIcon.ico` | NSIS 安装包图标 | 256x256 ICO |
| `uninstallerIcon.ico` | 卸载程序图标 | 256x256 ICO |

> **占位说明**：本仓库暂未提供实际图标文件。请运行 `npm run dist:win` 之前确保 `icon.ico` 存在，否则 electron-builder 会使用默认 Electron 图标。
> 推荐使用 [RealFaviconGenerator](https://realfavicongenerator.net/) 或类似工具生成。

## 其他资源

- `tray/`  托盘图标（未来支持）
- `splash/` 启动闪屏（未来支持）
