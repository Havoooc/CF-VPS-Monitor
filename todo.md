待办事项（状态订正于 2026-10-02）：

> 原 5 项计划**均已实现并线上生效**，此前文档误标为「未开工」，故逐项勾选并补上实现位置。

- [x] setting.js SITE_FIELDS增加theme_url字段
      → `src/utils/settings.js:11`（`SITE_FIELDS` 数组末段含 `'theme_url'`；默认值见同文件 `theme_url: ''`）
- [x] 后台主题商店选择主题以及版本，点击切换主题，保存到setting.js，格式为theme_url: 'https://github.com/Havoooc/CF-VPS-Monitor/tree/4e272b26193e35430261657b85e82c61d9dbf557/Tokinx/cf-server-monitor-theme-emerald/v1.0.10'，注意commitid以及版本号
      → `src/frontend/views/admin/components/ThemeStorePanel.vue`（写入 `` `${repoUrl}/tree/${sha}` ``，即固定 commit）
- [x] 前台根据setting.js中的theme_url字段，获取对应的github raw url(https://raw.githubusercontent.com/Havoooc/CF-VPS-Monitor/4e272b26193e35430261657b85e82c61d9dbf557/Tokinx/cf-server-monitor-theme-emerald/v1.0.10/index.html)，workers反代index.html以及assets目录下的所有文件，并且设置缓存时间为1小时
      → `src/handlers/frontend.js`（`parseThemeUrl()` 由 `github.com/.../tree/<ref>` 推导 rawBase；`loadThemeIndex()` / `serveThemeAsset()` 经 `fetchWithCache` 反代）。缓存：分支 ref = `THEME_ASSET_CACHE_TTL_SECONDS` 3600s；commit ref = `THEME_COMMIT_CACHE_TTL_SECONDS` 86400s + 浏览器端 immutable（见 `src/utils/config.js:45-46`）
- [x] 替换前端的index.html为workers反代的index.html，CSP和背景图，title注入等同样应用。注意仅代理index.html和assets目录，其他文件直接返回原有的文件
      → `src/handlers/frontend.js`（`buildHtmlResponse()` 统一注入 CSP / 背景图 / title；仅拦截 `/assets/*` 与入口 HTML）
- [x] 主题商店增加预览主题，在登录状态下，点击预览主题，跳转到?theme_url=theme_url,实现临时替换setting.js中的theme_url字段方案预览主题。
      → `src/handlers/frontend.js:272`（`getPreviewThemeUrlFromQuery()`）+ 预览鉴权 `checkPreviewAuth()`；管理端跳转见 `src/handlers/admin.js:147`
