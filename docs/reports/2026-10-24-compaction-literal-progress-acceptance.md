# 首次摘要 literal 保留与预算续跑验收

日期：2026-10-24，Asia/Shanghai。实施与验收跨越 2026-10-23、2026-10-24；artifact 目录沿用开始日期。

本轮修复 Explore/Plan 共用的 progress-v1 路径：首次模型摘要遗漏的必要源码 literal 由现有 read receipt 和 checkpoint merge 保留；已交付源码的路径、版本与范围随 checkpoint 延续；恢复后的旧 checkpoint 不再与全部 journal 捆成一个不可拆分的辅助输入。保留显式预算、PII、取消、工具配对及最终上下文校验。

## 实现与信任边界

- [read.ts](../../sidecar/src/tools/builtin/core-files/read.ts) 为正常文本读取附加绝对路径、完整文件字节的 SHA-256、实际行范围、总行数及截断信息。哈希复用已读取字节，不增加文件读取。
- [read-tracker.ts](../../sidecar/src/tools/state/read-tracker.ts) 在已有 session tracker 保存路径与渲染输出的哈希 receipt。receipt 不授予写权限，也不修改 read-before-edit 的时间戳检查。
- [progress-checkpoint.ts](../../sidecar/src/context/progress-checkpoint.ts) 合并相同路径及版本的范围和 literal；不同版本分别保留。提取通用的短标量源码注释及真实用户任务明确要求的 identifier family，没有硬编码验收用的 Evidence 字段或 SOURCE_FACT 值。
- [compaction.ts](../../sidecar/src/runtimes/ai-sdk/compaction.ts) 将实际 read 调用、返回和 session receipt 对应后才加入观察记录。模型自行生成的 sources/literalFamilies 被剥离；assistant 猜测不能升级为已观察证据。重启 journal 的必要 literal 明确标为历史、未验证 freshness 的数据。
- 摘要中明确区分已交付范围与已验证结论，按路径识别并行 read 返回；纠错不重置向前调研游标。没有拦截 read。改变的源码、缺失细节、矛盾、用户指定校验和编辑前读取仍允许且需要执行。
- 恢复时复用原有 checkpoint merge 与输入分批：只移除与已恢复状态及来源消息精确绑定的 research-progress 子块；原任务、Follow-up、周围 outcome prose、失败 journal 和其他 wrapper 均保留。完整最终状态继续经过原有预算和 PII gate，超限保持原历史并明确未完成。

新增生产逻辑均扩展既有模块，没有新增 Agent、工具、执行循环或平行状态存储。没有增加模型请求来弥补首稿漏记。

## 真实模型结果

模型 ID 为 `ark-deepseek-v4.1-flash`，经 `http://127.0.0.1:8787/v1`。采用与上一轮相同的 20 份互不重复真实源码快照、32K 压力窗口、首轮 10 主步骤预算；正常退出并重启原 owner，再通过真实 `dispatch_agent({resume: ...})` 续跑。暂停后只改变一个已经读过文件的 Evidence literal，要求明确纠错。

budget-7 的所有阶段通过。暂停前的 10 次已完成读取均保存必要 literal，首 checkpoint 的 8 个已观察源码记录也零遗漏。重启后第一次子 Agent 请求携带原证据，沿原 owner / run 继续，最终保留 20 条行为、当前 literal 与双来源引用，并明确报告旧值到新值的纠错。正常退出分别为暂停后 84 ms、完成后 103 ms；最终所属的两个进程均停止。

| 组别          | 主请求 | 辅助请求 | 总请求 |  调研耗时 | read 次数 | 结果                                            |
| ------------- | -----: | -------: | -----: | --------: | --------: | ----------------------------------------------- |
| 上轮 budget-1 |     28 |        6 |     34 | 649.646 s |        31 | 严格验收失败，有额外回读                        |
| 上轮 budget-2 |     26 |        6 |     32 | 400.012 s |        22 | 严格验收失败，多读一个未变化页面                |
| 本轮 budget-3 |     25 |        6 |     31 | 488.131 s |        21 | 20 行证据完整，但纠错行带列表前缀，严格格式失败 |
| 本轮 budget-7 |     25 |        6 |     31 | 575.606 s |        21 | 全部严格验收通过                                |

请求数包含 owner 的一次启动推理；调研耗时为预算暂停阶段与重启续跑阶段之和，不含 owner 启动阶段。失败、提前停止的请求量不能作为完成同一任务的性能改善。

相对最近的上轮 budget-2，请求少 1 次（32 → 31），未变化页面的额外读取从 1 次降为 0；总耗时却增加 175.594 s。本次六个辅助请求合计 436.914 s，占调研时间约 75.9%，比该旧样本的 247.011 s 多 189.903 s；其余阶段合计反而少约 14.309 s。六次请求均发送 thinking.type=disabled，响应仍报告共 42,422 reasoning tokens，且全部正常 stop。这里只能确认辅助请求延迟主导本次耗时，不能声称 thinking 已成功关闭或稳定提速。未改代理、换模型、扩大 32K 窗口或抬高用户显式预算来取得通过。

