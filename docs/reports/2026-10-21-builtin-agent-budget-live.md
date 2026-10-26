# Explore / Plan 真实模型预算、续跑与仓库调研验收

日期：2026-10-21（Asia/Shanghai）。使用用户授权的 DeepSeek endpoint 与 `deepseek-flash`。当前未提交工作区源码；本报告不代表已部署版本或 Tauri UI 验收。

## 合成文档：预算耗尽与续跑结果

| Agent   |    首次真实模型请求 | 顺序文件读取 | 预算终止                         | 续跑真实模型请求 | 续跑文件读取 | 最终结果                      |
| ------- | ------------------: | -----------: | -------------------------------- | ---------------: | -----------: | ----------------------------- |
| Explore | 22（HTTP 200 × 22） |           22 | error_max_turns，明确 incomplete |                4 |            3 | success，完成 25 章           |
| Plan    | 22（HTTP 200 × 22） |           22 | error_max_turns，明确 incomplete |                4 |            3 | success，完成 25 章与实施计划 |

两个 Agent 均超过了原来的 20 轮。首次预算来自统一配置 `aiSdkMaxSteps: 22`，内置定义没有 `maxTurns`。续跑配置预算为 32。

两个续跑的首次真实 API 请求均包含已保存的第一条事实，最终报告同时包含第一条事实与新读取的最后一条事实。续跑前已将前 20 份夹具文件移出原路径；实际续跑只读取第 23–25 份文件，没有重新读取旧文件。

机器可读结果与模型最终原文见 [验收证据](./2026-10-21-builtin-agent-budget-live.json)。完整逐请求计数、路径与部分报告保留在本机 `.cache/builtin-agent-live/attempt-3/`，该目录不进入 Git。

## 正常预算下连续完成的耗时（本次补测）

按用户要求，仅修改验收脚本：默认使用CLI 默认配置的 256 步预算，不再故意在第 22 步停止。生产预算与执行策略没有修改。模型、25 份短合成文档、顺序读取约束均沿用前次场景。

| Agent   |        dispatch 至返回耗时 |      真实模型调用 | 顺序读取 | 结束状态 | 续跑次数 |
| ------- | -------------------------: | ----------------: | -------: | -------- | -------: |
| Explore | 74.609 秒（约 1 分 15 秒） | 26，全部 HTTP 200 |    25 份 | success  |        0 |
| Plan    |      42.912 秒（约 43 秒） | 26，全部 HTTP 200 |    25 份 | success  |        0 |

两个 Agent 都在同一次运行内读取完整链条，最终报告包含 `CHAIN_COMPLETE`、第一条与最后一条真实读取的事实。第 26 次模型调用用于输出最终报告，没有触发预算耗尽。两者累计 dispatch 耗时 117.521 秒。

计时包含 dispatch、模型等待、工具和本地执行开销，排除 bundling、sidecar 启动及检查命令。每个 Agent 仅测一次且顺序运行；短合成文档的结果不能代表大型仓库调研耗时，也不能据此断言两个角色的固有速度差异。运行中另有本地静态检查负载，不是受控性能基准。

原始记录：`.cache/builtin-agent-live/completion-1/evidence.json`；最终原文：同目录下 `Explore-complete.txt` / `Plan-complete.txt`。可提交的脱敏记录已合入上述 JSON 的 `uninterrupted_completion` 字段。

补测复现：完成前述 bundle 后，安全设置 `DEEPSEEK_API_KEY`，运行：

```sh
COGNIA_LIVE_MODE=completion COGNIA_LIVE_RUN_DIR=.cache/builtin-agent-live/new-completion node .cache/builtin-agent-live/bundle/live.mjs
```

## 真实仓库代码调研（本次补测）

使用同一 DeepSeek `deepseek-flash`、真实 CLI dispatcher/sidecar 和默认 256 步预算，直接读取当前 Cognia 工作区。调研任务是：梳理 desktop/CLI/headless 的内置子代理调用链、步数/资源预算、超时、取消、压缩与续跑；Plan 接收 Explore 完整报告后核对关键源码并制定未实施的改造方案。允许自然批量搜索/读取，没有要求至少调用多少次，也没有预设文件数。启用只读文件/结构搜索工具、plan 权限模式；禁止修改源码。每个实验另设 20 分钟外部超时，均未触发。

