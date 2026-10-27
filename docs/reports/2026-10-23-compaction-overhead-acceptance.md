# Compaction 开销修复与真实 TUI 验收

日期：2026-10-23，Asia/Shanghai。模型始终为 `ark-deepseek-v4.1-flash`，经本机 `http://127.0.0.1:8787/v1`。未启动 Tauri，未运行 typecheck、coverage 或全仓 lint/build。

本轮减少了摘要调用及输入量，默认／压力真实样本的总耗时却增加了。两次预算重启续跑均完成报告，但没有通过零多余读取的严格验收；本轮不能宣称全部验收完成，也不能把调用优化写成已验证的延迟优化。

## 实现与边界

复用 provider attempt、compactor、progress checkpoint、ledger、PII gate 和 continuation；没有新增第二套预算或摘要执行器。

- 大窗口的默认单次摘要输出预留封顶 32,768 tokens，不再直接预留模型全部输出能力；小窗口保留半窗，32K 压力窗口仍预留 16,384。显式输出 cap、重试时原始 requested cap、累计 checkpoint 和压缩后总 input 的显式配置继续保留；旧式 Anthropic 显式 additive thinking 计入同一输出预算。
- 结构化旧 checkpoint 只向摘要模型发送 goal、constraints、导航、状态、fact ID 和来源引用；已经提交的 statement、legacy prose、精确 literal 留在 host，合并后仍完整交给执行 Agent。导航可以替换，不能再靠改写导航复制全部旧事实。
- 摘要输入使用现有估算，并根据同一 provider/model/credentials/config 的实际 usage 校准：保留 15% 余量、0.8 的保守下界及 framing。字符分布显著变化时使用保守估算；格式修复与精简不污染源码分批的校准。分批、发送前检查和 ledger 使用同一估算。
- usage 直接取 stream finish metadata，不为观察 usage 额外等待 result getter；取消后返回的结果不能重建校准状态。
- 缺失导航 `summary` 确定性补为空串；delta 缺失 goal/constraints 时继承已校验锚点。显式无效值、非法状态、缺失必需 evidence、重复 ID 等仍拒绝。首次 checkpoint 仍需原始锚点。
- 修复一个真实验收发现的问题：首次无效 JSON 草稿进入修复后，模型可能把 goal 改为“Repair only this UNPUBLISHED JSON draft”。现在独立校验并保留原始任务锚点，修复响应仍先通过完整 schema 校验，再恢复锚点；无法取得有效锚点时保留原历史并拒绝发布。修复指令不能变成后续研究目标。
- 摘要默认请求的 DeepSeek thinking 控制及用户显式选项继续保留。实际 usage 与 `thinking=disabled` 矛盾时，每个配置上下文仅记录一次无原文告警，不自动重试、不偷偷换模型或协议。

## Thinking 控制核实

DeepSeek 官方接口文档规定 `thinking: {type: "disabled"}`；已核对安装的 SDK 序列化及本机代理的透传路径。当前真实路线仍未实现零 reasoning：

| 探针                              | HTTP | reasoning tokens |    耗时 |
| --------------------------------- | ---: | ---------------: | ------: |
| Chat `thinking.disabled`          |  200 |                9 | 2.974 s |
| Chat `reasoning_effort:none`      |  200 |               17 | 1.151 s |
| Chat 两者同时关闭                 |  200 |                9 | 0.888 s |
| Responses `reasoning.effort:none` |  200 |               33 | 1.990 s |

探针使用固定短指令，仅保存 metadata。`low` 探针也返回 reasoning，不能凭短指令推断真实任务的 low effort 效果。压力最终组的 12 个摘要请求都实测发出 `thinkingType=disabled`、输出 cap 16,384，但合计仍报告 35,116 reasoning tokens。无法据此确定远端哪一层忽略或重解释参数；不能宣称关闭 thinking 已生效。

官方资料：[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/)。这些资料支持参数契约，实际通道行为以本轮探针为准。

## 默认／压力配对

