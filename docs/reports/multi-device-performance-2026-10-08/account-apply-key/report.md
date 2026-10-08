# Account apply key 重用实验 — 2026-10-08

**判定：未保留。** 虽然每批 HKDF 派生从 256 次降至 1 次，完整 `applyBatches` 主负载仅从 **87.30 ms → 86.85 ms（−0.52%）**，未达到预注册 ≥10% 且超过 2×较大 MAD 的条件。已精确移除本实验的 production/test hunks；`lib/account-sync/data/applier.ts` 和 `.test.ts` scoped git status 为 clean。没有添加全局缓存、改变 crypto primitive 或留下未经证明有效的生产复杂度。

## 测量范围与方法

- [预注册](preregistration.md)、[冻结基线](baseline-applier.ts.txt) 和 [改动前 pilot](baseline-before-edit.json) 都先于 production 修改。pilot 1 次预热后为100.40 ms；最终决策使用交替比较，不用早期 pilot 作选择性基线。
- Apple M4 Pro / 48 GiB / macOS 26.5.2，native Headless Chromium151，production/minified esbuild ESM；电源模式未固定。与父任务和其他测量串行安排，无本任务 build/test 与最终计时重叠。
- 实际 `applyBatches`、真实 `createOpOriginChecker` 签名校验、op HKDF/AES-GCM 开封、per-field HLC merge、完整 CogniaDB 原生 IndexedDB、真实 at-rest encryption、capture armed 且 remote transaction 不重新捕获。每个样本用新的隔离账号数据库与合成 key。
- 时间从 `applyBatches` 调用起，到该批的完整事务提交结束，包含 record/clocks/HLC/cursor 写入。wire JSON 解析、生成合成 ECDSA key、seal/sign fixture、seed 和结果验证在计时外。registry 是传给 applier 的合成已验证视图；未测真实 enrollment、registry-chain 下载、网络、push 或应用 UI。
- 主负载为256条普通新会话元数据，每条包含32字符 title、createdAt、updatedAt。另测256条已有4KiB systemPrompt行的 metadata更新、256条过期更新、两个设备交替使用两个 epoch 的256条新记录、单条记录。每个批次均检查 ≤256 ops / 1MiB 上限。
- 每个 variant/workload 1 次预热 + 10 个有效样本，顺序 baseline/result 与 result/baseline 交替，共 **100 个有效样本**，没有剔除离群点。HKDF `deriveBits` 和 DBCore calls 使用相同轻量包装计数，计时包含其开销。这里没有单独 crypto 微基准或 p95 结论。

## 结果

时间单位 ms。原始样本：[comparison.json](comparison.json)；汇总：[metrics.json](metrics.json)。

| 负载                      | baseline median / MAD | candidate median / MAD | 改善幅度 | 2×较大 MAD |
| ------------------------- | --------------------: | ---------------------: | -------: | ---------: |
| 主指标：256条新会话元数据 |          87.30 / 2.65 |           86.85 / 4.20 |    0.52% |       8.40 |
| 256条已有4KiB行更新       |         142.35 / 9.80 |         150.45 / 12.20 |   −5.69% |      24.40 |
| 256条过期更新             |          71.15 / 1.40 |           70.70 / 2.45 |    0.63% |       4.90 |
| 双 epoch 交替256条        |          97.00 / 1.75 |           97.20 / 1.70 |   −0.21% |       3.50 |
| 单条记录                  |           1.20 / 0.10 |            1.20 / 0.10 |     约0% |       0.20 |

所有结果都不支持真实提速结论。保护负载未出现同时超过10%与2×MAD的退化，但这不能替代主指标达标要求。

同 epoch256条负载的派生次数确实 **256→1**；主负载两版均读取256条主表键、执行256次主表写入、应用并保留256行，fixture wire 均 **167,864 bytes**。交替 epoch 保持256次派生，单条保持1次。过期更新保持256次旧行读取、0次主表写入。旧 encrypted body 读取/认证从未删除。