| Agent   |                dispatch 耗时 | 模型 API 请求 | 工具调用（含失败） |        read 调用 | 模型终态          |
| ------- | ---------------------------: | ------------: | -----------------: | ---------------: | ----------------- |
| Explore | **430.196 秒（7 分 10 秒）** |       **159** |            **279** |     61，全部成功 | success，自然结束 |
| Plan    |  **247.486 秒（4 分 7 秒）** |        **48** |            **139** | 79，其中 77 成功 | success，自然结束 |

所有 207 次模型 API 请求均返回 HTTP 200。工具错误各 4 次：Explore 为 1 次 bash 错误、3 次 grep 错误；Plan 为 2 次 read 错误、2 次 grep 错误。API 请求次数与工具调用次数不同；一轮可以批量调用多个工具。Plan 已获得 Explore 摘要，因此不是从零独立重做同一项调研。累计 dispatch 耗时 677.682 秒；计时不含 bundle、sidecar 启动和后置检查。

原合成文档仅产生“25 次读取 + 1 次报告”，不能用于估算真实代码任务。此次真实代码的 Explore 请求数是该样例的约 6.1 倍，但仍只是一次指定任务的测量。

### 实际输出与核对

- [Explore 模型原文](../../.cache/builtin-agent-live/repository-1/Explore-repository.txt)：17,270 字符，包含三种入口调用链、预算/超时表、续跑与压缩行为、测试覆盖和未确认项。
- [Plan 模型原文](../../.cache/builtin-agent-live/repository-plan-1/Plan-repository.txt)：包含对 Explore 的纠错、分阶段文件级改造建议和验证方案，**未实施**。
- [合并原文](../../.cache/builtin-agent-live/repository-model-reports.md) 已在 Codex 中打开；原文也完整保存到本报告 JSON 的 `repository_research.results[*].final_report`，不依赖缓存长期保留。

抽查源码确认的关键发现：

1. 内置角色级 20 步限制已经移除；ai-sdk 的默认 256 步仍由 `sidecar/src/runtimes/ai-sdk/index.ts:526-534` 决定。
2. **本节调研时发现桌面子代理仍有默认 5 分钟墙钟（后续已修复，见下方补测）**：`dispatch-run.ts:192` 在未配置超时时不生成 deadline；`lib/plugin/agent-sdk/dispatch.ts:242-244,314` 因此不传 timeout；`lib/ai/agent/agent-executor.ts:698-701` 继续省略 timeout；`lib/claude/run-and-capture.ts:678,961` 使用 5 分钟默认值。CLI 子代理则在 `cli/src/agent/subagent-runner.ts:299` 显式传 0。这里是源码路径核对，**没有执行桌面超时验收**。本次 CLI Explore 用时已超过 5 分钟。
3. 显式 step/turn 预算与共享 token 预算需要分开描述：同一个 root 的 token guard 会由 `dispatch-budget.ts:35-47` 复用，显式续跑并不必然清空它；每次重新派发的步数预算则是新的。Plan 已纠正 Explore 在这一点上的过度概括。

模型自然结束仅表示它返回了最终报告。机械引用检查发现：Explore 的 72 处显式代码行引用覆盖 59 个路径，其中 `lib/agent-tasks/goal-headless-runner.ts` 当前不存在（实际入口在 `lib/scheduler/executors/goal-headless-runner.ts`）；Plan 的 71 处引用覆盖 46 个路径，路径和行号范围均存在。这些检查不等价于所有语义结论正确，原文中的其他建议仍需评审。

### 采集器说明

Explore 的模型终态为 success，但首版工具计数器在参数尚未流完时就按 id 去重，错误留下空的 read 路径数组，随后“没有读取源码”断言使**采集脚本退出 1**。因此不能声称两次脚本都退出 0。

模型 API 计数和 279 个工具 id 不受影响；61 次 read 均已通过工具名与对应成功 tool_result id 独立核对。Explore 的去重读取文件数无法从旧计数器恢复，未作推断。修复后计数器接收同 id 的最终参数并保持去重；Plan 捕获到 79 次 read 的全部参数、51 个成功读取的去重路径，**脚本退出 0**。Plan 使用已经完成的 Explore 报告，未为修正计数器重复调用 Explore。

复现完整两阶段流程：

