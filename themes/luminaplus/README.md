# LuminaPlus

LuminaPlus 是 CF-VPS-Monitor 单仓库内置的默认主题。Worker 部署时会将主题编译到静态资产中，线上页面和主题资源由同一 Worker 提供，不依赖外部主题仓库。

## 构建与开发

在仓库根目录安装 Node 依赖并构建：

```bash
npm ci
npm ci --prefix themes/luminaplus
npm run build:frontend
```

主题源码位于 `themes/luminaplus/src/`，Vite 产物写入 `public/themes/luminaplus/`，随后随 Worker 静态资产进入 `dist/`。主题版本记录在本目录的 `package.json`。

从后台主题商店选择 LuminaPlus 会使用本仓库 `theme-dist` 分支发布的主题快照；新站点与清空自定义主题后的默认界面直接使用 Worker 内置副本。

站点标题、图标、背景和自定义 head/script 由 Worker 的外观设置注入。主题自身的偏好设置保存在浏览器本地。

## 来源与许可证

主题遵循 MIT 许可证，保留原项目及移植项目的版权声明，详见本目录 `LICENSE` 和仓库根目录 `NOTICE.md`。
