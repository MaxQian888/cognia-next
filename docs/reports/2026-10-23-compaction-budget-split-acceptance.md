# Compaction budget split 与真实 TUI 验收

日期：2026-10-23（Asia/Shanghai）。模型：`ark-deepseek-v4.1-flash`，经本机 `127.0.0.1:8787/v1`。未启动 Tauri，未运行 typecheck、coverage 或全仓构建。

## 实现

复用现有 SendOptions、provider attempt、compactor、ledger、PII gate 和 continuation 通道，拆分三个预算：

| 预算                                         | 默认策略                                                                                           | 显式配置                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 单次摘要生成 `maxSummaryTokens`              | 受摘要模型输出能力与窗口限制；包含 reasoning                                                       | 原始请求值保留，换模型重试重新按能力裁剪 |
| 累计 `checkpointTokenBudget`                 | 初始按 retained input 和 summary input 分配，准备压缩时使用实际可用 state 空间；可超过单次生成预算 | 不擅自放大                               |
| 完整压缩后 input `postCompactionTokenBudget` | 包含 framing、固定指令、checkpoint、完整最近工具对及并发尾部                                       | 不擅自放大                               |

新默认不再写入 16,384 的数字输出上限；已有持久化数字仍视为显式配置。默认目标不足以容纳 framing 与最近工具对时，只在安全窗口内调整；发布还需检查完整候选大小和工具对完整性。成功压缩后需有新增增长才再次软触发，硬限制仍可立即处理。小窗口默认同步压缩，显式 background 配置保留。

累计事实使用 host-owned `facts`；普通 summary 重写不能删除或替换已提交事实，完成状态不能无理由回退。显式纠错保留旧 statement/history。旧 prose 在升级时保留。续跑首次压缩恢复结构化 checkpoint，避免仅从文字重新构造进度。

格式修复和超预算草稿精简共用一次有界重试，只处理未发布草稿；仍走原 PII、ledger 和取消路径，失败不发布。失败摘要前缀缓存继续使用，防止相同前缀重复计费。

自动路径发送前检查预计 input，SDK 内部下一步也计入新增 text、tool arguments/results；超窗且压缩无法腾出空间时明确 incomplete，保留 conversation snapshot，停止发送。

预算暂停日志不再对所有工具结果写死 2,048 字符：使用现有 retained input 预算扣除 framing/checkpoint。已被成功 AI 摘要覆盖的正文改由 checkpoint 接管，执行路径和成功/失败 header 仍保留；最近未摘要正文在预算内完整保留。被提前省略、随后有 checkpoint 覆盖的执行 header 可恢复。extractive 模式不错误退休 raw result。无预算元数据的旧调用保留原有限 excerpt fallback；真正超出 aggregate budget 时仍明确省略/截断，不能保证无限无损。

## 默认／压力配对

同一份 38 页语料，7,543 行、38 个不同 code hash，同文件区间不重叠；两组复制字节一致。真实源码来自 CLI agent/runtime 等模块，无重复填充、搜索替身或 Tauri。Explore 顺序读取，Plan 复用报告。验收逐行检查完整 behavior、Evidence code、copied 和 original provenance 引用，不能以 code-only 报告代替。

| 组   | input 窗口 |                    主调用 | 摘要调用 | 实际压缩发布 |  交付耗时 | 行为/引用 | 主请求峰值 |
| ---- | ---------: | ------------------------: | -------: | -----------: | --------: | --------: | ---------: |
| 默认 |    936,000 | 42（Explore 39 / Plan 3） |        0 |            0 | 236.103 s |     38/38 |    104,908 |
| 压力 |     32,768 | 41（Explore 40 / Plan 1） |       16 |            8 | 541.696 s |     38/38 |     27,065 |

两组 38 页各读一次，Plan 未重复读取这些源码。默认组有两次 `ls`；压力组末尾有两次意外 directory read（`.`、`research`），不宣称零无效工具调用。压力组 16 次辅助请求不等于 16 次上下文压缩：包含分批及一次 schema 修复。全部正常 stop；辅助请求合计 338.329 s。8 次压缩后的下一次触发前，测得有约 5,068–9,638 token 新增长，没有压缩后立即反复触发。

压力组原脚本因 Plan 将 XML 标签改为命名 Markdown 标题 + JSON fence 误报；保留原始 failed 记录。解析器修复先红后绿，随后对原产物重新执行 behavior/code/citation、唯一读取、transport、窗口和 Plan 复用断言，均通过，见 `semantic-revalidation.json`。这不是重新推理，原推理产物未改写。原进程在断言失败后由测试 SIGINT 清理，未计作正常退出；独立恢复审阅后正常 `/exit` 62 ms、相关进程全停、源码工作区未改。默认原流程正常 `/exit` 3,621 ms。