```sh
COGNIA_LIVE_MODE=repository COGNIA_LIVE_RUN_DIR=.cache/builtin-agent-live/new-repository node .cache/builtin-agent-live/bundle/live.mjs
```

如只复核 Plan，可设置 `COGNIA_LIVE_EXPLORE_REPORT` 为已完成的 Explore 原文路径并使用新的输出目录。真实仓库模式会将所读取的源码经现有生产门禁送到用户授权的 DeepSeek endpoint。原始证据分别保留在 `.cache/builtin-agent-live/repository-1/` 与 `repository-plan-1/`。缓存扫描未发现本次凭据副本。生产执行策略没有修改。

## 前两组合成文档实验的验收边界

使用真实 CLI `handleCliDispatchAgent`、内置 Agent factory、`runCliSubagent`、sidecar、文件读取工具、CLI 持久日志和显式 `resume`。没有模拟模型响应，没有替换工具执行器。

夹具为 25 份合成设计文档。每份仅给出当前事实和下一份随机文件名，因此不能预先批量获知后续路径。回环 HTTP observer 将请求转发到固定的 DeepSeek HTTPS endpoint，响应流原样转发；仅记录请求次数、模型、HTTP 状态和先前事实是否存在，不保存 Authorization 或 API key。

上述两组合成文档实验是实际模型与运行链路的预算合同验收，未向外发送仓库业务源码。本次真实仓库补测另按用户授权使用实际源码。均未覆盖 Tauri 窗口操作、Anthropic SDK 或其他供应商。

## 实测发现并修复的缺陷

首次真实 Explore 调用已经达到 22 个成功 API 请求，但模型只返回工具调用，没有按提示写中间总结。旧实现将预算停止提示存成全部结果，实际调研事实未进入续跑记录。因此此前仅靠模型 partial text 的实现不足以满足续跑。

修复后，subagent 显式启用 `preserveBudgetEvidence`。捕获层独立保留已观察到的文本工具结果，仅在预算耗尽时返回 `budgetContinuationContext`，由 CLI 与 renderer 子任务执行器合入报告，经过既有输出与续跑 PII 门禁。

保存范围有界：第一条与最近 31 条结果，每条最多 2,048 字符；长输入单独截断，避免挤掉结果。省略与截断均有标记；图像/文档二进制与隐藏推理不进入文本证据。续跑携带原始任务、已保存报告和这些有限证据，不是完整原生会话恢复。

## 复现

入口：`scripts/smoke/builtin-agent-budget-live.ts`。新脚本独立存在是因为现有 external-agent smoke 不经过内置子任务预算/持久化链路。

在仓库根目录使用现有 bundler；凭据只通过环境变量或本机私密 env 文件传入，不写入脚本：

```sh
node --input-type=module <<'JS'
import path from 'node:path';
import { cliEsbuildOptions, loadEsbuild } from './scripts/build/esbuild-shared.mjs';
await (await loadEsbuild()).build({
  ...cliEsbuildOptions({
    root: process.cwd(),
    entry: path.resolve('scripts/smoke/builtin-agent-budget-live.ts'),
    outdir: path.resolve('.cache/builtin-agent-live/bundle'),
    entryNames: 'live',
  }),
  logLevel: 'warning',
});
JS
COGNIA_LIVE_MODE=budget-resume COGNIA_LIVE_RUN_DIR=.cache/builtin-agent-live/new-run node .cache/builtin-agent-live/bundle/live.mjs
```

脚本现在默认 `completion` 模式，继承正常预算、连续完成相同的 25 章；上述 `budget-resume` 模式保留原 22 步耗尽及续跑验收。两种模式均记录每个 dispatch 的实际耗时。先安全设置 `DEEPSEEK_API_KEY`；每次选择新的 `COGNIA_LIVE_RUN_DIR`。该脚本会消耗真实模型配额。此次临时凭据文件已删除，任务缓存扫描没有发现其他需要脱敏的凭据副本。

## 验证记录

