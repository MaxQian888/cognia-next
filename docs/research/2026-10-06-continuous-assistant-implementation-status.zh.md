# 持续型个人助手缺口补全：实现与验证记录

本记录接续 `2026-10-06-cognia-muse-dot-continuous-assistant-deep-comparison.zh.md`。用户随后要求“完整补全这些功能”，本轮因此实施前一报告确认的五组缺口，并接通共享记忆 API 的调用方范围配置。

快照：2026-10-06 13:55 UTC；工作区 `/Users/bytedance/Project/cognia-next`，当时 HEAD `4482de7b8`，包含本轮未提交实现。HEAD 在并发工作中持续推进，本文描述工作区源码而非一个发布版本。没有提交、推送、部署；没有改动并发 Office/插件实现，也没有访问凭据或线上服务。

## 1. Radar：来源、决策、目标、结果

- 生成器兼容旧版字符串 actions，并接受带 `sourceIndexes` 的结构化建议；校验、去重索引，保存可追踪的 memory/capture 引用。
- UI 可切换历史报告、展开仍可读取的来源、接受或忽略建议；来源被删除、失效或不可读时显示不可用，不用保存的全文替代当前来源。生成报告本身仍是持久化记录。
- 接受决策与唯一 scheduler task 在同一 IndexedDB 事务内提交。任务使用稳定 ID，同一建议的并发接受不会新建两个任务；调度注册失败保留任务和失败状态，可重试注册。
- 实际 executor 使用现有 **goal** 路径，创建持久化目标、背景会话，继承已有预算与工具审批规则，并启用 `requireAcceptance`。完成判断与用户最终确认分开；等待确认不进入自动重试。
- Radar 可直接显示该 scheduler execution 的目标/会话结果入口，保留统一任务详情、失败处理和恢复入口。
- 自动报告遵守总开关；关闭时删除并解除 scheduler 定时，修改日程后立即重新注册。启用状态下的非法自定义 cron 不再覆盖已保存配置。

主要入口：`lib/radar/suggestions.ts:18`、`components/pet/console/radar-suggestions.tsx:15`、`lib/radar/radar-cron-bridge.ts`、`lib/scheduler/executors/goal-executor.ts:151`。

验收证据：`suggestions.test.ts` 覆盖并发接受、注册失败与同一任务恢复、不兼容决策；`radar-runner.test.ts` 覆盖关闭开关与来源引用；`radar-panel.test.tsx` 覆盖非法日程不落盘；goal executor/runner 测试覆盖最终确认的等待状态。

## 2. 记忆：关闭后仍可删除，批量操作报告真实结果

- 关闭记忆学习后，控制台删除/失效与已获授权的 forget 仍可执行；暂停学习不等于阻止用户减少已存数据。
- 删除以 canonical 数据事务为准，避免成功删除后第二次 audit/evidence 写失败被显示为“删除失败”。向量删除尽力执行，失败进入既有 reconcile 机制。
- 批量清理逐项累计真正成功数，返回失败 ID；UI 仅移除成功项，失败项保留选择并提示部分失败。
- `principalGrants` 支持按可信 principal 或 `transport:*` 设置 scopes、projects、characterIds、agentIds；每次共享 API 操作重新解析权限，与宿主绑定的 namespace 取交集。
- list/count/search/store/update/forget 及 workflow memory recall 使用生效的调用方范围；无配置保持原账户级行为。配置变更后的新操作会读取新限制。
- 设置界面支持编辑限制、全部拒绝、恢复继承以及保存失败保留草稿。此配置限制共享记忆 API；账户所有者的管理控制台仍可查看、纠错、删除自己的数据，既有工具/会话权限继续有效。

主要入口：`lib/memory/api/caller.ts:18`、`lib/memory/api/mutate-memory.ts:202`、`lib/memory/control-plane/manage.ts:108`、`components/settings/memory/principal-access.tsx:16`。

验收证据：调用方权限交集、撤权、畸形配置、global scope 排除、写入前拒绝、关闭后的向量清理、部分删除失败及 UI 重试均有共置测试。

## 3. IM：明确控制哪一个任务

- 同一对话里有多个匹配的有效任务时，普通“继续/停止/批准”等控制不再默认命中最近任务，而是返回任务选择。
- 可回复对应任务消息，或发送带 `[run:…]` 的精确指令；过期或不存在的指定任务不会落回普通 AI prompt 执行。
- 仍走既有 run-control 身份授权与最新 revision/interrupt 检查。只有执行被接受后才消费按钮/文本控制登记；拒绝不会吞掉可重试入口。

主要入口：`lib/connectors/follow-up-control.ts:205`。共置测试覆盖多任务歧义、显式任务选择、回复较早任务、拒绝不消费，以及多个已有 IM 平台。

这修复的是任务指向，不宣称已经建立所有连接器账号之间的统一身份或跨设备同步服务。

## 4. 远程 worker：携带并执行继承的权限合同

