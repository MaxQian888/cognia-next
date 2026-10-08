# Memory sync 未超限缓存读取优化 — 2026-10-08

判定：**保留** `lib/sync/handlers/memory.ts` 的一行 count 快路径。完整 `syncMemories` 主负载中位数从 **88.30 ms 降至 55.00 ms（−37.71%）**；减少 33.30 ms，超过预注册的 10% 门槛及 2×较大 MAD（2.30 ms）。这衡量本机实际 wire 解密及加密数据库落盘路径，不是网络吞吐或真实手机端到端配对时间。

## 改动与边界

原实现每个非空 apply slice 后先 `memories.toArray()`，读取、解密全部缓存内容，再判断是否超过 1,000 条。现实现捕获同一个 table，先 `await table.count()`，未超限直接返回 0。超限时保留原 `toArray()`、长度复查、pinned → lastAccessedAt → updatedAt → id 排序和删除代码。

没有 schema、wire 格式、加密、cursor、DEK pairing、写入顺序或 slice 大小调整。超限路径仍全量读取、解密、排序；没有宣称该路径的内存占用有界。count/toArray 都是各自时点的快照，原实现也没有把读取与删除放在同一事务中；并发写入可能使缓存暂时超限，本改动不保证原子硬上限。

## 对比方法

- [预注册](preregistration.md) 和 [冻结基线](baseline-memory.ts.txt) 先于生产源文件修改；[baseline-before-edit.json](baseline-before-edit.json) 保存实际改动前的 1 次预热 + 1 次有效样本（89.10 ms）。决策依据是最终交替比较，不是此单次 pilot。
- macOS 26.5.2 / Apple M4 Pro / 48 GiB，Headless Chromium 151，esbuild production/minified ESM。机器没有专用隔离或固定电源模式；已与同任务其他代理串行安排计时，计时期间没有本任务测试/build。[environment.json](environment.json) 包含 revision、源文件及 bundle SHA-256；工作树有他人的未提交改动，不能仅凭 HEAD 重建。
- 每个 workload、每个 variant 1 次预热 + 10 次有效样本，baseline/result 与 result/baseline 交替。4 个 workload 共 80 个有效样本。没有剔除离群点或反复测量挑选结果。
- 每次使用新隔离账号数据库，完整 CogniaDB schema、实际 account-content 加密中间件、原生 IndexedDB 和 WebCrypto。构建、开户、生成合成密钥、seed、wire 加密及正确性检查不计时。
- 计时覆盖实际 `syncMemories` → `runSyncHandler` → JSON delta 解析 → 实际 `openMemorySyncRowV1` wire 解密 → 加密 bulkPut → prune → 返回 outcome。wire fixture 由实际 `createMemorySyncRowV1` 生成，每条 text 恰好 4,096 ASCII 字节。已有 `loadDek` 注入点提供合成 CryptoKey，模拟已配对 DEK；没有真实配对 RPC、网络、认证或外部凭据。
- account sync capture 未启用，未生成 outbox；这不是 capture 启用成本的测量。构建复用 full-schema harness 的搜索 indexer stub，但本 memory 路径不调度搜索索引；该 stub 不替代被测读写/加密/修剪函数。

## 结果

时间单位 ms；MAD 为中位绝对偏差。接受主指标需改善 ≥10% 且绝对差值 >2×较大 MAD；保护指标只有同时恶化 >10% 且超出此噪声门槛才拒绝。

| 负载                                    | 基线 median / MAD | 改动后 median / MAD |     差值 | 判定                         |
| --------------------------------------- | ----------------: | ------------------: | -------: | ---------------------------- |
| 主指标：已有 800 + 新增 200，恰好 1,000 |      88.30 / 1.15 |        55.00 / 1.10 |  −37.71% | 通过，保留                   |
| 超限：已有 1,000 + 新增 200，保留 1,000 |     118.30 / 3.30 |       117.55 / 1.25 |   −0.63% | 噪声内，不宣称提速           |
| 空缓存 + 新增 1 条                      |       1.35 / 0.15 |         1.05 / 0.10 | −0.30 ms | 未严格超过 2×MAD，不宣称提速 |
| 已有 800 + 空 delta                     |       0.00 / 0.00 |         0.00 / 0.00 |  0.00 ms | 低于计时分辨率，无百分比结论 |