这组数据说明本任务在默认窗口无需摘要；32K 压力窗口下 framing、累计事实、最近源码共同占用 input，仍需分批。不能声称默认模型窗口只有 32K，也不能声称所有任务都不会压缩。请求了 thinking disabled，实际仍观察到 reasoning；不能把 relay 收到的参数当作已经生效。

## 验收中发现并修复的问题

- 早期 code-only 验收掩盖了行为 prose 丢失，已撤销该通过结论，增加 host-owned facts 与严格行为行检查。
- 压力早期稿累计 state 卡在 6,553 tokens，拒绝发布后主请求继续涨到 56,519；已补实际 state 分配和发送前保护。该次不通过。
- 预算续跑早期稿最后一次 read 的中段被 2,048 字符 excerpt 删除，实际重读一页未变化源码；已修复 journal 分配及 checkpoint 接管。该次不通过。
- 验收器曾误把合法 `unknown` 枚举当成缺失事实；兼容命名 JSON fence、明确的纠错前缀；严格行为和引用断言仍保留。
- 恢复计划审阅的检查曾早于模型 turn 完成；现先关闭审阅并等 idle，再检查 transport，允许必要的 `exit_plan_mode`。

## 预算耗尽、纠错与重启续跑

最终构建：`budget-semantic-6`，20 页独立真实源码任务。主步数预算先设 10，暂停后正常 `/exit`，重启同一 owner，再经 `dispatch_agent(resume:"bg-b32c3577")` 继续。仅将一个已读来源的 Evidence marker 改为新值，允许重读该来源一次；其他来源不变。

| 检查                | 实际结果                                                                           |
| ------------------- | ---------------------------------------------------------------------------------- |
| 暂停                | 106.102 s 后明确 incomplete；原 run ID、checkpoint 和 source journal 落盘          |
| 暂停前读取          | 10 页；7 个 checkpoint 接管 header，3 份未摘要完整正文；0 truncation/omitted 提示  |
| 首个恢复 child 请求 | 包含原有证据，未启动全新调查                                                       |
| 续跑读取            | 11 次，包含唯一一次获准纠错重读；未变化来源重读 0 次；合计 20 个唯一来源           |
| 最终报告            | 20 条 behavior + code + 双来源引用；修订行明确 supersedes 旧 code                  |
| 主请求峰值          | 26,889 / 32,768                                                                    |
| 续跑交付耗时        | 344.146 s；19 次请求（含辅助摘要）                                                 |
| 最终清理            | 独立 `resume-exit` 无额外推理，exitCode 0，72 ms，2 个所属进程全部停止；工作区未改 |

原始脚本先把介绍语中的 inline `<source-findings>` 当成真正 JSON 起点，随后过度限定了纠错的固定标签行。回归先红后绿，解析器现选择真正 JSON 矩阵，并接受修订行中明确的 `supersedes OLD`；仅共存旧/新 code 仍拒绝。对未改写的真实交付重跑所有 behavior/citation/correction、first-child、journal、零重复、transport 和 window 断言均通过。原始 failed 记录保留，没有将 SIGINT 清理算作正常退出。

## 对应文件验证

- 应用 Jest：228 项通过（3 suites）。
- Sidecar：290 项通过（progress checkpoint、strategy、compactor、dispatcher、AI SDK adapter）。
- 验收辅助脚本：22 项通过。合计 540 项，不重复累计先前失败或重跑次数。
- 25 个 owned source/test 文件的 ESLint（0 warning）、Prettier 和 scoped diff check；CLI JavaScript-only 构建通过。
- 只读 PII/预算审查未发现新增发送旁路；同模型真实验收是独立证据层，不等同 mock。
- 未运行 typecheck、coverage、Tauri 或全仓 lint/build。未提交 Git。

## 证据边界

独立只读源码核对确认压力报告 38 行均有具体行为及对应 code/provenance，未发现早期整批事实丢失。仍有模型过度概括：图片全部失败分支不会添加 inline note；contextVersion 比较只在传入期望版本时执行。host 保留的仍是 model-reported findings，不能宣称全部模型结论正确。

默认／压力数据取得后，预算日志补丁增加了接管 ID metadata 和暂停 continuation 组装；普通压缩候选、预算策略和普通最终报告路径未改。最终构建对该新增暂停路径另做真实预算续跑验收；各组保存独立 source hash。

可选跨模型复核按用户选择跳过。未提交或清理其他会话数据。

## 证据文件

根目录：`.cache/compaction-budget-split-2026-10-23/`。

- `default-semantic-1/pressure-results.json`：原始默认验收。
- `pressure-semantic-3/pressure-results.json`、`semantic-revalidation.json`、`per-compaction-timing.json`：压力原记录、严格复核与逐次耗时。
- `pressure-semantic-3/pressure-exit-results.json`：独立正常恢复退出。
- `budget-semantic-6/budget-results.json`、`semantic-revalidation.json`、`resume-exit-results.json`：预算真实记录、完整严格复核和正常退出。
- `source-final.json`、各组 `source-frozen.json`、`owned.patch`：所有权及源文件快照。
