---
title: "0211 — 公开状态页只报告它实际测量的中继"
description: "公开 `/status` 页面通过协议探针报告官方中继（`signaling.cognia.cn`）状态。健康检查、两端认证信令往返与显式数据通道结果写入独立 `cognia-status` Worker 与 D1 的不可变分钟槽。缺证据显示未知，不显示 100%。可用率按计数计算，覆盖率并列展示，观测端与服务健康分开发布。事件、维护、Atom/RSS 与双重确认邮件订阅由运维和用户同意控制。`lib/status/` 契约共用于页面、Worker、外部 Node 探针与运维 CLI。"
---

# ADR 0211 — 公开状态页只报告它实际测量的中继

**状态：** 已采纳**日期：** 2026-10-02 **相关：** [ADR-0170](./0170-cognia-relay-and-connectivity-center)（中继与连接中心）、[ADR-0021](./0021-webrtc-datachannel-wan-transport)（WebRTC/WAN 传输）、[ADR-0037](./0037-public-share-links)（公开独立 Worker 模式）、[ADR-0092](./0092-official-website-workspace)（静态公开站点）**计划：** [`docs/plans/2026-10-02-signaling-public-status-implementation.md`](https://github.com/MaxQian888/cognia-next/blob/dev/docs/plans/2026-10-02-signaling-public-status-implementation.md)

## 背景

`/status` 页面上线时只有设计稿和确定性的预览数据：五个虚构的服务类别、三个编造的区域和示例事件。`calculateUptime([])` 返回 100，空组件列表推导出「正常」。而用户在局域网外真正依赖的公开服务——`signaling.cognia.cn` 上的信令汇合点与中继——没有任何历史。它的 `/healthz` 只是静态存活信号，无法证明两端能在房间内完成认证，也无法证明 `lane: "data"` 中继能原样传送字节。

## 决策

### 1. 测量用户真正使用的东西，走用户走的路径

三个组件，ID 固定：

- `signalingHttp`：健康响应体来自预期协议版本的 Cognia 中继。
- `signalingAuth`：两个新生成的合成 P-256 身份通过挑战绑定的证明进入一个新房间，彼此可见，并完成一次信令与确认的往返。
- `relayData`：约 1 KiB 的负载在显式数据通道上双向传输且逐字节一致，随后完成 ping/pong。

认证失败时，数据通道记为 `unknown`（`dependency_failed`），绝不当作独立观测到的失败。探针不使用账号、用户房间或设备密钥，每个房间流量低于 1 MiB，并且总会关闭套接字。模拟 Origin 的剖面（`web`、`ios`、`android`）发送精确的 Origin 头，并明确标注为模拟，不作为真机证据。

共享的合成房间辅助代码放在信令测试接缝（`services/signaling-server/worker/tests/synthetic-room.mjs`），协议运行逻辑放在可移植核心（`services/status-server/probe/src/core`），Cloudflare Cron 观测端和外部 Node 探针都打包它。

### 2. 监控由独立 Worker 负责

`cognia-status`（Worker + D1 + 仅含状态页的静态导出）从不出现在中继的准入路径上，它通过中继的公开路由访问（`global_fetch_strictly_public`）。外部 Node 探针运行在非 Cloudflare 主机上，用每个探针独立的 HMAC 密钥签名观测数据，同时提供一个独立的只读镜像。在这样的主机就位之前，Cron 观测端是登记表中的参考观测端，页面会如实显示「单一观测端」。

### 3. 「未知」是一个值，可用率按计数计算

每个预期的参考分钟，每个组件恰好有一个 `pass`、`fail` 或 `unknown`：

- 可用率按累计计数计算：`pass / (pass + fail)`。
- 覆盖率 `observed / expected` 始终并列展示。没有观测时，可用率为 null，单元格为 `no_data`。
- 维护期排除的分钟与原始计数分开报告。
- 观测证据 180 秒后过期，300 秒剖面为 900 秒。快照本身在浏览器中 180 秒后视为过期，并用服务器时间校准。
- 总体状态取最差的失败组件；没有失败但有未知组件时，总体为未知。
- 观测端健康（`healthy | limited | degraded | unknown`）单独发布，绝不变成服务故障。

### 4. 一份契约，多处打包

`lib/status/{contract,derive,validate,signing,config}.ts` 是叶子模块：不引用 `@/`、React、Dexie 或 Node 内置模块。页面、Worker、探针和 CLI 都通过相对路径导入它，因此不会彼此漂移。Schema 版本 1 已冻结；遇到不支持的版本时显示「不可用」，绝不回退到预览。夹具（`fixtures.ts`）只供测试和 story 使用。

### 5. 写入都有作用域

- **探针上报：** 用 HMAC 签名，覆盖方法、精确路径、时间戳、run ID 与请求体摘要，允许 ±120 秒偏差。每次运行不可变：完全相同的重放为空操作，内容冲突的重放返回 409。超过 10 分钟的运行一律拒绝，同一分钟以最先到达的观测为准。
- **运维写入：** 需要在 Worker 内校验的 Cloudflare Access JWT（签发方、受众、签名、有效期、白名单邮箱），并使用操作 ID 和修订号 CAS。
- **订阅：** 双重确认，令牌按用途区分、只存哈希，并放在 URL 片段中传递。GET 请求永不改变订阅同意状态。邮箱地址只以 HMAC 索引加 AES-GCM 密文的形式存储。

### 6. 作业带租约和栅栏

聚合、投递和保留清理各自持有独立的 D1 租约，栅栏值单调递增，每条提交语句都会检查栅栏。汇总数据从脏小时重建，只有当脏标记的序号在重建期间没有变化时才会清除。

## 影响

- 页面会显示红色、灰色和「无数据」，这正是设计目的。
- 只有一个观测端时，Cloudflare 全局故障会让页面和它的观测端同时失效。计划中的补救是外部探针与镜像，目前以代码和部署清单形式交付（`services/status-server/probe/deploy/`）。
- 邮件使用 Cloudflare Email Sending：它需要 Workers Paid，没有幂等键，也没有退信 webhook。状态不明的发送记为 `uncertain`，需要运维经审计后手动重试；退订抑制依据 `E_RECIPIENT_SUPPRESSED`。
- 每分钟的 Cron 约产生 50–70 条 D1 语句，由 `src/budget.test.ts` 约束上限；服务按 Workers Paid 规格设计。
- 设置 → 连接中的入口链接到公开状态页，并说明它只覆盖官方中继；自托管中继绝不会被显示为「官方正常」。

## 验证

- 契约：`pnpm test -- lib/status lib/signaling/relay-health.test.ts`。
- Worker、探针与 CLI：`pnpm -C services/status-server/{worker,probe,admin} test`。
- 线上协议证据：`pnpm -C services/status-server/probe test:live`。
- 静态分发：在 `pnpm build` 之后运行 `node scripts/build/build-status-site.mjs`。