- 实际 live acceptance：退出码 0；Explore 与 Plan 均通过上述断言。
- 新增回归验证工具结果的保留、长输入/输出截断、首尾保留、二进制排除、正常结束/未 opt-in 不输出续跑证据，以及两个调用方正确接线。
- 相关 Jest 回归：13 suites / 525 tests passed。完整 lint、CLI JS build、修改文件格式检查通过。
- 最新全量 typecheck 被任务外 `lib/data/build-stream.test.ts:19:199`（TS2353，`installedAt` 不属于 `PluginRow`）阻塞。本次脚本 ESLint 与 bundle 均通过。E2E governance 仍有 10 处既有违规，明细见 evidence ledger。
- `lint:static-export` 被既有 `lib/browser/extension-engine.ts:450` 的 `node:fs/promises` 导入阻塞。
- 完整证据链见 [evidence ledger](../evidence/2026-10-21-builtin-agent-budgets.md)；上述全量 gate 的失败不以本次 live 成功替代。

## 桌面共享执行器补测及压缩调研的最新状态

第三次 standalone 真实代码补测已结束：503,983ms、258 次已记录模型请求、320 次工具调用、229 次 read 尝试（228 次成功），最终为 `error_max_turns`，不是自然完成。工具活动跨度 502,490ms，五分钟后仍有 136 次工具调用。此结果支持移除默认五分钟超时后的持续活动，但未满足自然完成及复杂任务续跑的完整验收。

该补测还暴露 standalone 宿主配置缺陷：15 次 grep 全部失败，不能据此归因模型正常需要 256 轮。宿主标记修正与后续压缩优化尚未重新真实验收。按照用户最新要求，已暂停实现，充分检索官方文档/源码并完成独立审查；当前优化补丁是需要重做的未验证草稿。见[压缩策略对比与草稿复核](./2026-10-21-agent-compaction-comparison.md)。本轮没有启动 Tauri、运行 typecheck 或新增付费模型请求。

## 修订实现后的真实代码验收（2026-10-22）

本节取代前节“未验收草稿”的当前状态，保留之前失败实验作为历史。搜索宿主、协议输出预留、默认工具结果裁剪、摘要有效性/大小校验和增量 checkpoint 输入已修复。显式配置保持原义；只对未设置的摘要 cap 使用模型适配默认值。956项对应文件测试通过（主项目725、sidecar123、runtime调用方108），修改文件 ESLint/Prettier、i18n build/check/lint通过。依用户要求，没有启动 Tauri、执行 typecheck或coverage。

### 实验配置和续跑来源

使用真实 `handleCliDispatchAgent → runCliSubagent → resolveSendOptions → runAndCapture → sidecar → DeepSeek`，调用 `https://api.deepseek.com` 的 `deepseek-flash`。源码任务覆盖进程端口环境、CLI宿主/子代理预算、取消/idle、压缩和证据保存链路，使用实际文件工具，不模拟模型或工具返回。模型只读源码与测试源码，不执行测试/实现改动。回环观察器不记录凭据或隐藏推理。

为了在有限任务中覆盖多次压缩，**测试显式设置12条消息触发、1500-token近期尾部、step chunk4**。这与默认按窗口压力触发不同，不能据此推断1M模型默认每几轮压缩。主输出65536、摘要输出16384；catalog窗口1000000所解析的主输入预算934464、摘要输入预算983616。token估算与模型原生usage分别保留，不宣称这是精确服务端窗口计量。

第一次派发显式限制10步以制造真实预算耗尽，续跑继承统一 `aiSdkMaxSteps = 256`。来源：`.cache/builtin-agent-live/code-compaction-8/` 完成Explore两段和Plan首段；旧脚本把正常不存在目录查询也当宿主失败，故在进入Plan续跑前退出。修正验证分类后，`code-compaction-9`复用已通过Explore产物，并从同一个持久化Plan错误记录实际续跑，未重付费跑Explore。JSON保留 `recoveredFrom` / `reusedFrom`，不伪装成全新四段实验。

### 实际结果

| Agent   | 首段结果及耗时           | 续跑结果及耗时               | 续跑主调用 / 摘要 | 续跑工具 / read | 续跑发布压缩 |
| ------- | ------------------------ | ---------------------------- | ----------------- | --------------- | ------------ |
| Explore | error_max_turns；42236ms | success；394359ms（6分34秒） | 42 /9             | 101 /32         | 9            |
| Plan    | error_max_turns；31925ms | success；591929ms（9分52秒） | 77 /16            | 130 /52         | 16           |

首段各有10次主调用、1次摘要并发布1个checkpoint；两个角色均超过原20轮限制，续跑自然结束，未通过睡眠或最低轮数延长。Explore最后一次工具发生于续跑335421ms，Plan为543068ms，均有实际工具活动超过五分钟。上述本轮路径为CLI；较早共享桌面执行器活动验收的边界仍按原节记录，不冒充新Tauri验收。

