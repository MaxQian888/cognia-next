# Cognia 信令服务公开状态页研究

研究日期：2026-10-02。范围：公开 uptime 状态页，并在 Cognia 现有连接设置里提供入口。仅研究；未实现、部署或创建监控。

## 结论

可以做，而且值得做。公开页应分别展示 HTTP 入口、信令认证、应用数据中继的可用性、历史和最后探测时间，让用户判断远程连接问题来自公共服务还是本机。不要只把 `/healthz` 的 HTTP 200 转成一个绿色圆点。

项目已经有 `/status` 公开页 UI，目前接的是固定预览数据；优先复用这套页面与展示组件，接真实探测采集/历史存储。公开页应独立部署，并至少有一个 Cloudflare 之外的主动探针。有现成 VPS/container 时可用 Uptime Kuma 管监控，加一层结果适配到现有 UI；没有常驻主机、希望继续使用 Cloudflare 时，可做单独的 status Worker + Cron + D1 + static assets，再接外部探针。Upptime 适合最低运维成本的 HTTP 起步，不能开箱即用证明 Cognia 的协议和数据中继可用。

## 当前项目已有基础

本节为当前工作树源码核查，不能据此证明线上部署版本与源码完全一致。

| 基础            | 当前能力与限制                                                                                                                                                                                           | 源码                                                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker HTTP     | 只有 `/healthz`、`/signaling`、`/v2/signaling`；health 返回版本/backend/protocol/lanes 等编译期能力，没有执行 DO 业务操作                                                                                | [worker/src/lib.rs](../../services/signaling-server/worker/src/lib.rs)                                                                                                                                                                           |
| Worker 事件指标 | 已有 `record` 事件上报 seam，热事件采样，fanout/relay-data bytes 等；`METRICS` Analytics Engine binding 在配置中被注释                                                                                   | [room.rs](../../services/signaling-server/worker/src/room.rs)、[wrangler.toml](../../services/signaling-server/worker/wrangler.toml)                                                                                                             |
| Axum 后端       | health 有 rooms、peers、uptimeSeconds；有 Prometheus `/metrics`。这是另一后端，不能套用到当前 Worker                                                                                                     | [server.rs](../../services/signaling-server/src/server.rs)                                                                                                                                                                                       |
| 客户端连接检查  | 现有 CloudRelayPanel 挂载 RelayCheckBlock，手动探测 HTTP、延迟、协议与能力；没有持续探测历史                                                                                                             | [cloud-relay-panel.tsx](../../components/settings/connectivity/panels/cloud-relay-panel.tsx)、[relay-check-block.tsx](../../components/settings/connectivity/blocks/relay-check-block.tsx)、[relay-probe.ts](../../lib/signaling/relay-probe.ts) |
| 公开状态页 UI   | `/status` 已挂载 PublicStatusPage；默认 `createPreviewStatusSnapshot()`，固定 2026-08-11 时间、合成 90 天历史/延迟/地区；incident/maintenance/subscription 都是预览。订阅表单仅本地 setState，无发送请求 | [page.tsx](../../app/status/page.tsx)、[public-status-page.tsx](../../components/status/public-status-page.tsx)、[public-status.ts](../../lib/status/public-status.ts)                                                                           |
| 协议集成测试    | 已有 synthetic P256 room、challenge authentication、opaque relay、ping、takeover、tamper 验证；默认 relay 没有指定 lane，默认覆盖 signal；新周期探测须明确验证 `lane: data`                              | [integration.mjs](../../services/signaling-server/worker/tests/integration.mjs)                                                                                                                                                                  |

2026-10-02 公网只读检查：`https://signaling.cognia.cn/healthz` 为 HTTP 200，报告 protocol 2 和 data relay 能力；`/` 与 `/metrics` 为 HTTP 404。它证明当时 HTTP 入口与能力响应存在，不证明认证/DO/data lane 当时可用，也没有核对部署 SHA。当前确认已有前端预览页，尚未找到真实持续监控后端；信令域名没有状态页不等于主应用没有 `/status`。

## 公开页应该监测什么

| 公开组件        | 合格的主动探测                                                                    | 可展示                           |
| --------------- | --------------------------------------------------------------------------------- | -------------------------------- |
| HTTP 入口       | DNS/TLS/HTTP 成功，解析正确 signaling health schema 与预期协议                    | 状态、探测点、响应时间           |
| 信令与认证      | 创建专用 synthetic room，两端 WS upgrade，完成 challenge/auth，发送信令并验证收到 | 成功率、认证/消息往返耗时        |
| 应用数据中继    | 已认证两端显式发送 `lane: data` 的小 payload，核验收件方字节一致，最后关闭连接    | 成功率、数据往返耗时             |
| 区域/运营商链路 | 在对应地区与网络真实发起前述探测                                                  | 各探测点状态，不混成全球体验保证 |