这是具体样本比较，不是平均性能基准；测试还明确了既有严格输出格式，并增加输入就绪探针。32K 为压力条件，本轮结果不能直接当作默认大窗口的摘要频率或耗时。

### 严格验收条件

- 预算耗尽必须保存明确未完成状态、真实 checkpoint 和已完成读取证据，退出后内容保持相等。
- 独立检查首 checkpoint 的 8 个已观察源码记录及暂停时 10 个已完成读取，必要 literal 零缺失；不等最终报告通过回读补齐。
- 第一次续跑的子 Agent 请求必须包含持久化的旧证据；继续原 owner 和原 run，而非新建调研。
- 最终保留 20 个当前 literal、20 条源码行为及每条复制页面和原始 provenance 两种引用；纠错同时保留旧值与当前值。
- 总共只能有 21 次 read：20 个页面及一次明确要求的变化源码复核；未变化页面不得重复读取。
- 正常 `/exit` 必须 exit 0、恢复终端并停止本次 TUI 所属进程。

没有修改这些断言或放宽 sourceCorrectionEvidence。budget-3 发现模型输出列表前缀后，只把测试提示补充为与既有断言一致的独立、无列表前缀纠错行；不提前提供新 literal。预算及专用退出测试启动还增加可见输入、清空探针，确认 Ink 接受输入后再粘贴，探针不提交给模型。

## 失败尝试与环境记录

各次 budget 的失败状态与日志均保留，未将失败改成成功：

1. budget-1：20 请求，291.978 s 后失败；首次 literal 已保留，但恢复 wrapper 被视为不可拆分输入。
2. budget-2：同一问题复现；20 请求，170.222 s 后失败。只读元数据确认辅助输入预算拒绝，随后修复 wrapper 分批。
3. budget-3：31 请求，488.131 s；20 条行为与引用完整、21 次 read，但纠错行有列表前缀，原严格断言失败。正常最终退出项因此没有被计作通过。
4. budget-4：磁盘 ENOSPC 导致 harness 写 live.screen.txt 失败并终止，不能计作完整验收；检查其隔离 workspace 没有残留进程。
5. budget-5：预算暂停通过，重启时首帧先于输入订阅，长粘贴未收到；没有发送续跑模型请求。
6. budget-6：输入探针清空验证失败，无推理请求。随后改为实际确认的 Backspace 清空；独立无推理重启/退出检查通过，exit 0、61 ms。
7. budget-7：31 请求，575.606 s；完整预算暂停、正常退出、原 run 重启续跑、20 条结果、纠错、21 次 read、最终正常清理全部通过。

仅对本轮已完成测试的 6 份 PTY 日志做无损 gzip，逐份解压校验 SHA-256 后替换原文件，回收 43,102,677 bytes。Git status 前后完全相等；没有删除会话数据库、源码、依赖或其他会话数据。磁盘后续可用空间增长不全部归因于本次压缩。

补充的空会话复用退出检查曾有一次 exit 0 后 `store lock released` 断言失败，保存在 `readiness-unaffected-phase.log`；后续同目录检查 59 ms 通过。没有足够证据证明输入探针与锁释放之间有因果关系，本轮没有修改产品退出路径，也没有放宽锁断言，不把这一偶发锁边界宣称为已修复。上述 budget-7 的两次退出均通过原锁释放检查。

## 回归与检查

- 10 份相关 sidecar 测试：**345 passed，0 failed / skipped / cancelled**。包含真实 built-in read 经 dispatchAiSdk 的 receipt 接线、首稿遗漏、并行路径识别、版本/范围合并、来源伪造、assistant 猜测、PII、显式预算、read-before-edit/write，以及恢复 wrapper 分批与多 wrapper 保留。
- 现有 harness evidence 测试：**16 passed**。
- 仅对应的 10 份 TS 文件和 smoke 脚本执行 ESLint、Prettier、diff check；JavaScript-only CLI 构建成功。
- 独立只读 PII/信任审查通过。增量审查发现的多 wrapper 状态绑定和外围 outcome prose 保留问题已修复并补测。
- 最终实机运行期间生产及回归源码哈希无漂移，记录于 source-resume-frozen.json；CLI 和 harness 的最终哈希另存。实机执行脚本副本为 harness-live-budget-7.mjs；最终只将同一探针限定于预算/专用退出场景，探针执行体逐字相等，记录于 harness-scope-verification.json。
- 按用户要求跳过 typecheck、Tauri、coverage、全量 lint 和完整应用构建。本轮真实模型覆盖 CLI Explore 的一次预算中断、重启与续跑；Plan 的共用 checkpoint 路径由相关回归覆盖，不据此宣称本轮重新完成了 Plan 全流程真实验收。

## 证据

- [本轮 artifacts](../../.cache/compaction-literal-progress-2026-10-23/)：各次 budget-results.json、元数据观察、pause-literal-metadata.json、失败屏幕、严格诊断、测试和构建日志。早期 PTY 日志以 .gz 保留。
- [最终比较数据](../../.cache/compaction-literal-progress-2026-10-23/comparison.json)。
- [上一轮报告](./2026-10-23-compaction-overhead-acceptance.md)。
