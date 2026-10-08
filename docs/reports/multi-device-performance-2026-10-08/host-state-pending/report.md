# HostState pending projection — 2026-10-08

判定：保留。现有 `status` 索引先筛选 pending/sending，再保留 protocol/channel 筛选和原有 action 校验，显著减少已结束队列积压对快照及实时事件应用的影响。`sortBy("id")` 恢复旧表遍历顺序，确保相同 `clientSeq` 跨 status 时的稳定顺序不变。

| 原生 Chromium 路径                | 基线中位数 / MAD | 优化中位数 / MAD | 中位数变化 |
| --------------------------------- | ---------------: | ---------------: | ---------: |
| 2056 行队列，公共快照安装完成     |  37.05 / 0.50 ms |  16.15 / 0.30 ms |    -56.41% |
| 2056 行队列，后续实时事件应用完成 |  35.65 / 0.40 ms |  14.90 / 0.20 ms |    -58.20% |
| 8 行小队列，公共快照安装完成      |   2.10 / 0.05 ms |   2.10 / 0.10 ms |       持平 |
| 8 行小队列，后续实时事件应用完成  |   1.80 / 0.10 ms |   1.90 / 0.10 ms |   +0.10 ms |

主指标改善 20.90 ms，大于预注册的 10% 和两倍较大 MAD（1.00 ms）。小队列保护指标符合预注册的 `max(5%, 2ms, 2×较大MAD)` 容差；不声称小队列提速。优化小队列快照样本中有 7.60 ms、22.30 ms 离群值，均保留于原始数据，没有删样本，也不作尾延迟或 p95 改善承诺。

## 实际执行路径与环境

调用生产 `installHostStateSync`，由本地注入 Transport 提供一次 snapshot 和一次 status；安装完成后，通过真实注册的订阅回调送入连续 HostState event，并等待 `onState`。实际执行 HostState 校验、确认状态持久化、乐观 reducer、session/draft 更新、实际 chat store 状态发布。未替换优化函数、数据库、加密中间件或 apply 路径。

使用完整 `CogniaDB`、原生 IndexedDB、实际 AccountContentCipher 和 WebCrypto。**`mobileOutboundQueue` 当前为 metadata-only 表，不加密正文**；其解密调用前后均为 0。收益来自避免遍历/反序列化无关已结束队列行，而非减少队列解密。draft 的原始存储验证确实为密文；队列原始行按其实际策略保持完整。没有改动存储策略。

环境为 macOS Apple Silicon 同一机器，HeadlessChrome 151.0.0.0、hardwareConcurrency 14，esbuild production definitions/minify、模块已预热。每个 variant/workload 一次 warmup、十次测量，样本间交替前后顺序。每次创建独立账户数据库，准备和结果验证不计时，最后删除；没有清理共享缓存。各 agent 的计时阶段串行执行。传输 fixture 不含网络延迟，唯一 build stub 是 search indexer 调度的 fail-if-called 替身，此 fixture 无 message.enqueue，未执行该替身。

大工作量包含 2048 条 sent/rejected/conflicted/deadlettered 行，每行含 4096 字符正文，另有八条 active/mixed 行；小工作量保留同样八条行而无 terminal 积压。这是代表性合成积压，不声称来自生产队列分布。

## 正确性保护

每个样本验证相同 clientSeq 跨 pending/sending 的顺序、缺失行级 clientSeq、其他 channel/protocol 排除、空 actions 和 malformed action 不投影。全部完整 outbox 行以摘要确认未被修改。两次可见状态和最终确认 channel、session、draft 的规范化内容逐项匹配预期；模板参数 `templateBinding` 保留，未创建额外消息。仅排除实际时钟产生的 `updatedAt`。

全部前后样本的投影结果摘要相同：`2e8892f5c28681e6ee4094b4ceb8e45047315a8007875975372ad79ff2f25577`。每次输入 snapshot/event/status 合计 919 字节，snapshot/status 调用各一次；带宽和 RPC 数量没有减少。

独立原生 guards 验证 canonical `lockAccountContentCipher()` 和 resync 返回前 `stop()` 的拒绝，四个结果均记录 unsubscribe 一次。初始锁定 guard 曾错误期待“完全没有确认行”；未改动基线已证明实际实现先写入 metadata-only `hostStateChannels`，随后访问加密 draft 才报锁定。已保留该诊断，并修正 guard 为验证**前后同样的已有部分确认行为**，加密 session/draft 与 outbox 内容不变。此次不宣称安装过程原子化，也不宣称直接低层 cipher 实例 `.lock()` 状态的行为。

未验证物理手机、Tauri/Capacitor WebView、WAN/中继、真实服务、真实网络恢复、UI 绘制、耗电或内存峰值。

## 重现及证据

- `contract.md`：优化前预注册、表策略与基线 guard 修正。
- `baseline-host-state-service.ts.txt`、`result-host-state-service.ts.txt`、`source-hashes.json`：源快照与哈希。
- `baseline-pilot.json`：改动前的实际公共路径 pilot。
- `raw.json`、`metrics.json`、`guards.json`：全部正式原始样本、统计与原生保护结果。
- `initial-guard-assumption-error.json`：基线 guard 假设错误的诊断，不从证据中删除。
- `benchmark.ts.txt`、`build.mjs`、`summarize.py`：可重现 harness 与统计。

在仓库根执行 `rtk node docs/reports/multi-device-performance-2026-10-08/host-state-pending/build.mjs`；以 loopback static server 提供输出目录 `/tmp/cognia-host-state-pending-2026-10-08`，在独立 agent-browser 页面调用 `window.runBenchmark("pilot" | "guards" | "full")`。完成后读取 `window.benchmarkResult`，错误为 `window.benchmarkError`。保存 full 结果到 `raw.json`，运行 `rtk python3 docs/reports/multi-device-performance-2026-10-08/host-state-pending/summarize.py` 验证判定。源码结果由当前工作树构建；冻结结果快照用于审计。
