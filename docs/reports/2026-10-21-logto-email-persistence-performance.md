# Logto email persistence performance experiment — 2026-10-21

## Latest outcome / 最新结论

后续已定位两类成本：Cloudflare named-DO 的定位/激活冷路径，以及 Logto HTTPS 连接池
5 秒空闲到期后的重新建连。DO 身份与持久化协议保持不变；已在本机 Logto 启用限定于
HTTP Email connector 的有界连接池。十组配对、32 并发的新收件人请求，在空闲后响应
中位数由 1199.5ms 降至 675.5ms，候选 320/320 接受；收益不包含进程首次启动或公网收信。
后文区分首轮未通过的持久化改写与后续保留的出站优化。

进一步的固定分片冷/热对照，以及正式账号真实邮箱 OTP + TOTP 完整登录，见
[后续实测报告](2026-10-21-logto-email-do-cold-login.md)。后文未测真实收信等说明仅对应当轮实验。

## Initial outcome / 首轮结论

首轮没有证明持久化延迟得到可靠改善。同步 KV、显式 storage sync、原生 DO RPC 等性能改写
均已移除，保留原有每收件人 Durable Object 与异步事务协议。未用弱化持久化、内存限流、
提前返回成功或未知结果重发来换取延迟。

独立保留的正确性修复：把 reservation 与 cleanup alarm 放入同一个 SQLite transaction。
alarm 设置失败时二者回滚，邮件服务不会被调用；避免旧版先提交 pending、再设置 alarm
失败后留下无清理计划的状态。回归测试先在旧实现失败，再在修复后通过。

## Measurement contract / 测量约定

- Platform: macOS Apple Silicon, actual compiled workerd + SQLite; separate mail
  receiver through a Worker RPC binding, fixed 20ms synthetic provider delay.
- Baseline: the deployed durable implementation captured before this experiment,
  not the earlier uncoordinated sender. Snapshot contains `index.ts`, `delivery.ts`
  and `template.ts` under `.cache/logto-email-storage-performance/baseline/`.
- Workload: 32 simultaneous new recipients per batch; separate 32-request same-code
  duplicate burst; fresh recipient names every round; one warmup and 30 paired rounds
  alternating AB/BA. Timings cover batch completion, including fixture provider.
- Decision: require at least 10% gain and a delta greater than twice the larger MAD.
  Correctness is mandatory. Paired Cloudflare experiments separately registered a
  paired-difference MAD rule before measurement.
- Final local timing ran after task-owned lint, tests and typecheck completed.
  Other activity in this shared workstation remains a limitation. An earlier run
  overlapping checks is retained in cache but not used as final evidence.
- This is coordination testing with a synthetic mail receiver, not public mailbox
  delivery timing or a provider throughput certification. No public email load test.

## Initial retained Worker implementation / 首轮保留的 Worker 实现

Each cell is median ± MAD in milliseconds, 30 samples per implementation:

| Workload                                | Deployed baseline | Retained implementation | Interpretation                                                    |
| --------------------------------------- | ----------------: | ----------------------: | ----------------------------------------------------------------- |
| 32 new recipients, batch completion     |    139.83 ± 11.00 |           133.90 ± 8.42 | 4.24% lower; delta 5.93ms < 22.00ms noise threshold; inconclusive |
| 32 duplicate requests, batch completion |      40.86 ± 0.87 |            40.72 ± 0.92 | no meaningful change                                              |

Both implementations submitted exactly one provider message for every duplicate
burst. Independent recipients progressed separately; a slow recipient did not
block a fast recipient. The retained atomic-alarm change is justified by correctness,
not by its inconclusive timing difference.

Raw results and safety guards:
`.cache/logto-email-storage-performance/final-isolated/{runtime-results,guard-results}.json`.
An additional fresh-recipient concurrency guard is recorded under
`.cache/logto-email-storage-performance/final-guards/guard-results.json`.
The reusable runner is `scripts/smoke/logto-email-runtime.mjs`; README documents
`--baseline-durable`, `--paired`, `--samples`, `--output` and `--guards-only`.