四段合计166次模型请求全部HTTP200，27次摘要均以stop结束。23次增量摘要请求全部包含已观察到的旧checkpoint。两次预算耗尽均标记incomplete并保存源码事实；续跑首请求、续跑期间每个主请求及最终原文都保留：

```ts
if (Object.keys(value).length === 0) return {}
```

该事实来自实际 `sidecar/src/platform/process/exec.ts`，初始任务没有泄露字面内容。两段续跑均在压缩发布后继续使用真实文件工具；已有进度进入摘要，而非只保存预算停止提示。脚本最终退出0，记录accepted:true。

### 工具与答案质量的证据边界

搜索已能实际执行并返回成功结果；没有重现旧15次grep全部宿主RPC失败的问题。但模型仍产生正常工具错误：Explore尝试不支持的正则look-around、查询不存在路径；Plan一次grep传context25超过上限20，一次read指向不存在的 `lib/claude/subagent-runner.ts`。首段还尝试了未暴露的bash，返回AI_NoSuchToolError，没有执行shell。所有已记录失败保留在原始证据中，不宣称所有工具调用成功。脚本要求成功搜索，拒绝未知宿主故障；上述续跑错误由轨迹中的checkpoint及实际参数分类核对。

**自然结束与选定事实保留不等于所有源码结论正确。** Explore原文标为“基本完成”并列出未读区间；Plan还有待查项、错误引用（例如把provider-attempt-options归入sidecar）和未经执行的验证建议。报告中的“已验证”是模型措辞，不能替代本次实际测试结果；模型提出的typecheck仅是文字，未执行。这里没有宣称完整语义审计通过、全部重读被消除，或相比旧失败实验有可归因的速度提升。后者同时改变了任务、宿主和压缩触发条件，不构成A/B对照。

本地原始产物（ignored cache，不是提交文件）：[Explore原文](../../.cache/builtin-agent-live/code-compaction-9/Explore-code-resumed.txt)、[Plan原文](../../.cache/builtin-agent-live/code-compaction-9/Plan-code-resumed.txt)、[完整证据](../../.cache/builtin-agent-live/code-compaction-9/evidence.json)。源代码事实/行号是运行时快照，后续并发修改可能使行号漂移。

### 默认值与复现

统一步骤预算在 `cli/src/config/schema.ts` 的 `DEFAULT_RESOLVED_CONFIG.aiSdkMaxSteps`；sidecar优先使用显式 `maxTurns`，然后 `aiSdkMaxSteps`，最后fallback256。CLI子代理在未显式设置时继承。预算是执行保护，耗尽后必须显式resume，不会无限自动购买新预算；恢复的是原始任务、有界checkpoint和工具证据，不是完整原生会话。现有主应用设置页没有对应aiSdkMaxSteps控件，不能声称能在那里修改。

摘要默认上限为min(16384,模型输出上限,窗口四分之一)，只对没有有效显式cap的配置生效。四分之一是本项目启发式：8K摘要模型得到2048输出、6144输入；显式旧值包括500或16384保持原义，默认重试到大模型会重新解析。DeepSeek1M值未变，收尾小窗口分支使用先失败后通过的回归测试验证，没有再次付费重跑。

按上文bundler生成live.mjs后，在安全提供 `DEEPSEEK_API_KEY` 的环境中运行：

```sh
COGNIA_LIVE_MODE=repository-compaction COGNIA_LIVE_RUN_DIR=.cache/builtin-agent-live/new-compaction-run node .cache/builtin-agent-live/bundle/live.mjs
```

这会再次消耗真实配额。只有恢复本脚本同模式/模型/源码根目录的已有实验时，才设置 `COGNIA_LIVE_RECOVER_RUN_DIR`；原owner和journal从旧目录读取，新目录保留来源。最终改动未提交、未部署。

## 进度单调合并与 Plan 收敛修复（2026-10-22）

**交付状态：修复及默认组验收完成；压力组自然完成验收待补。** DeepSeek 返回HTTP402 `Insufficient Balance` 后，用户明确选择“先交付修复，压力验收待补”，之后没有再发起模型请求。