同一份 38 页、7,543 行的真实源码切片，38 个不同 code hash，无同文件重叠区间。两组 manifest 与复制字节一致；固定 task、模型和最终构建，顺序运行。Explore 先完成全部来源，Plan 复用报告；验收逐行检查 behavior、Evidence code 和 copied/original 两种来源引用。

对照为上一轮已接受记录，并非同一时刻的统计性 A/B 实验。旧压力记录的格式误判及独立退出验证见 [上一轮验收报告](./2026-10-23-compaction-budget-split-acceptance.md)；没有改写旧数据。

| 组                  | 主调用：旧 → 新 | 辅助调用：旧 → 新 | 压缩发布：旧 → 新 | Explore + Plan 耗时：旧 → 新 |
| ------------------- | --------------: | ----------------: | ----------------: | ---------------------------: |
| 默认，936,000 input |         42 → 41 |             0 → 0 |             0 → 0 |          236.103 → 294.357 s |
| 压力，32,768 input  |         41 → 42 |           16 → 12 |             8 → 8 |          541.696 → 745.204 s |

新默认组 Explore 39 / Plan 2 次主调用；压力组 Explore 41 / Plan 1。两组均为 38 个来源各读一次，Plan 源码重读 0 次；最终 38/38 行行为、code 和双来源引用保留，全部请求 HTTP 200 且正常完成。压力组额外出现一次 `TaskCreate` 和一次 `TodoWrite`；不能宣称模型完全没有任务外工具调用。旧压力组两次无效 directory read 没有在新组重现。

压力组总请求 57 → 54，辅助调用减少 25%。辅助 input 合计 151,427 → 120,446（减少 20.5%），output 合计 55,430 → 48,038（减少 13.3%）；旧完整 prior 在 consolidation 估算中约 20–23K 字符，新 prior metadata 最大 8,028 字符，观察到的 committed statement 回读数为 0。

但辅助请求耗时 338.329 → 437.392 s，主请求耗时 200.327 → 304.622 s，总交付增加 203.508 s。新组首次两批摘要耗时 141.702 s，旧组为 56.296 s；新 Explore 最终答复 86.974 s，旧为 60.761 s。默认组没有摘要，耗时也增加了 58.254 s。这些数据证明调用及 token 量降低，无法证明延迟降低；不能只凭一次样本把全部差异归因于代理排队、模型采样或提示变化。

### 压力组逐次压缩

| 发布版本 | 压缩前主 input | 发布后预计 input | 摘要分批数 | 摘要请求耗时 |
| -------- | -------------: | ---------------: | ---------: | -----------: |
| 1        |         26,908 |           16,466 |          2 |    141.702 s |
| 2        |         25,681 |           17,455 |          2 |     52.912 s |
| 3        |         26,399 |           17,200 |          2 |     59.045 s |
| 4        |         27,422 |           18,128 |          2 |     64.816 s |
| 5        |         24,973 |           20,230 |          1 |     38.794 s |
| 6        |         25,950 |           19,262 |          1 |     14.930 s |
| 7        |         26,279 |           20,639 |          1 |     37.209 s |
| 8        |         25,143 |           21,127 |          1 |     27.984 s |

12 次均为源码分批，不含 schema repair、失败重试或额外 consolidation 请求；12 个摘要 input hash 均不同。首次四次尚需在 16,384 的摘要 input 预算内拆成两批，后四次各一批。publish 数没有下降：相同 32K 压力限制下，新增源码、必要 framing、近期完整工具对和累计事实仍需占用空间。成功后均继续读取新的来源，未发生没有新增源码的立即再压缩。主 input 峰值 27,422，摘要实际 input 峰值 13,060，均在对应限制内。

导航/输入估算会多次调用 prior serializer；观察器记录的 98 次 `prior-payload` 是本地估算，不是 98 次模型请求，也不是完整旧事实回读。默认组未触发这些摘要路径。

新默认组正常 `/exit` 3,451 ms，压力组 3,645 ms；各自 exitCode 0、terminal restored、3 个所属进程已停止。该时间是正常清理，不使用强制退出替代。

## 预算续跑的失败样本