## Rejected attempts / 已移除实验

| Candidate                                              | Evidence                                                         | Decision                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Batch reservation + alarm                              | initial local 128.81 ± 3.13 → 134.43 ± 8.27ms                    | no speedup; keep only atomicity fix                                                                      |
| Sync KV, sync acceptance, explicit durability barriers | several alternating runs contradicted each other; some worsened  | removed                                                                                                  |
| Implicit native KV + explicit sync                     | local 30 pairs: 144.08 ± 6.61 → 144.78 ± 13.75ms                 | removed; no improvement                                                                                  |
| Same native KV candidate on Cloudflare                 | 20 pairs: 2339.5 ± 261.5 → 2460 ± 308.5ms for 32-recipient batch | no improvement; bulk driver also shares a parent invocation budget, so not a production throughput claim |
| Native DO RPC, original transactions                   | local 30 pairs: 173.52 ± 16.11 → 163.07 ± 13.02ms                | below 10% and noise threshold; removed                                                                   |

Cloudflare RPC follow-up used 32 independent HTTP/2 requests to a temporary Worker
per batch, a separate synthetic mail Worker RPC call, fresh recipients, alternating
AB/BA and the same ingress connection within each pair. Target: 20 measured pairs.
Only 14 pairs completed; one attempt failed an application-status/provider-count
assertion whose payload the initial driver failed to save, another connection stalled
and was interrupted, and a later attempt hit an explicit connection timeout. The exact
assertion failure is unresolved. This is an incomplete experiment, not a correctness
pass or an accepted speedup.

Exploratory completed pairs: new-recipient per-request server median 417.75 ± 15.00ms
versus 404.75 ± 18.75ms; median paired difference 6.75ms (1.62%), paired MAD 13.00ms.
This also fails the registered performance rule. These per-request server medians
must not be compared directly with the local whole-batch timings above.

All successful and aborted measurements remain under
`.cache/logto-email-storage-performance/cloudflare/`, including `rpc-http2-results.json`,
`rpc-http2-summary.json`, `rpc-http2-interruptions.json` and `rpc-http2-aborted-15.json`.
Intermediate source and the decision ledger remain in the task cache. No production
RPC/SDK or synchronous-storage rewrite was deployed.

## Safety verification / 安全与并发验证

Actual local workerd reload tests passed against the final code:

- baseline → current → baseline preserves accepted-message dedupe and cooldown;
- unknown provider outcome survives rollback without a second provider attempt;
- ten attempts, each across a full process restart, retain the hourly quota;
- after only the oldest sliding-window slot expires, exactly one new slot is admitted;
  a subsequent request remains limited until the next old timestamp expires;
- the 60-second recipient cooldown covers different purposes and codes;
- repeated accepted requests remain deduplicated after process restart;
- 32 distinct codes for one recipient produce one send and 31 rate-limit responses.

Unit tests cover failed reservation/alarm setup, failed acceptance persistence,
provider errors, timeout and late acceptance. HMAC namespace, stable hash key,
stored schema, TTL, 10/hour sliding window, 60-second cooldown and sender restrictions
remain unchanged. No addresses, OTPs or message bodies were added to stored state.

## Initial checks and operations / 首轮检查与运维

- Focused Jest: **5 suites, 71 tests passed** (email boundary, delivery, template,
  Logto client and discovery).
- Repository `pnpm lint`: passed.
- Scoped email Worker TypeScript: passed with the repository compiler
  (`--ignoreConfig --noEmit --strict --skipLibCheck --target ES2022 --module ESNext
--moduleResolution Bundler --lib ES2022,DOM`).
- Formatting check: passed for changed source/test/runner files.
- Full `pnpm typecheck`: failed on task-external TS2345 errors in
  `lib/integrations/github-comment-bot-vertical.test.ts:342` and
  `lib/integrations/github-vertical.test.ts:143`; not modified by this task.