总体状态建议为正常、降级、故障、维护、未知；探针长时间没有结果时显示未知/过期，不延续之前的绿色状态。现有 `ServiceStatus` 没有 unknown，`calculateUptime([])` 为 100、`deriveOverallStatus([])` 为 operational，模型的 mode 仅有 preview；这些语义不能直接用于真实零样本/失联，需要扩展。历史提供 24h/7d/30d，标明观测起点、采样间隔、有效样本/缺失样本与可用率口径；服务刚上线时不能沿用合成 90 天历史。故障记录可先人工维护，避免把短暂超时自动描述为确定根因。现有订阅动作只显示本地预览，真实版应明确显示尚未提供订阅，或完整实现通知注册/退订，不展示虚假的订阅成功。

信令 HTTP 探测可复用 `lib/signaling/relay-probe.ts` 的纯解析/协议逻辑；`lib/connectivity/healthz.ts` 是本机 Host TLS fingerprint 探测，schema 与目的不同。协议探针应从已有 integration test 提炼最小流程，定时任务不能简单完整重跑 takeover/tamper 负向测试，否则干扰正常拒绝率指标。专用短期房间和临时密钥与用户隔离，限制超时、包体、并发，关闭两端连接并处理房间持久化 quota/TTL，避免长期产生无限 synthetic 房间。结果写入接口需要认证，公开只读接口返回聚合状态，不公开真实 room ID、device key、用户 IP、token 或用户内容。

状态页不能证明任意手机到任意电脑的 WebRTC 直连。真正的 WebRTC 路径受 NAT、STUN/TURN、用户电脑与运营商影响。海外 VPS/GitHub/Cloudflare 上的探测也不能声称大陆蜂窝网络已验证；若公开“中国移动/联通/电信”状态，需对应实际探针。native、Web、iOS、Android 的 Origin 策略亦要单独验证，originless Node WS 通过不能证明手机入口通过。

## 三种可行方案

### A. Uptime Kuma 独立主机：已有主机时优先