`budget-1` 使用 20 页独立真实源码，主预算 10 步，89.816 s 后明确 incomplete。checkpoint 和全部 10 个 read header 已持久化：7 个结果由 checkpoint 接管，3 个最近结果完整保留；journal 36,728 字符，无 truncation/omitted 提示。正常退出保存的 resultText 与暂停结果逐字相同；重启后的第一个 child 请求带有原始证据。

该次不能标为严格续跑通过：模型第一次 checkpoint 就遗漏了两个来源的精确 code，后续新增来源又遗漏两个，行为和来源引用仍在。host 保留已提交 fact，但无法从未写入 draft 的信息凭空恢复 code。最终模型为补齐这些 code 读取了来源 footer，还发出数次超出文件范围的 offset；总 read 执行 31，严格允许值为 21（20 个唯一来源，加一次授权纠错重读），超出 10 次。缺失 code 的来源为第 6、7、11、12 页。

最终 20 行 behavior/code/provenance 齐全，修订与旧值的替代关系也有明确自然语言说明，但没有遵循验收器要求的 correction 行格式，因此原脚本先报 correction-format failure；继续检查读取 metadata 仍会因多余读取失败。没有把正确语义的格式差异说成真实纠错丢失，也没有把源码重读归结为格式误判。最终 cleanup 为 SIGINT、exitCode 130，不算正常完成退出。

本轮 host 保障的是已经提交的事实不因后续 delta 丢失，不是保证模型首次提取时永不遗漏任何任务所需 literal。未增加针对测试 marker 的生产正则，也未禁止缺失证据时必要的重新核实。该失败完整保留在 `budget-1/budget-results.json`、`pause-journal-metadata.json` 和 `strict-failure-analysis.json`。

## 同条件预算续跑复测与未完成项

`budget-2` 未改源码、构建、prompt、语料或断言。115.981 s 后按 10 步主预算暂停，正常退出保留原 resultText，重启同一 owner 并继续原 run ID `bg-f7829240`。pause journal 36,811 字符，保留 10 个 read header、7 个 checkpoint 接管结果和 3 个完整近期结果，无省略/截断。首次 resumed child 请求带有原始证据。

复测最终通过全部 20 行行为、当前 code、copied/original 引用和显式 supersede 检查，6 个摘要均正常 stop，3 次压缩发布，无格式修复或失败重试。所有原暂停来源的 code 被保留；第 11 页 code 在首次加入 checkpoint 后也始终存在。然而模型仍额外读取该未变化来源一次，导致 `22 !== 21`，原脚本正确失败。这一例没有证据表明 host 丢失进度，而是模型在已有证据下仍重复核实，不能和 `budget-1` 的首轮提取遗漏混为一谈。

| 预算组          | 主调用 | 辅助调用 | 暂停 + 续跑耗时 | read 执行 / 唯一来源 | 严格结论                                 |
| --------------- | -----: | -------: | --------------: | -------------------: | ---------------------------------------- |
| 上轮基线        |     25 |        7 |       450.248 s |              21 / 20 | 原格式误判，严格语义复核通过             |
| 本轮 `budget-1` |     28 |        6 |       649.646 s |              31 / 20 | 不通过：提取遗漏后多次重读；另有格式差异 |
| 本轮 `budget-2` |     26 |        6 |       400.012 s |              22 / 20 | 不通过：保留了证据，仍多读一次           |

调用计数均含一次 owner startup 推理；耗时按相同研究阶段相加，不含 owner startup。两个新样本均没有作为 passing acceptance 计入。复测摘要 input 峰值 13,262、主 input 峰值 26,857，均在窗口内；辅助总 input 54,661、output 33,984，reasoning 27,308。

原失败流程的最终清理是 SIGINT，不能算正常 `/exit`。随后单独恢复 `budget-2` 的保留 profile，不增加模型请求，正常 `/exit` 75 ms、exitCode 0、terminal restored、2 个所属进程已停止；工作区只有授权 marker 纠错，其他复制源码字节未变。该独立退出证据不会使先前的严格续跑失败变为通过。