- Coverage not requested and not run. Main app build/UI flow not rerun: no app UI,
  authentication policy or mail-template change in this experiment. Prior mailbox
  receipt remains the earlier user-confirmed result, not a new delivery check.
- Temporary `cognia-logto-email-perf` Worker: deleted after a cleanup migration deleted
  both temporary SQLite classes. It had no real Email Sending binding.
- Production deployed successfully to `cognia-logto-email`, version
  `6e29ac41-b9b1-421d-8def-7fec8a6d1cb5`; same existing `EmailDelivery` binding and
  `email-delivery-v1` migration. No namespace or stored-state migration.
- Cloudflare API verified the production domain and bindings remain present, while
  the temporary domain and both benchmark namespaces are absent. Unauthenticated
  production POST returned **401**, without sending mail. The temporary benchmark
  secret file was removed; production secrets were preserved.
- Deployment evidence: `.cache/logto-email-storage-performance/deployment-verification.json`.

## Sources / 参考

- [Cloudflare SQLite storage transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Cloudflare Durable Object stubs and RPC](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)

## Follow-up: cold lookup, region and Logto transport / 冷路径与连接池优化

### Scope and findings / 定位结果

本节为上一轮后的独立实验。生产邮件 Worker 仍为
`6e29ac41-b9b1-421d-8def-7fec8a6d1cb5`，没有修改其 DO namespace、ID 派生、存储键或事务。
采用独立 Cloudflare Worker、真实 SQLite、20ms 合成邮件服务，以及实际 Logto 容器
Node 22.23.3 / Got 14.0.0。所有收件人均为 `example.invalid`，没有公网邮件压测。

真实 Logto 容器的请求从 Cloudflare AMS 进入。初次 edge 请求抓到 DNS 1293ms、
TCP 完成于 1498ms、TLS 完成于 1712ms；连接复用后的 edge 往返约 228–234ms。
这些是客户端网络观测，不算 DO 执行耗时。

Cloudflare diagnostic，每组 10 次，中位数 ± MAD，毫秒：

| Probe                                           | Fresh Worker duration | Warm Worker duration | Additional observation              |
| ----------------------------------------------- | --------------------: | -------------------: | ----------------------------------- |
| Default placement, no-op DO                     |          317.5 ± 26.5 |           15.5 ± 3.5 | handler 本身无存储操作，记录为 0ms  |
| Default, storage read                           |          361.5 ± 40.5 |           22.5 ± 3.5 | 本地读取不是主要延迟来源            |
| Default, transaction + explicit diagnostic sync |          407.0 ± 14.5 |           30.5 ± 6.5 | 首次 handler 内 37.5 ± 6.0ms        |
| Forced `wnam`, no-op DO                         |          399.0 ± 75.5 |          148.0 ± 5.0 | 远端 placement 明显增加稳定调用成本 |
| Explicit `weur`, no-op DO                       |          367.0 ± 43.5 |           22.5 ± 3.5 | 未证明比默认 placement 更快，未部署 |

DO 发起 trace 请求的出口线索分别为默认/`weur` 的 AMS、`wnam` 的 DFW。
这是出口位置线索，不是对内部实例物理位置的权威定位。直接可验证的是 warm no-op
调用约 15.5ms 与 148ms 的差异；不能把强制远端当成生产基线制造提速。

进一步进行 named versus `newUniqueId()` 的交替配对控制：新 named 对象为 365.5ms，
random-ID 对象为 171.0ms，配对差值中位数 189.5ms、MAD 58.5ms。Cloudflare 官方说明
named ID 首次定位需要全球唯一性检查，random ID 能跳过该检查。这支持定位/首次分配是
主要成本之一，而非验证码模板渲染。另对 10 个既有 ID 观测到新 activation token、seq=1，
首次调用 291.5 ± 34.5ms，同轮全新 ID 为 335 ± 22ms：旧 ID 在重激活路径也可能很慢，
不能将全部差值归因于首次创建或 JS constructor。