所有保护指标通过。小样本不支持 p95、设备电量或长期生产分布结论。

主负载 DBCore payload query 返回行数 **1,000 → 0**，query 调用 **1 → 0**，count **0 → 1**；wire delta 均为 **1,197,449 bytes**，DEK load/实际 wire 解密各 **200** 次，写入 **200** 行、删除 **0** 行、一次 RPC、保留 **1,000** 行。超限仍读取 1,200、删除 200、保留 1,000。DBCore 计数不等同物理磁盘 IO 或 IndexedDB 内部请求总量。

每次样本检查完整持久化字段/text、保留 ID、applied/nextSince，使用 raw Dexie 读取存储层验证 `__cogniaEncryptedContent` 存在且不存在 plaintext text。

## 正确性与失败记录

- 先添加 co-located 回归：未超限 0/1/2 条不加载 payload，以及 count 失败传播。基线运行预期 **4 failed / 8 passed**；修复后相关测试全部通过。溢出测试覆盖 pinned、recency、updatedAt 和 id tie-break。
- [native-guards.json](native-guards.json)：两个 variant 都通过缺失 DEK、篡改 AAD、异步 DEK load 后取消、不重复生成记录的 replay、真实账号 cipher lock 检查。
- Pilot 初次运行因 harness 使用 JSON 字段插入顺序比较而报错；改为递归 key 排序比较后才保存 baseline。此修复不改变 fixture、生产函数或计时范围。
- 初次 lock guard 直接调用 `cipher.lock()`，它只清除对象内 key，保留全局注册；此人为半锁定状态中 count 不解密，候选返回而基线解密失败。生产账号 lifecycle 调用 `lockAccountContentCipher()` 同步清除全局注册，activation 同步替换为新 cipher；已检查生产调用者且独立审核未发现该半锁定状态的生产路径。guard 因此改为实际账号 lock API，两个 variant 均拒绝。**不把直接 instance.lock 测试算作通过，不声称所有低层构造状态或所有并发 lock 时序完全相同。**
- `rtk proxy pnpm exec jest --runInBand lib/sync/handlers/memory.test.ts lib/sync/memory-content-protocol.test.ts lib/sync/handlers/base.test.ts lib/sync/scheduling.test.ts`：**4 suites / 61 tests passed**。
- scoped ESLint、Prettier check、git diff --check 通过。Prettier 最初报告新增测试格式，已只格式化 owned test 文件并复查通过。native browser errors 输出为空。
- 独立只读审核覆盖 capture table、cipher lifecycle、原有 snapshot 并发边界。全库 gate 由父任务统一报告；这里没有运行 coverage 或宣称全库/真实 Tauri/Capacitor/iOS/Android/network 验证。

## 重现

原始数据：[comparison.json](comparison.json)，汇总：[metrics.json](metrics.json)，统计脚本：[summarize.py](summarize.py)，harness：[benchmark.ts.txt](benchmark.ts.txt)，构建：[build.mjs](build.mjs)。本目录保存基线源代码；result 导入当前 production handler。

```sh
rtk proxy node docs/reports/multi-device-performance-2026-10-08/memory-prune/build.mjs
rtk proxy python3 -m http.server 18751 --bind 127.0.0.1 --directory /tmp/cognia-memory-prune-2026-10-08
rtk proxy agent-browser --session memory-prune-20261008 open http://127.0.0.1:18751
rtk proxy agent-browser --session memory-prune-20261008 eval 'window.runBenchmark("full")'
rtk proxy agent-browser --session memory-prune-20261008 eval '({progress:window.benchmarkProgress,error:window.benchmarkError,done:!!window.benchmarkResult})'
rtk proxy agent-browser --session memory-prune-20261008 eval 'window.benchmarkResult' > docs/reports/multi-device-performance-2026-10-08/memory-prune/comparison.json
rtk proxy python3 docs/reports/multi-device-performance-2026-10-08/memory-prune/summarize.py
```

只有 done=true 且 error=null 时导出；`runBenchmark("guards")` 运行独立保护检查。结束后关闭专用 browser session 和 loopback server；每个样本的隔离数据库在 finally 中删除。未提交代码。