- handoff 增加版本化 portable policy，包含 permissionMode、工具允许/禁止列表、MCP server 名称及 sandbox 资源/网络/路径限制。
- 只携带 MCP 名称；不把连接凭据或父机器绝对路径传给 worker。工作区内路径转换为相对路径，并在 worker 的实际 repository root 下绑定。
- dispatcher placement 要求 `worker-policy-v1` 能力；接收端也验证版本和执行能力。当前不能履行合同的 external runtime、旧 worker 或缺少所需 sandbox 的 worker 会明确拒绝，不通过丢弃限制来执行。
- sender 与 host 的权限取交集；host 更严格的限制继续有效。sandbox 的读写根按路径包含关系求交集；当前适配器不能表达的空路径集合会拒绝执行。
- handoff 随 session durable state 保存，重启 materialize 后每次 turn 继续应用；实时提高 permissionMode 也不能越过继承上限。
- required sandbox 绑定失败会持续阻止后续 turn，不会只拒绝第一次后清掉失败状态。

主要入口：`packages/agent/src/handoff-envelope.ts`、`lib/ai/agent/team/workers/remote-worker-policy.ts:78`、`cli/src/worker/worker-connect.ts`、`cli/src/agent/rpc/durable-state.ts`、`cli/src/agent/rpc/runtime-service.ts`。

验收证据：序列化/版本拒绝、工作区路径转换、MCP 信息最小化、两端能力检查、策略交集、进程服务实例重建后的约束、重复 sandbox 失败拒绝均有测试。没有启动真实远程 worker、连接线上服务或做攻击路径测试。

## 5. 承诺与交付：独立义务、显式重试、版本确认

### 多子任务结算

- 时间上更晚的成功不再覆盖其他独立任务的失败。
- `obligationId` 与 `replacesRunId` 明确记录哪个 attempt 替代哪个义务；只有显式同义务 replacement 才能消除旧 attempt 的失败。
- 仍有失败/取消义务时，父 delegation 保持 `recovery_required`，不伪报完成；重试处理所有尚未成功的义务，保留已成功的兄弟任务。
- replacement lineage 与旧 attempt 的 retry receipt 原子写入，并更新旧 snapshot 的可用动作。相同控制命令复用既有 receipt，不重复重试已替代的 attempt。

主要入口：`lib/execution/delegation.ts:214`、`lib/execution/delegation.ts:227`、`lib/execution/delegation-bridge.ts:145`、`lib/execution/control-handlers.ts`。

测试覆盖独立失败不被成功覆盖、显式 replacement 结算、多个失败义务一次恢复、重复控制不重复派发、成功兄弟不重跑。本实现不宣称所有外部副作用 exactly-once；已有“不确定副作用需人工核对”的恢复边界继续成立。

### 交付版本与确认

- `issue.link_artifact` 保存交付时的 artifact 内容和展示元数据副本；优先识别尚未持久化完成的新编辑，避免把旧 DB 版本误当当前交付。
- 使用既有 SHA-256/canonical JSON 工具生成 digest，版本身份与 href 共同去重。同一个 artifact ID 编辑后再次交付会产生新版本，重复交付相同内容不会额外制造版本。
- 旧版本预览读取交付副本，不再读取 artifact store 的最新内容。副本保存在 issue run 历史内，随既有 issue/run 删除生命周期清理；来源后续删除不会篡改已经交付的历史。
- 用户确认绑定精确 delivery ID 与 digest，记录独立 `deliverable_accepted` 事件。确认 v1 不会确认 v2；引擎新增链接/结算不能伪造用户确认。
- 外部 URL 可带 `versionRef`，表示用户确认的是记录的外部版本标识。UI 明确说明没有校验远端字节；没有固定版本的旧链接不显示可确认状态。
- 保存的是 artifact 内容与元数据，不承诺冻结其引用的外部资源或网页内容；UI 也直接说明这一点。

主要入口：`lib/issues/deliverables.ts:49`、`lib/db/issue-runs.ts` 的 `acceptIssueDeliverable`、`lib/skills/built-in/issues/link-artifact.ts`、`components/issues/deliverables/issue-deliverables-section.tsx`。

测试覆盖同 URL 不同版本、digest 冲突、确认幂等、v1/v2 分离、来源修改/删除后副本不变、未落盘编辑、确认失败可重试，以及拒绝引擎伪造确认。

## 6. 验证记录

- 42 个受影响的共置测试 suite 全部通过：**1,195 passed，2 skipped**。两个跳过项均为既有 RPC recording proxy 测试，它们需要绑定本地监听端口；此前在该沙箱返回 EPERM，因此未提权或启动替代服务。
- 根 TypeScript `tsc --noEmit` 检查通过。默认 4 GiB heap 首次不足，改用 16 GiB 后完成；不把内存耗尽当作类型检查成功。
- 本轮拥有的 TypeScript/TSX 文件 ESLint 通过；格式检查仅针对本轮文件，避免改写并发任务。
- `pnpm i18n:build`、`pnpm i18n:build:check`、`pnpm lint:i18n` 通过；只修改 split 翻译源，聚合文件由构建生成。
- 临时验证日志：`/tmp/cognia-continuity-tests-final.json`、`/tmp/cognia-continuity-tests-final.log`、`/tmp/cognia-continuity-typecheck-final.log`、`/tmp/cognia-continuity-eslint-final.log`。文件归属清单：`/tmp/cognia-continuity-owned-paths.json`。

以上是实现与自动化测试结果，不是六条真实用户旅程的线上验收。没有进行真正关机/重启、跨设备 IM 审批、长时间后台运行、多主机断连恢复或真实模型成本/成功率测试。Cognia 的在线执行仍依赖所选 host 可用；本轮没有配置或部署常驻服务。