没有改用逐请求随机 ID：缺少持久、一致的收件人映射会拆散原有去重与限流。
没有引入 KV 最终一致性、内存额度、提前确认、跨区域并行写入或旧状态清空。
若后续要通过固定 shards/随机 child IDs 移除命名冷路径，必须先设计旧状态迁移与回滚协议。
本轮已交付的优化落在另一个有证据且不更换状态身份的环节：Logto 出站连接复用。

### Kept change and experiment / 保留的优化

上游 HTTP Email connector 直接调用 Got；Node 全局 HTTPS agent 实测开启 keep-alive，
但 socket timeout 为 5000ms。90 秒候选在 6.5 秒空闲后仍保留 32 个连接，5 秒基线保留 0。
因此新收件人的 DO 仍保持 fresh，同时可以省去重复 DNS/TCP/TLS 建连。

`deploy/compose/logto-mail/` 是新增部署适配层：出站客户端位于固定版本的只读 Logto 镜像内，
已有 Cloudflare Worker 模块无法扩展这个客户端。preload 用 Node 原生 ESM hook 精确拦截
HTTP Email connector 的 Got import；client 复用镜像已有 Got，不复制第三方实现。
仅本机 overlay 挂载并启用，其他 connector 的 Got 不变。

连接池按 origin 设 64 active / 32 idle，socket timeout 90 秒；远端仍可主动关闭连接。
另设 20 秒请求 deadline，避免网络卡住时无限等待。没有开启 HTTP/2、强制 IPv4、
关闭 TLS 校验、更改鉴权/headers、加入 POST retry 或更换发信 URL。

预先登记的 v3 实验：1 次 warmup、10 组 AB/BA 配对，每组 32 个新收件人；
每轮为两个 HTTPS 池预热，再空闲 6500ms；唯一池参数差异为 timeout 5000→90000。
实际 Logto 容器内使用其 Got 14，真实 Cloudflare Worker/DO 与合成 provider；
每个测量请求只发起一次。首次进程/TLS 冷启动不属于本次收益场景。

基线已复现 TCP 连接失败，因此 v3 在测量前明确：保留所有失败，不因基线的已知错误中止；
候选必须全部成功，收到的所有应用响应必须 200 且 provider count=1。
较早 v1/v2 的失败原始文件保留，没有把它们混入成功的 10 组样本。

| Metric, median ± MAD (ms) |         Baseline |        Candidate | Decision                                                               |
| ------------------------- | ---------------: | ---------------: | ---------------------------------------------------------------------- |
| 每批请求响应中位数        |  1199.50 ± 34.21 |   675.47 ± 12.69 | 配对改善 527.95ms，配对 MAD 48.80ms，约 44.0%，通过 ≥10% 且 >2MAD 门槛 |
| 整批完成时间              | 2602.88 ± 265.65 | 1344.09 ± 139.55 | 配对变化噪声较大，不宣称整批提速幅度                                   |
| Worker 每批 server 中位数 |    416.50 ± 6.00 |   422.75 ± 11.25 | 配对差值 -3ms、MAD 17.25ms，处于噪声范围                               |
| 接受 / 测量请求数         |        315 / 320 |        320 / 320 | 候选未重试、每个收件人 provider count=1                                |

主指标记录全部请求的客户端响应时间，包括基线的 5 个快速连接失败；按成功请求单独计算
每批中位数后，汇总中位数相同（基线 MAD 为 31.13ms）。五个基线失败发生在 TLS 建立前，Got `timing.total` 约 516–593ms，
端到端 `clientMs` 约 521–614ms，
不是邮件投递成功。原始错误完整保留，不能据此承诺所有网络环境零失败。
服务端没有可测提速，连接池没有消除 named-DO 冷路径，也未测公网邮箱到达时间。

