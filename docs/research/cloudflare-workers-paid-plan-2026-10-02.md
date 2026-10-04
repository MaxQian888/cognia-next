# Cloudflare Workers Paid：价格与能力边界

核验日期：2026-10-02。官方价格由本文作者核验；以下本地代码事实由主分析代理核验。未检查用户实际 Cloudflare 账户、账单或线上部署。

## Cognia 当前最值得使用的位置

| 已有模块                                                                 | Paid 的实际意义与边界                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/signaling-server/worker/{README.md,wrangler.toml,src/room.rs}` | 已使用 SQLite DO 和 hibernatable WebSocket，按 ADR-0170 转发加密 opaque app payload；付费提高请求/CPU 与存储额度，适合生产级多设备连接和协作。房间默认 relay quota 为 2 GiB / 24h；套餐不会自动修改该应用配额。 |
| `services/signaling-server/worker/src/room.rs`                           | `LEASE_SCAN_MS=10000`，仍有 socket 时 alarm 会继续安排。应把定时 alarm requests、`setAlarm()` storage writes 与实际唤醒 duration 一起估算；当前没有真实账单测量，不能据此承诺 $5 封顶。                         |
| Share Worker                                                             | 已用 R2、SQLite `ShareLifecycle` 与 legacy/discovery KV，viewer 在 Pages；先复用已有分享服务，再考虑云备份/大附件扩展。R2 费用另算。                                                                            |
| Update Worker                                                            | 已用 D1 catalog，支持 rollout/promote/pause/abort；安装包仍在 GitHub/store/npm，Worker 不托管全部安装包，也不会仅因付费自动增加流量或速度。                                                                     |
| `.github/workflows/deploy.yml`                                           | 已有 Docs 和 Web static export 的 Pages jobs；单纯发布静态站点并非购买 Paid 的充分理由。                                                                                                                        |
| Diagnostic server / 完整 headless 运行时                                 | Diagnostic 依赖 PostgreSQL，`processing.rs` 有 `tokio::process` command；这类常规进程环境需要改造或另用 Containers。Paid 本身不能直接运行完整本地 CLI、桌面浏览器与 native 能力。                               |

判断：若近期要把多设备连接、加密 relay 和分享服务正式用于多用户，Paid 有明确价值；若仅个人本地使用 Cognia 或部署静态站点，先用 Free 并观察请求/存储使用更合理。

## 1. Workers Paid 的基础价格

最低 **$5 USD / account / month**，不是每个 Worker 各收 $5，也不是网站 CDN/WAF 的 Cloudflare Pro 套餐。Standard 包含每月 1,000 万请求、3,000 万 CPU milliseconds；超额分别 $0.30 / 百万请求、$0.02 / 百万 CPU milliseconds。Free 是每天 10 万请求、每次调用 10ms CPU。Paid 默认每次调用 30s CPU，可配置至 5min；等待外部网络的时间不等于 CPU 消耗。Workers 本身不按出站带宽收费，但不能把这一规则泛化到 Containers 等其他产品。

来源：[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)。

## 2. Durable Objects 免费计划也能使用

**SQLite-backed Durable Objects 在 Free 和 Paid 都可用**，不能把付费价值描述成“解锁所有 Durable Objects”。Paid 包含每月 100 万 DO requests、400,000 GB-s duration；超额分别 $0.15 / 百万、$12.50 / 百万 GB-s。SQLite storage 的 reads、writes、stored data 也分别计量：Paid 包含 250 亿 rows read、5,000 万 rows written、5 GB-month。

使用 WebSocket Hibernation 可避免符合休眠条件的空闲 duration 费用；普通 `accept()` 会在连接存续期间产生 duration。HTTP/RPC、WebSocket messages、alarm 都有对应计费规则，`setAlarm()` 也计一次 row write。高频心跳或 alarm 的请求量应纳入估算，不能只按用户 HTTP 请求估算。

来源：[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

## 3. Analytics Engine 的项目注释可能过时

官方价格页现列出 Free 每日 10 万 data points、1 万 read queries；Paid 每月 1,000 万 data points、100 万 queries，公布的超额价格是 $0.25 / 百万 points、$1 / 百万 queries。该页同时明确说明**当前尚未实际收取 Analytics Engine 使用费**，价格是未来收费的预告。Overview 和 Get started 也没有 Paid-only 前提。因此 Cognia README 或 Wrangler 注释若写“必须 Paid 才可用”，不能据此认定付费解锁指标；仍需真实账户部署核验。

来源：[Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)、[overview](https://developers.cloudflare.com/analytics/analytics-engine/)、[get started](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)。

## 4. R2 独立开通与计费

R2 需要账户另加 R2 subscription，自带 Standard 免费额度：10 GB-month storage、100 万 Class A operations、1,000 万 Class B operations / month。超额 Standard storage $0.015 / GB-month；Class A $4.50 / 百万、Class B $0.36 / 百万。直接从 R2 出站不收费，但访问操作仍可能收费。**Workers Paid 的 $5 不代表无限文件存储，也不是使用 R2 的必要前提**。

来源：[R2 get started](https://developers.cloudflare.com/r2/get-started/)、[R2 pricing](https://developers.cloudflare.com/r2/pricing/)。

## 5. Workers AI 另计推理费用

Free/Paid 都有每日 10,000 Neurons 免费量；Paid 超额按 $0.011 / 1,000 Neurons，具体模型换算成不同输入/输出 token 或其他单位。部分资源密集模型要求 Paid 或相应付款方式。开通 Workers Paid 不能免除模型推理费用，也不会自动获得 OpenAI/Anthropic 账户额度。

来源：[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)、[selected models require Paid](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/)。

## 6. Containers 和 Browser Run 也有独立计量

- **Containers**：Paid 包含 25 GiB-hours memory、375 vCPU-minutes、200 GB-hours disk / month，超过后分别按资源时间付费；出站流量有地区价格。还会产生关联 Workers / Durable Objects 使用量。它适合额外设计的云端执行环境，不能视为 $5/月无限常驻服务器。
- **Browser Run**（原 Browser Rendering）：Free 每日 10min；Paid 每月 10h，超额 $0.09/h。Browser Sessions 还按月平均的每日峰值并发收费：含 10 browsers，超额 $2/browser。云浏览器不能直接继承用户桌面浏览器的登录状态或本地权限。

来源：[Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)、[Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/)。

## 7. Queues / Workflows 可以试用，生产用量额外计费

- **Queues**：Free 每日 10,000 operations；Paid 每月 100 万 operations，超额 $0.40 / 百万。通常一个成功交付消息有 write/read/delete 三次操作，重试额外增加 read。Paid retention 默认 4d、最多 14d，Free 为 24h。
- **Workflows**：Free/Paid 都可用，与 Workers 共用请求/CPU 计量；Paid 另含每月 500,000 steps、1 GB-month state storage，超额 $0.80 / 100,000 steps、$0.20 / GB-month。专用文档明确 steps/storage 从 **2026-08-10** 开始收费；不能沿用早期“不收费”的认知。休眠/等待不消耗 CPU，但持久化状态仍算 storage。

来源：[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)、[Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)。

## 8. 付费不会自动改善中国大陆链路

Cloudflare China Network 是 **Enterprise 的独立订阅**，需要 ICP 与域名内容审查。普通 Workers Paid 不包含该网络。是否改善 Cognia 的实际连接、模型代理或分享体验，需要对目标地区、运营商、域名和请求路径实测。

来源：[China Network get started](https://developers.cloudflare.com/china-network/get-started/)。