尚未解决的验收边界是：首次模型提取仍可能漏任务要求的 exact literal；即使 checkpoint 完整，模型也可能进行一次多余核实。需要覆盖感知的原始证据恢复或更可靠的执行收敛机制，不能只靠再追加 prompt、禁用必要校验或针对测试 code 硬编码来宣称消除。当前 thinking-disable 通道也未生效。此次没有追逐通过样本继续反复重跑。

## 未接受的中间尝试

- `pressure-1`：cache-only CLI bundle 缺少 `undici` 解析路径，0 次推理；补齐指向现有 CLI dependencies 的缓存 symlink。
- `pressure-2`：尝试把 32K 窗口的默认生成预留降至 8K；两次完整 HTTP 响应仅有 reasoning、没有正文或正常 finish，分别 55.701 / 54.909 s。该草稿撤销，第三次调用在取消失败运行时中止；最终保留 16K，不把强行缩小预留当作性能优化。
- `pressure-3`：delta 锚点继承和 repair 校准隔离之前的版本，存在额外 schema repair；已被替代，未等待最终交付，不算通过。
- `pressure-4`：观察器插入锚点过期，0 次推理；修正缓存中的观察器，并先做 import preflight。
- `pressure-5`：真实发现首次 repair goal 被替换，导致 Explore 提前交付、Plan 重读；还有一次仅 reasoning 的异常摘要被拒绝。保留失败记录；增加目标锚点修复及 Explore 全覆盖 / Plan 零重读的严格断言后重跑。

这些失败运行的定向取消不计入正常退出证据。最终默认／压力验收均使用 `source-release.json` 对应同一最终源码，完整脚本通过，没有对最终产物事后放宽断言。

## 对应文件验证

- 应用 Jest 231 项、Sidecar 202 项、验收辅助脚本 22 项通过，合计 455 项；不重复累计红测试或重跑。
- 新回归覆盖旧事实不回读且 host 保留、缺失导航无需修复调用、输入 usage 校准与配置/字符分布隔离、repair 不污染分批估算、thinking 无效仅告警不重试、取消后不污染状态、首次 repair 原任务不被替换；既有显式预算、PII、取消、ledger 和工具对检查继续通过。
- 9 个对应 source/test 文件的 ESLint（0 warning）、Prettier、scoped `git diff --check` 和 CLI JavaScript-only 构建通过。
- 按 AI SDK skill 要求的只读 PII 审查未发现新增发送旁路；校准只保存计数，告警不保存原文或 reasoning。
- 未运行 typecheck、coverage、Tauri、全仓 lint/build。未提交 Git，未清理其他会话数据。

## 证据位置

根目录：`.cache/compaction-overhead-2026-10-23/`。

- `default-1/pressure-results.json`、`pressure-6/pressure-results.json`：最终原始请求 metadata、行为/来源断言及正常退出。
- `budget-1/budget-results.json`、`budget-2/budget-results.json`：完整保留的两次严格续跑失败；`budget-2/semantic-result.json` 单独说明语义完成与严格读取失败的区别。
- `budget-2/resume-exit-results.json`：保留 profile 的独立正常恢复退出，不额外推理；`comparison.json`、`pressure-6/per-compaction-timing.json` 为可重算的对照数据。
- `summary-observe.jsonl`：共享只读观察日志，按本次 run 的 PID/时间段过滤，不能混入中间失败运行。
- `thinking-probes.json`、`thinking-responses-probe.json`：真实 thinking 参数探针。
- `source-release.json`、`baseline-hashes.json`、`owned.patch`：最终源码指纹和本轮增量；长时间验收后再次核对未漂移。
- `regression-red.log`、`provider-red.log`、`delta-red.log`、`repair-anchor-red.log`：对应修复前的失败证据。
- `jest-final.log`、`sidecar-release.log`、`harness-release.log`、`lint-release.log`、`format-release-check.log`、`build-release.log`：最终局部验证。

行为矩阵的完整性检查不等于证明每条模型解释都正确；累计 facts 仍是 model-reported findings。当前证据覆盖指定模型、该源码语料和这些运行条件，不推及全部模型或所有任务。