本轮修复把默认内置 Explore/Plan 的 checkpoint 改成有界结构化进度：稳定工作项ID、状态、累计已确认事实 `summary`、独立当前问题 `remaining` 和依据。主机保留原目标、约束、被后续摘要遗漏的工作项、所有状态下的已保存事实/依据；done不回退，只有remaining更新，完成后清除。提示要求将新矛盾作为独立明确修正项；主机不自动判定自然语言事实真假。单个当前状态取代多个过期待查清单，递归摘要按代码合并，不再让第二次模型摘要漏掉chunk成果。状态属于模型报告，不是可信执行凭证；没有重新加入无界read-coverage附录。

Plan的原始必需项全部done或明确blocked后，下一次主调用关闭调研工具，生成最终计划并列出阻塞缺口。pending工作、Explore、普通聊天、自定义摘要、关闭压缩、非AI和optical/sliding-window策略保留原工具行为；显式输出/尾部预算、取消和空闲保护仍生效。renderer补齐了真实子任务role身份，与CLI一致。

### 对应回归

780项测试通过：606项Jest、174项sidecar；修改文件ESLint/Prettier与diff空白检查通过。覆盖done回退/遗漏、pending局部事实丢失、完成后清除待查、递归聚合超预算、无效结构、生成结果PII、marker转义、显式opt-out，以及同一运行内pending→真实压缩→下一Plan主调用不再带工具。自定义摘要输出契约保持原义。继续跳过typecheck，没有启动Tauri或运行coverage。

压力初版 `checkpoint-stress-1` 真实复现了pending项覆盖导致源码事实丢失，已停止且不计成功。修复后的主机在pending→pending/完成更新时也保留已有事实，并让待查内容只进入remaining；相应单测先失败后通过。PII和wiring/test-gap审查发现的问题也已修复并复核。

### 最终代码的真实结果

| 配置/角色                  | 主调用＋摘要尝试 | 工具/read | 已发布压缩 | 耗时     | 结果                    |
| -------------------------- | ---------------- | --------- | ---------- | -------- | ----------------------- |
| 默认 Explore               | 56＋0            | 104/37    | 0          | 170565ms | success                 |
| 默认 Plan，复用上述Explore | 3＋0             | 8/8       | 0          | 32180ms  | success                 |
| 压力 Explore               | 10＋9            | 28/17     | 6          | 208551ms | HTTP402余额不足，未完成 |
| 压力 Plan                  | 未运行           | —         | —          | —        | 待补                    |

默认组保持真实默认token-threshold配置，峰值输入186849/23911，低于934464输入预算，因此没有触发压缩；这是默认运行策略的验收，不是1M阈值越界的真实模型证明。Plan先做四处必要freshness核验，再补四处定点读取，最终完成；无完全相同参数的重复read请求，8次读取均成功。四项原始研究问题均进入交付，所有59个请求HTTP200。任务范围和交接方式与旧77次独立调查不同，不能直接当成受控性能提升。

压力配置为显式4消息触发、512-token尾部、chunk1。19个请求中17个HTTP200、2个HTTP402（分别为摘要和主调用）；6个已发布checkpoint经独立离线核对，原始4工作项、所有旧事实/依据均保留，没有done回退；从首次观察到源码guard以后，后续主请求没有丢失它。一次早期不缩小历史的候选被正确拒绝。**这些只能证明已发生的多次压缩保留了进度，不能替代压力组自然完成和Plan压力验收。** 轨迹还含被拒绝的不可用bash调用，以及默认Explore中的超出grep参数上限；没有执行这些shell命令。

原始产物：[默认证据](../../.cache/builtin-agent-live/checkpoint-default-2/evidence.json)、[默认Plan原文](../../.cache/builtin-agent-live/checkpoint-default-2/Plan-default.txt)、[压力部分证据](../../.cache/builtin-agent-live/checkpoint-stress-2/evidence.json)。模型报告仍有未经独立证实的建议，不自动应用。

### 后续补验收

余额可用后可复用本轮已完成的同一Explore报告，避免重跑它。先按上文bundler重新生成live.mjs，再运行下列命令；**本轮未执行此命令**：

```sh
COGNIA_LIVE_MODE=repository-checkpoints COGNIA_LIVE_COMPACTION_PROFILE=stress COGNIA_LIVE_EXPLORE_REPORT=.cache/builtin-agent-live/checkpoint-default-2/Explore-default.txt COGNIA_LIVE_RUN_DIR=.cache/builtin-agent-live/checkpoint-plan-stress-next node .cache/builtin-agent-live/compaction-bundle/live.mjs
```