Uptime Kuma 当前最新发布版为 2.5.5；官方列出 HTTP、HTTP JSON Query、TCP、DNS、Push、WebSocket 等监控，内置多个公开状态页与通知渠道，支持 Docker。软件开源，主机、存储、备份、升级是额外运维成本，普通 Worker 不能直接运行其常驻 Node 服务。[官方 README](https://github.com/louislam/uptime-kuma/blob/2.5.5/README.md)、[发布页](https://github.com/louislam/uptime-kuma/releases/tag/2.5.5)

需要区分三个概念：

- 管理 UI 使用 Socket.IO，不意味着被监测的服务也要用 Socket.IO。
- 2.5.5 确实有 `websocket-upgrade` monitor；源码在连接 open 后立即 close，核验 close code，因此只证明握手/关闭流程，不会执行 Cognia 的 P256 challenge、应用认证或 data relay。[2.5.5 monitor 源码](https://raw.githubusercontent.com/louislam/uptime-kuma/2.5.5/server/monitor-types/websocket-upgrade.js)
- 完整 Cognia synthetic probe 需自定义脚本，将 success/failure、latency 上报 Kuma Push monitor。Push 接口允许状态/message/ping；脚本丢失心跳也要算失败。[2.5.5 Push 路由源码](https://raw.githubusercontent.com/louislam/uptime-kuma/2.5.5/server/routers/api-router.js)

Kuma 自带公开状态页，能够绑定 `status.cognia.cn`；官方文档注明公开页有约 5 分钟缓存/刷新，它与内部实时 dashboard 的更新速度不同。原生公开页由 Kuma 服务提供，并非完整静态导出；若坚持静态托管，需额外快照同步，不是开箱功能。[Status Page 官方文档](https://github.com/louislam/uptime-kuma/wiki/Status-Page)

针对 Cognia 已有 UI，建议复用 Kuma 的监控与事故管理，通过结果适配层接入现有 PublicStatusPage；若只要最快上线、无需现有 Cognia 风格，也可直接用原生公开页。不要重复建设监控后台。将探针/后端部署放在非 Cloudflare 主机；若公开页仍通过同一个 Cloudflare DNS/proxy/tunnel 入口提供，仍有共享故障依赖，不能宣称完全独立。

### B. Upptime：无服务器、低运维的 HTTP 起步

Upptime 使用 GitHub Actions 探测、Issues 管理事故、Pages 发布静态状态网站，默认每 5 分钟检查；响应时间图表的默认更新频率是 24h。适合公开 HTTP 服务，状态网站可独立于信令 Worker；若保持现有 Cognia `/status`，需要把 Upptime 结果适配到该模型，而非重新建设同类 UI。[官方工作原理](https://upptime.js.org/docs/)、[触发频率](https://upptime.js.org/docs/triggers/)

GitHub schedule 最短 5 分钟，不是严格每 5 分钟 SLA：高负载时可能延迟或丢弃，整点更拥挤；只在 default branch 运行；公开仓库连续 60 天无活动会停用 scheduled workflow。公开仓库的标准 GitHub-hosted runner 当前免费，私有仓库看额度与费用，larger runners 不能混算为免费。[GitHub schedule 规则](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)、[GitHub Actions 计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

Cognia auth/data synthetic 需要额外 Actions 脚本和结果接入，非标准 HTTP 配置即可完成。公开仓库配置与日志必须避免放入真实密钥；同步延迟与 missing run 要显式显示。适合 HTTP 状态首版或备用状态来源，若目标是分钟内捕获中继故障，不宜作为唯一监控。

### C. 独立 Cloudflare status Worker：无 VPS、定制更强

组成建议为独立 Worker：Cron 主动探测 → D1 保存精确探测/事故记录 → 只读聚合 API + 从既有 PublicStatusPage 组件构建/部署的 static assets 公共页面。不要往 signaling router 里增加监控写入和管理接口，否则服务出故障时面板也不可用，而且引入额外业务攻击面。D1 用于准确的探测历史和状态；Analytics Engine 可后续用于采样聚合趋势，不作为唯一 uptime 历史来源。

Workers Free 当前每天 100,000 次请求、每次 10ms CPU；D1 Free 每天 5m rows read/100k rows written、总 5GB storage；static assets 请求免费且不限量，动态 API 请求另算。每分钟探测一次为 1,440 次/天；比如三个组件各写一条为 4,320 条/天，索引、清理、读取和目标侧 DO 消耗另计。小规模 HTTP 状态页可先用 Free；P256/auth synthetic 的 CPU 必须实测，不因频率低就断言 Free 10ms 足够。[Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)、[D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)、[Static Assets 计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

Cron 的 `scheduled` handler 可以 `fetch`；Worker 支持出站 WebSocket。但实现前仍需用部署级 smoke test 验证 scheduled 环境下的真实握手/认证/超时，不能把普通 fetch 或入站 WS 示例当成 Cron synthetic 成功证据。网络 I/O 放在 handler 内，不能放全局 scope。探测同 zone Worker 的公开 URL 时要核对 `global_fetch_strictly_public`，否则可能绕过 URL 上的 Worker 直达 origin；Service binding 验证内部调用，不能替代公网 DNS/TLS/安全策略入口。[Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[Fetch 规则](https://developers.cloudflare.com/workers/runtime-apis/fetch/)、[出站 WebSocket](https://developers.cloudflare.com/workers/examples/websockets/#write-a-websocket-client)、[public fetch compatibility](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)

官方 Analytics Engine 当前明确列出 Workers Free 的 100k data points written/day 和 10k read queries/day，并注明现阶段尚不收费，未来计费信息已提前公布。不能再沿用旧的“仅 Paid”描述。现有 binding 是否真的在线上启用仍未确认。[AE 当前定价](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)

此方案与信令服务共享 Cloudflare 故障域，Cron 在 Cloudflare 的空闲机器执行，位置不代表用户移动网络；至少加入一个独立外部探针。公开页显示 probe region/source/checkedAt 与 stale 状态，外部探针失联不等同于目标故障；两个相反结果可标记区域降级。若需要 Cloudflare 全域事故期间也能查阅，需外部静态镜像/备用入口。

## Cognia 入口和交付边界

入口复用 **设置 → 连接 → 云与中继** 的 CloudRelayPanel/RelayCheckBlock，加入“公共服务状态”链接，指向接入真实数据并独立部署的现有 `/status` UI；仍保留“检查我的连接”，前者回答公共服务状态，后者回答用户当前设备链路。优先外部浏览器打开公开页，避免重复建设一个完整设置面板。链接和状态文本需要 en/zh-CN i18n 与既有 co-located tests；静态导出主应用不承担服务端探测逻辑。

公开页优先展示正常/降级、last checked、最近延迟、历史、事故、探测点。精确在线人数、房间数、CPU/账单/错误详情属于后续运维视角：当前采样事件数不能推导精确在线 gauge，serverless 服务也没有一个可信的全局 process uptime。可以展示“过去 30 天观测可用率”，不要展示伪造的单台服务器开机时长。

若后续获准实现，验收包括：HTTP 正常但 data lane 故障时能降级；probe 停止时显示未知；新服务无历史时如实显示；故障恢复与维护窗口规则一致；协议/Origin 与受支持端一致；面板数据过期/不可达不影响本地连接设置；至少外部探针完成认证与 data lane 字节核验。实际大陆蜂窝与个人设备验收另记，不能由云端 synthetic 替代。

## Sources

上述官方源均在 2026-10-02 核对。仓库证据来自当前共享工作树；公网只读结果是一次性快照。未访问 Cloudflare 管理账户或部署日志，未获取历史 SLO、真实使用量或部署 SHA。本文件没有把方案可行性等同于已部署监控。
