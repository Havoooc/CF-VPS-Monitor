# CF VPS Monitor 代码、GitHub 与 Cloudflare 审查

审查日期：2026-10-03。范围：本地统一仓库、GitHub main/Actions、Cloudflare Worker 实际代码与设置、线上公开接口、D1 只读查询。本文不包含凭证。审查未修改生产配置或部署。

## 总体判断

项目当前正常运行，四台节点在线。没有发现部署版本偏差。值得做有边界的鉴权、探针协议与加载优化，现阶段没有证据支持重写整个项目。

- 本地与 GitHub main 均为 `f7bab6bdfff09400802eccdd69391f2ce51ca0c5`。
- GitHub 部署运行 `37109418452` 成功，实际部署步骤已执行。
- Cloudflare 当前版本 `59e4ce3a-28b1-42ec-a043-28311350b103`，2026-10-03 08:22:21 UTC 部署。
- 下载线上 Worker JS 并与本地 Wrangler dry-run 产物比较：473819 字节完全一致；SHA256 为 `4957322686f63a354ad7978bc0885203728131ef662d683be014febe2faf93d9`。
- 线上 HTML 与 release.json 的版本标记也一致。

## 优先修复的问题

### P1：WebSocket 票据可被当作管理员 API 凭证

位置：`src/middleware/auth.js:108`、`:132`、`:146`。

管理员 JWT 与短期 WebSocket 票据使用同一签名密钥。普通鉴权只检查 JWT 签名及有效期，没有要求 `sub=admin` 或排除 `purpose=ws`。因此合法 WS 票据放入普通 API 的 Bearer 或认证 Cookie 时，会通过管理员身份检查。

使用本地模拟密钥复现：WS 票据有效，同时 `checkAuth()` 接受其作为管理员 Bearer。没有使用生产凭证，也没有对生产接口实施越权操作。这不代表匿名访客可以直接获取票据，而是已取得的短期票据具有超出设计的权限。

建议：分别验证管理员和 WS 凭证用途；普通鉴权严格限制管理员声明，WS 校验保留短期和一次性消费限制；补充 Bearer/Cookie 误用回归测试。

### P2：隐藏服务器的 WebSocket 权限未与 REST 对齐

位置：`src/handlers/update.js` 的 WebSocket 升级处理；`src/durable/MetricsBroadcaster.js:428`、`:1624`、`:2144`、`:2172`。

公共站点允许匿名订阅；连接附件仅保存 scope/serverIds。订阅任意格式合法的服务器 ID 时，没有检查服务器是否隐藏，广播过滤也没有包含可见性权限。知道隐藏服务器 ID 的公共连接可能收到其实时指标。

目前四台服务器全部可见，没有证据表明现有隐藏数据正在泄露。这是启用隐藏节点时会暴露的权限缺口；本地广播过滤复现确认附件没有可见性约束。

建议：将已验证身份和允许访问的服务器范围绑定到连接，订阅时检查可见性，隐藏状态改变时同步使已有订阅失效；保持公开和管理员 REST/WS 的访问规则一致。

### P2：三网路线更新依赖本机补丁，重装/迁移可能失效

位置：`server/install-daily-route-scan.sh:4`、`public/install.sh`、`agent/internal/cfprobe/types.go` 与 Go 指标组装代码。

线上四个探针版本均为 Shell 1.3.8。路线安装器直接修改 `/usr/local/bin/cf-probe.sh`，注入 `return_route`、`return_route_ipv6`、`forward_routes`。仓库原始 Shell 安装器没有这些上报字段，Go 探针也没有对应读取/上报逻辑。安装器还依赖已存在的 Shell 脚本及特定文本标记。

Shell 自动更新通过重新运行安装器实现；重装或自动更新可能覆盖路线补丁。改用 Go 后，扫描器即便继续生成路线文件，卡片也可能不再收到更新。现有运行正常不能证明安装/升级后的功能完整。

建议：将路线文件读取和上报纳入正式探针协议，先兼容 Shell，再补齐 Go；读取时限制体积、验证 JSON、缓存未变化内容。扫描任务安装器与探针脚本解耦，避免文本替换注入。完成兼容与验证后再迁移现有节点。

## 效率与加载优化

### 1. 主题静态资源缓存规则漏配

`public/_headers` 只为 `/assets/*` 等配置一年 immutable 缓存，但 LuminaPlus 实际资源路径为 `/themes/luminaplus/assets/*`。

线上主 JS、React、Query、图表资源均返回 `public, max-age=0, must-revalidate`。Cloudflare 边缘 HIT 不等于浏览器免请求；重复进入网页仍需验证缓存。

建议：只给主题带哈希资源增加 `/themes/luminaplus/assets/*` 的一年 immutable 规则；HTML、版本文件保持可及时更新。主要改善重复访问，不应承诺解决所有首次加载延迟。

### 2. 图表包仍进入首页加载链

`themes/luminaplus/vite.config.ts` 的手动分包产生了 React/Query → charts 的依赖，首页 HTML 明确预加载 charts。虽然详情页使用 lazy，约 26 KB gzip 的图表 JS 仍在首页加载；首页速率曲线本身使用自定义画布。

建议：调整共享依赖和图表分包边界，使 uPlot JS/CSS 真正随详情页加载。以构建依赖图和浏览器网络记录确认收益，避免只修改 lazy 标记。

### 3. LuminaPlus 未消费 REST 返回的实时重放数据

`src/handlers/dashboard.js` 为服务器接口读取 Durable Object 的 `latestReportUpdates`，但主题快照合并没有消费该字段。当前响应约有 2.5 KB 未使用重放数据，还存在额外 DO 调用。

建议：增加显式能力参数，由需要重放的客户端请求，或者让主题正确消费最新样本。旧 Vue 客户端确实使用该字段，不能直接全局删除。可同时将独立的路线读取并行化，并检查缓存冷启动时重复请求。

### 4. 暂时不需要大规模数据库重构

当前 D1 约 25.4 MB，四台节点，历史表以包含分区与时间的主键查询。没有独立二级索引并不等于缺索引；不建议无依据新增多组索引或全量改表。

一次现有 Mac 网络抽样：首页 TTFB 约 0.36 秒，服务器接口约 0.49 秒。该网络经过现有代理，不是国内客户端基准。服务器接口原始 JSON 约 50 KB，压缩传输约 5.1 KB；当前节点规模下不是主要带宽瓶颈。

## 验证结果与边界

- `npm run check` 通过：Worker 两组共 98 项、主题 52 个测试文件共 543 项、静态 URL 检查及 TypeScript 检查。
- Python 路线策略 10 项测试通过。
- 前端构建及 Wrangler dry-run 通过；没有部署。
- 本机没有 Go 工具链，无法新跑 Go 测试；最近三次 GitHub agent-build 工作流成功，不能替代本次本地重测。
- 实际检查了 Cloudflare 运行代码、版本、绑定、公开响应和 D1；没有进行生产攻击测试、压力测试或国内多运营商测速。
- 现有测试通过但未覆盖上面的凭证用途混淆与隐藏节点 WS 权限，建议新增针对性测试。

## 建议实施顺序

1. 修复 JWT 用途隔离和 WS 可见性授权，增加回归测试。
2. 修复主题缓存路径及图表依赖，量化重复访问和首次加载差异。
3. 将路线采集结果读取/上报纳入正式探针，解决安装、升级和 Go 迁移兼容。
4. 按客户端能力裁剪实时重放，并优化独立请求并行和缓存。

以上适合逐项小范围重构与部署，每一项都能独立验证和回退。