脚本记录Explore来源，并检查workstream/事实不丢失；它会消耗真实模型配额。当前改动未提交、未部署。

## v4.1 Flash 本地代理补验收（2026-10-22）

**结果：真实 Agent 流式工具链不兼容，默认/压力均未通过，尚未触发压缩。** 用户提供的代理保持运行；未修改代理项目或生产执行器。此前官方DeepSeek的成功和余额不足记录仍是历史结果。

目标为 `http://127.0.0.1:8787/v1`、`ark-deepseek-v4.1-flash`。实时/models HTTP200，声明上下文936000、最大输出64000；经正常discoveredModels解析得到主输入872000、摘要输入919616、摘要输出16384。入口新增显式上游地址、内存API Key和API flavor选项；转发字节保持原样，没有修补流事件。

非流式Chat工具往返探针两次HTTP200：返回一个tool_ping调用，执行参数回传后最终回答OK。Responses原始SSE探针也HTTP200并包含函数事件，但只检查事件存在，未经SDK校验，不能当成Agent通过。

实际CLI dispatcher→capture→sidecar→模型均复用同一已完成的 `checkpoint-default-2/Explore-default.txt`：

| 运行                          | API/配置       | HTTP | 耗时   | 成功工具结果/压缩 | 失败原因                           |
| ----------------------------- | -------------- | ---- | ------ | ----------------- | ---------------------------------- |
| checkpoint-v41-plan-stress-1  | Chat/压力      | 200  | 2772ms | 0/0               | 工具增量type为空字符串             |
| checkpoint-v41-plan-stress-2  | Responses/压力 | 200  | 2829ms | 0/0               | function_call起始事件缺少arguments |
| checkpoint-v41-plan-default-1 | Responses/默认 | 200  | 3406ms | 0/0               | 同上                               |

Chat拒绝片段含 `"type":"","function":{"arguments":"}"}`。已安装 `@ai-sdk/deepseek` 3.0.59的chunk schema只接受type省略/null或function，不接受空字符串。Responses的 `response.output_item.added` 含function_call的id/call_id/name/status，却没有arguments；已安装 `@ai-sdk/openai` 4.0.84要求arguments为字符串。ai版本7.0.128。结论限定为代理返回的数据与客户端不兼容，尚未证明具体由哪个上游转换层产生。

捕获虽出现read事件甚至success终止帧，外层仍返回`[Plan] failed: Type validation failed`，smoke退出1且accepted=false。没有成功工具结果、checkpoint或最终Plan。HTTP200、工具开始事件、终止帧均不能单独判通过。这些运行无法验证压缩保留、超过20轮或预算后续跑；需先修复/选择兼容流式协议再重跑。

原始拒绝帧：[Chat](../../.cache/builtin-agent-live/checkpoint-v41-plan-stress-1/rejected-stream-frame.json)、[Responses压力](../../.cache/builtin-agent-live/checkpoint-v41-plan-stress-2/rejected-stream-frame.json)、[Responses默认](../../.cache/builtin-agent-live/checkpoint-v41-plan-default-1/rejected-stream-frame.json)。[聚合证据](../../.cache/compaction-research/2026-10-21/v41-proxy-acceptance.json)。

本轮运行验收脚本构建、对应文件ESLint/Prettier和真实请求，没有重跑此前780项生产回归，没有运行typecheck、Tauri、coverage、提交或部署。密钥通过用户提供的CLI读取，仅传入进程环境，未写入报告或日志。

## 测试脚本流式兼容（2026-10-22）

用户要求在测试脚本处理前述字段。新增显式开关 `COGNIA_LIVE_STREAM_COMPAT=1`，证据声明 `observed-tool-fields-v1`，每个请求分别累计修正次数。仅删除Chat工具增量中恰好为空字符串的type，并为Responses函数起始事件中省略的arguments初始化空缓冲；不改变真实参数片段、已有参数、最终结果、错误或其他畸形字段。关闭开关仍按原字节转发；这不是生产客户端/代理原生兼容验收。