原始数据：`.cache/logto-email-cold-path/` 下 `diagnostic.jsonl`、
`diagnostic-summary.json`、`reactivation.jsonl`、`transport.jsonl`、
`connection.jsonl`、`keepalive*.jsonl`、`keepalive-v3-summary.json`、
`keepalive-v3-failures.json` 及各 `*experiment.json`。

### Rejected alternatives / 未采用的候选

- `weur` hint 没有证明收益；保持默认 placement，避免把新对象固定在不适合未来入口的区域。
- HTTP/2 比较第 8 组遇到基线连接错误而终止；完成样本的请求中位数反而变慢
  （约 678ms→790ms），没有启用。不同连接进入 AMS/LHR 是观测到的混杂因素。
- IPv4-only 连接控制仍出现 TLS 超时；不能证明该配置解决根因，没有启用。
- 原生 KV / RPC 性能改写仍维持上一轮的移除决定。

### Verification and deployment / 验证与部署

- Native ESM hook isolation integration test: 1 passed；先因适配模块缺失失败，再实现通过。
- Jest：5 suites / 71 tests passed。
- 真实 workerd：新收件人 32 个不同 code 竞争仅一次发送，升级/回滚、未知结果不重发、
  跨进程重启的小时滑动额度与窗口边界均通过。
- 原生 Logto 镜像 connector：实际 `sendMessage`、空闲后复用（TCP/TLS phase=0）、
  duplicate provider count=1、逐请求鉴权拒绝、HTTPError 类型一致性、其他 Got 隔离均通过。
- 本机 Compose 已重建且健康；实际服务 Node/NPM 进程携带 preload，两个新增挂载均只读。
- 实际 Management API 的 HTTP Email test 路径：首次、新收件人空闲后、重复请求均返回 204，
  错误凭据返回 400。仅使用临时合成收件器的 inputConfig，未保存/更换正式 connector。
- Read-back：正式 endpoint/credential 保持不变；邮箱登录、账号邮箱/Feishu、强制 MFA、
  300 秒 / 5 次 OTP 策略保持启用。
- `pnpm lint`、Worker scoped TypeScript 通过。全量 `pnpm typecheck` 本轮被无关的
  `lib/data/build-stream.test.ts:49` 与 `lib/data/read-stream-package.test.ts:28`
  的 3 处 TS2353/TS2741 阻塞，未修改这些共享文件。
- 未运行 coverage，未重新测真实收信、完整浏览器登录或其他部署平台。
- 额外 65 秒空闲检查：实际 Logto 容器中的同一适配器对正式邮件 endpoint 发起无鉴权
  探针，前后均为 401，不发送邮件；空闲后保留 1 个连接，TCP/TLS phase 均为 0。
- 最终格式与 `git diff --check` 通过。临时 Worker、custom domain、3 个 SQLite namespace
  均删除并由 Cloudflare API 核对；临时私有 benchmark secret 文件已删除。
  正式 Worker 当前仍为原 `6e29ac41-b9b1-421d-8def-7fec8a6d1cb5`、100% 流量。
- 清理/上线证据：`.cache/logto-email-cold-path/deployment-verification.json`；
  实际运行验证见 `native-connector-verification.jsonl`、`live-logto-verification.json`、
  `long-idle-verification.json`、`final-guards/guard-results.json`。

References:

- [Cloudflare named versus unique IDs](https://developers.cloudflare.com/durable-objects/api/namespace/)
- [Cloudflare data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Got 14 HTTP/2 and agent options](https://github.com/sindresorhus/got/blob/v14.0.0/documentation/2-options.md)
- [Node 22 synchronous module hooks](https://nodejs.org/download/release/v22.15.0/docs/api/module.html)