## 候选及正确性

候选是 batch 内或一次 inbox replay 内的一项 cache。每个 op 仍按原顺序检查 own-device、schema、epoch/key存在性和 origin signature。检查 key identity、32-byte快照和当前 spaceId 后才复用派生；bytes/spaceId 在 await derivation 之前快照，支持同 epoch key替换、原地字节修改与作用域变化。不同批次及不同调用重新派生。没有声称主动清零内存；测试证明的是“不跨边界重用”，不是 zeroization。

- 基线回归测试 **1 failed / 10 passed**：同key两条 op 原来派生2次，而候选要求1次。
- 完整候选测试：**4 suites / 41 tests passed**（applier、op-origin、sync.integration、sync-round）。包含5项新增场景：同key重用及同ID顺序、batch/call边界、key对象替换、原地key修改后原子失败、spaceId变化后原子失败；原有旋转、schema skew、inbox replay、删除/复活及多副本收敛测试也通过。
- [native-guards.json](native-guards.json)：两个版本均通过事务第二次写入故障回滚、真实账号锁定、最后一条签名错误、合法签名但错误 ciphertext；检查失败未留下 record/clocks/cursor 部分状态。
- 每个有效样本比较完整 durable rows、field clocks、cursor、HLC、outbox/inbox，并以 raw Dexie 检查行和clocks均存为 encrypted envelopes。
- 独立 reviewer 未发现正确性阻断。Scoped ESLint通过（spaceId小修订前）；Prettier写入过候选。最终41tests覆盖完整候选，未因测试通过而保留未达性能阈值的修改。恢复后未重跑全库；父任务统一 gate。
- Harness准备期间修复过一个构建括号错误，以及一个错误的 HLC断言：`receiveHlc` 留下 remote2000，而不是 local now5,000,000。均发生于保存有效baseline之前；未改变 workload/阈值或丢弃已接受样本。

## 重现与文件状态

保留 [candidate-applier.ts.txt](candidate-applier.ts.txt) 和 [candidate-applier.test.ts.txt](candidate-applier.test.ts.txt)，生产文件已恢复。冻结源的SHA-256见 [source-sha256.json](source-sha256.json)，共享依赖和测量entry bundle摘要见 [environment.json](environment.json)。构建脚本现在从两份冻结源加载 variant，避免回滚后误把基线与基线作比较；此导入路径调整不改变冻结候选的代码。

```sh
rtk proxy node docs/reports/multi-device-performance-2026-10-08/account-apply-key/build.mjs
rtk proxy python3 -m http.server 18753 --bind 127.0.0.1 --directory /tmp/cognia-account-apply-key-2026-10-08
rtk proxy agent-browser --session account-key-20261008 open http://127.0.0.1:18753
rtk proxy agent-browser --session account-key-20261008 eval 'window.runBenchmark("full")'
rtk proxy agent-browser --session account-key-20261008 eval '({progress:window.benchmarkProgress,error:window.benchmarkError,done:!!window.benchmarkResult})'
rtk proxy agent-browser --session account-key-20261008 eval 'window.benchmarkResult' > docs/reports/multi-device-performance-2026-10-08/account-apply-key/comparison.json
rtk proxy python3 docs/reports/multi-device-performance-2026-10-08/account-apply-key/summarize.py
```

只在 done=true 且 error=null 时导出；`runBenchmark("guards")` 运行独立保护检查。每次样本 finally 删除隔离数据库；专用browser/server已经关闭，browser errors为空。未运行 coverage、真实手机/Tauri/网络验证，未提交代码。

另一个 count 代替delete前body读取的候选因会移除旧body认证而在修改production前拒绝，见 [拒绝记录](../account-delete-existence/report.md)。Account-sync snapshot/compaction 目前仍为 ADR0215 phase3b 未实现项，不存在可测的现成snapshot接收路径；不能把备份snapshot当作已部署account-sync路径宣称提速。