转换器独立于有副作用的live入口，便于在无密钥、无模型调用条件下测试。旧直通实现3项行为失败，修复后5项通过，覆盖UTF8任意拆包、CRLF/尾部、已存在/最终参数以及上游错误。对应文件ESLint、脚本bundle通过；继续跳过typecheck/Tauri/coverage。此前780项生产回归未在本轮重跑。

同一Explore报告复用后的Chat默认Plan已自然完成：7次主调用、15次工具（12次read、3次grep）、38625ms、0次默认压缩；所有工具成功，无完全相同参数的重复read。未触发默认token阈值，因此不证明真实1M边界压缩。压缩压力补跑结果见本节后续最终记录。

Responses另以真实已安装SDK完成完整流式工具往返：2次HTTP200、1次实际tool_ping执行、最终OK；恰有1次函数起始arguments修正。[往返证据](../../.cache/compaction-research/2026-10-21/stream-responses-roundtrip.json)。这证明已观察到的Responses协议问题被脚本处理，不等于完整Responses代码研究自然结束。

第一轮兼容压力与完整Responses补充研究在并行验收期间遭遇ENOSPC，未计成功；原始日志保留。只删除本任务4个旧的可重建bundle目录，未删除journal、调研报告或其他任务缓存，未停止用户代理。后续单独重跑压力组；证据持久化改为临时文件写入后rename，失败仍报错并保留旧JSON，避免目标先被截断。

### 兼容后的最终结果

| 场景                      | 主调用/摘要请求 | 工具/read | 有效压缩 | 耗时      | 结论                                       |
| ------------------------- | --------------- | --------- | -------- | --------- | ------------------------------------------ |
| Chat默认Plan              | 7/0             | 15/12     | 0        | 38.625s   | 自然完成，exit0                            |
| Chat压力Plan（单独补跑）  | 29/29           | 65/42     | 3        | 1200.022s | 触达显式20分钟测试边界，interrupted，exit1 |
| Responses SDK流式工具往返 | 2/0             | 1次执行   | 不涉及   | —         | 最终OK，通过协议往返                       |

默认与压力复用同一已完成Explore报告。Chat字段修正分别726/3062次（按片段计数，不是调用轮数），两组共65个API请求均HTTP200，但只有默认组交付最终方案。压力组原始最后输出为`[Plan] interrupted.`；虽然底层result subtype仍出现success，smoke最终拒绝（source-fact断言失败），不能据此声称自然完成。20分钟来自本轮既有的显式测试AbortSignal，不是生产默认超时。

独立离线核对压力的3个已发布状态：原始4个工作项、目标、约束、全部旧事实/依据保留，done没有回退；29次主请求都含选定源码事实。但continuation始终pending，最后事实文本5797字符，接近单项6000字符上限。29次摘要请求只有3个有效发布，另记录一次空文本/finish reason other被拒绝。当前证据尚不能把所有未发布候选归因于6000字符限制，需要候选级诊断才能确认根因。

实际仍有重复补查：参数完全相同的read调用为0，但有2次成功read请求的区间已被较早请求覆盖（run-and-capture.ts:1514-1553、subagent-runner.ts:230-338）。此为请求区间审计，依赖默认2000行与当时文件长度，不是内容/版本证明。模型还扩张到本次验收脚本与历史报告。2次失败grep是模型选择不存在的sidecar/src/tool-catalog路径，实际目录在policy/tool-catalog；未观察到原先空port-overlay基础设施错误。没有吞掉这些失败。

因此本轮**测试脚本协议兼容完成，压力收敛验收未通过**，不把已保存事实未丢失扩大成重复调研已彻底解决。也未完成新的v4.1预算耗尽/续跑验收。默认Plan自述仅追加两处读取，与实际12条read调用不完全一致；上述计数来自工具轨迹，模型建议未经逐项审查且未应用。

[默认Plan原文](../../.cache/builtin-agent-live/checkpoint-v41-plan-default-compat-1/Plan-default.txt)、[压力完整轨迹](../../.cache/builtin-agent-live/checkpoint-v41-plan-stress-compat-2/evidence.json)、[独立最终统计](../../.cache/compaction-research/2026-10-21/stream-compat-final-metrics.json)。对应fixture5项通过，构建、scoped ESLint/Prettier通过；只读wiring复核无问题。精确密钥值扫描1996个任务文件，0份落盘。没有运行typecheck/Tauri/coverage，没有提交。
