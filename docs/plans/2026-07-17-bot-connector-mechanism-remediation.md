# Bot(IM 连接器)机制 — 缺口修复计划

**日期**: 2026-07-17
**状态**: 待评审(未实施 —— 下文每一项都标注了置信级别;凡 [CONFIRMED] 均为本会话亲手 read/grep 复核过的缺陷,不是设想)
**范围**: **单个 Bot(= 一行 `AdapterInstanceRow`)自身机制** —— 身份/生命周期、入站分派、AI 绑定、出站投递、平台能力覆盖、管理 UI/i18n。**不含**跨子系统联动(IM↔Agent↔工作流,归 crosslink 计划)与工作流引擎内部(归 workflow-linkage 计划)。
**参考 ADR**: 0009(平台连接器)、0025(A2UI↔IM 桥)、0036(WeChat/WeCom)、0059(headless 运行时)、`lib/connectors/CONTEXT.md`

> **与既有两份计划的边界(务必先读,决定了本文不做什么)**
>
> 1. `docs/plans/2026-07-16-agent-workflow-im-crosslink-remediation.md` 的 **X1** 已覆盖「IM→工作流扇出绕过 PII 红线」的**入站洞**(`bus.ts:607/913-970`)**以及**出站回发(`action.connector.send`);其 **C[纵深]修法**「outbound-runner 主发送路径对原始 segments 无条件 gate」正好覆盖本次审计新发现的两个出站 sink(`workflow-progress-runner` 扇出广播、`scheduled-outbound` 时区广播)。→ 本文**不重复立项 PII**,仅在 §4 给 X1 追加这两条 sink 的证据,强化「必须选 C 而非只做 A/B」。
> 2. 同计划的 **X7** 已覆盖「bot 模型 pin 对 IM 团队成员不生效」。→ 本文**不重复立项**,仅在 §4 追加本会话对该链路的一手复核证据 + 一个衍生缺陷 **B1**(`/status` 与真实 dispatch 漂移),后者是 X7 的可观测面,X7 未涵盖。
> 3. `docs/plans/2026-07-16-workflow-linkage-remediation.md` 覆盖工作流引擎内部。本文与之无交叠。
>
> 本文用 **B 系列**编号(Bot),避开 X 系列(crosslink)与 G 系列(workflow-linkage)。

---

## 0. 如何使用本文档

每个工作项自成单元:**问题 → 证据 → 修法 → 验收**。除非标 **依赖**,否则彼此独立,一项一个 commit。置信标签沿用既有计划:

| 标签            | 含义                                                    | 动手前你必须做什么               |
| --------------- | ------------------------------------------------------- | -------------------------------- |
| **[CONFIRMED]** | 本文作者本会话亲手 read/grep 到 file:symbol(含阳性对照) | 可信,但**行号会漂,按符号重定位** |
| **[AGENT]**     | subagent 提供证据,作者未逐行复核                        | **动手前先自行复核这条具体主张** |
| **[OPEN]**      | 真正未决,需人拍板                                       | **不要默默替它做决定**           |

> 调研由 5 个 subagent(身份/生命周期 · 入站分派/路由 · AI 绑定/出站 · 平台能力矩阵 · 管理 UI/i18n)完成。随后作者对 **B1–B7 的全部承重 file:symbol + B8–B12 的休眠类主张做了一手 read/grep 复核**(含阳性对照)。其余 P2(B13+)部分仍 [AGENT],已在表中标注。

### 0.1 证据标准(不可妥协)

凡「某门/某方法/某写入不存在」主张,均以引号包裹 grep + 阳性对照确认零才可信:

```bash
# 阳性对照:已知存在的写入必须命中,否则同一 grep 的零无意义
rg -n 'lastKnownCapabilities' lib/connectors/bootstrap/install-connector-runtime.ts   # 必须命中(boot 写 A2UI cache)
rg -n 'lastKnownSkillCapabilities\s*[:=]' lib/ components/ | rg -v '\.test\.'          # 此时的零才证明 skill cache 无 writer

rg -n 'testRequiresDesktop' i18n/messages/en.json   # discord/lark/slack/telegram 必须命中
python3 -c "import json;print('testRequiresDesktop' in json.load(open('i18n/messages/en.json'))['settings']['connections']['wecom'])"  # 预期 False
```

---

## 1. 研究结论(Bot 机制现状一句话 + 缺口的形状)

**Bot = 一行 `AdapterInstanceRow`**(Dexie `adapterInstances`,`lib/db/connector-types.ts:139`),凭证只以 `credentialsRef` 指针形式存 OS keyring,行内不落密钥。单一 bootstrap `installConnectorRuntime` 拉起全部 `enabled` 行;桌面走 `ConnectorBusProvider`(Tauri-gated),headless 走 `cli/src/serve`。**Capacitor 移动壳没有 headless 连接器运行时**(`lib/headless/runtimes/index.ts` 仅被 `cli/src/serve` import)—— Bot 实际只在「桌面 Tauri」或「CLI serve 守护进程」里跑。

入站三种模式(auto/manual/draft)+ 路由(Team>Workflow>Character)+ sibling 反环 + FIFO 回合队列 + 断路器/令牌桶/DLQ 出站 + A2UI 平台原生投射,**主干已成熟**。11 个平台适配器 + 插件连接器扩展 API 均在。

**先纠正一条过时结论(避免误判)**:曾记录的「enable/disable/create 无生命周期热路径,需重启」**已不成立** —— `install-connector-runtime.ts:598 reconcileEnabledAdapters` 经 Dexie `liveQuery` 在 `enabled` 翻转时热增删,本会话端到端复核通过。

真正的缺口分五形:**(1) 活性/正确性**(网关半死不自愈、扇出阻塞传输循环、`/status` 漂移);**(2) 平台覆盖定时炸弹**(Matrix E2EE 休眠、QQ 网关下线即黑);**(3) 用户可见的 UX/i18n**(draft 模式桌面选不了、5 个对话框 i18n key 运行时炸);**(4) 建成即休眠**(违反 Working Rule 7 的读-不-写字段、未注册 Tab/Dialog、dead 覆盖机制);**(5) 诊断/竞态/媒体/管理**的一批 P2。

---

## 2. 现有 Bot 机制全景(「详细研究」的可复用交付物)

### 2.1 数据模型(`AdapterInstanceRow`,`lib/db/connector-types.ts:139`)

| 组          | 字段(节选)                                                                                                                                                                                                                                                        | 何时读                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 身份        | `id`(`cai_<ts36>_<rand>`)、`type`、`displayName`                                                                                                                                                                                                                  | 全程                                      |
| 凭证        | `credentialsRef{keyringService,accounts[]}`(指针,密钥在 keyring)                                                                                                                                                                                                  | 适配器懒 getter 每次调用                  |
| AI 绑定默认 | `defaultCharacterId`、`defaultTeamId/defaultModel/defaultProvider/defaultReasoning`、`defaultMode`                                                                                                                                                                | 发送时 `build-options.ts` / team resolver |
| 配置        | `transportMode`、`settings`(JSON)、`trigger:TriggerPolicy`、`atResponseStrategy`、`chatAllowlist/Blocklist`、`siblingBotPolicy/botInterplayBudget`、`dispatchRules`、`controlCommands`、`outboundTuning/failoverAdapterIds/balanceAdapterIds`、`quietHours/muted` | 每次入/出站,live                          |
| 启停        | `enabled`(indexed,驱动 boot list)                                                                                                                                                                                                                                 | liveQuery reconcile                       |
| 缓存        | `lastKnownCapabilities`(A2UI)、`lastKnownSkillCapabilities`(**见 B8 休眠**)、`presence/presenceState`、`lastWhoamiAt/lastWhoamiResult`、`lastMissingScopes`、`userTokenStoredAt`(**见 B9 休眠**)                                                                  | 各消费点                                  |

### 2.2 生命周期状态机

`CREATE`(config 表单 `createAdapterInstance(enabled:true)` → liveQuery 热增) → `BOOT`(`installConnectorRuntime` IIFE:Web-Lock 单例 → `listEnabledAdapterInstances` → `buildAdapterFromRow` → `bus.registerAdapter` → `bootAdapter`(建 ctx / 注册 Rust axum 入站类型 / `adapter.start` / `registerRunningAdapter` 带 `restart` 闭包 / 心跳)) → `ENABLE/DISABLE`(只写 `enabled` → `reconcileEnabledAdapters` 热增删) → `HOT-RELOAD`(config 表单无条件 `emitCredentialsRotated` → `requeueAdapter`) → `REQUEUE/RECONNECT`(Health「重连」/ rotation / resume) → `RESUME-RECONNECT`(online/visibility 且离开≥5min) → `TEARDOWN`(disposer,owner-only 释放共享 axum)。

### 2.3 入站链路

`transport for-await → gateInboundEvent`(at-gate,sibling 反环 create-only + 黑/白名单 + at 策略,fail-open)`→ ctx.emit → bus.dispatchInboundFull → 观察者 / edit-delete-system 短路 / dedup(会话作用域 `${convKey}#${msgId}`)/ OCR / 实例查 / override+lifecycle / 插件 onConnectorInbound veto / resolveBinding → evaluatePolicy → routeInbound → 审计 → 控制命令/help/welcome 短路 → 【route-handler 回合入 FIFO 队列,不 await】→ 【workflow fan-out —— 当前被 await,见 B3】`。

### 2.4 AI 绑定两条分叉

- **单角色**:`runtime.ts:605 resolveSendOptions`(**唯一**注入 `imAdapterRow:adapterRow` 处,`:615`)→ `safeSendPrompt`(入站 PII 门)→ `assistantReplyToSegments` → `enqueueOutbound`。model 优先级 `imModelOverride→session→memberOverride(见 B12 dead)→mode→imDefaultModel(bot pin)→character.model→app`。
- **团队**:`runtime.ts:767 startTeamRunFromIM` fire-and-forget → 每 teammate 在**新 ephemeral session**(无 `platformBinding`)跑,`resolveSendOptions` **不带** `imAdapterRow` → bot pin 全失效(= crosslink X7)。

### 2.5 出站 / A2UI / 平台

出站:`enqueueOutbound`(无扫描)→ 每 job:mute→quiet→幂等 LRU→插件 onConnectorOutbound→断路器→max-attempts DLQ→令牌桶→`adapter.send/edit`。断路器不吃 `rate_limited`(正确);soft-cap 只计 `pending/failed/sending`(终态已排除)。A2UI:`workflow-progress-runner`(liveQuery IM 触发的 run)→ 可编辑适配器给累积卡、否则追加行 → `enqueueOutbound`。11 平台能力矩阵见 §5。

---

## 3. 缺口总表(B 系列;按 波次/严重度 排序)

| ID  | 缺口                                                                                                                                                                          | 级别  | 波次    | 置信        | 改动量     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------- | ----------- | ---------- |
| B1  | `/status` 团队绑定用错 resolver → 与真实 dispatch 漂移 + 显示 team 会忽略的 model pin                                                                                         | 🟠 P1 | W1.1    | [CONFIRMED] | 小         |
| B2  | 网关 socket 半死时前台+在线无自愈 → Health 假绿、静默丢入站                                                                                                                   | 🟠 P1 | W1.2    | [CONFIRMED] | 中         |
| B3  | workflow fan-out 在传输 for-await 循环上被 await → 队头阻塞 + HITL 停滞                                                                                                       | 🟠 P1 | W1.3    | [CONFIRMED] | 小–中      |
| B4  | Matrix E2EE 完全休眠(Rust 全套注册,适配器 0 调用方)                                                                                                                           | 🟠 P1 | W2.1    | [CONFIRMED] | 大         |
| B5  | QQ-official webhook UI 不可达 + server 自启键值不匹配 + 无测试(网关下线即 P0)                                                                                                 | 🟠 P1 | W2.2    | [CONFIRMED] | 小–中      |
| B6  | draft/manual 模式桌面不可编辑(11 表单硬编码 auto;移动端反而能选)                                                                                                              | 🟠 P1 | W3.1    | [CONFIRMED] | 小         |
| B7  | i18n 引用但缺失的 key:`testRequiresDesktop`×5 对话框 + `wechatOa` 缺 6 key + typo                                                                                             | 🟠 P1 | W3.2    | [CONFIRMED] | 小(纯翻译) |
| B8  | `lastKnownSkillCapabilities` 读而不写(违反 Rule 7;help 卡永远回退)                                                                                                            | 🟡 P2 | W4·休眠 | [CONFIRMED] | 小         |
| B9  | `userTokenStoredAt` 全休眠(零读零写;实际用 `settings.connectedUser`)                                                                                                          | 🟡 P2 | W4·休眠 | [CONFIRMED] | 微         |
| B10 | `TunnelTab` 未注册(不在 `TAB_IDS`)→ webhook 运营者无隧道控制                                                                                                                  | 🟡 P2 | W4·休眠 | [CONFIRMED] | 小         |
| B11 | `IdentityMergeDialog` 无产品入口(仅 test/stories)                                                                                                                             | 🟡 P2 | W4·休眠 | [AGENT]     | 小         |
| B12 | `memberOverride`/`resolveMemberConfig` per-member 覆盖机制 = dead code                                                                                                        | 🟡 P2 | W4·休眠 | [AGENT]     | 小(+决策)  |
| B13 | auto/draft 未匹配消息静默丢弃且零审计(无 `inbound.dropped` kind)                                                                                                              | 🟡 P2 | W4·诊断 | [CONFIRMED] | 小         |
| B14 | sibling 预算在 gate 处消耗(先于回复决策)+ self-id 未缓存时反环静默失效                                                                                                        | 🟡 P2 | W4·诊断 | [AGENT]     | 小         |
| B15 | deferred(mute/quiet/breaker)积压无界,soft-cap 只能 shed `pending`                                                                                                             | 🟡 P2 | W4·出站 | [AGENT]     | 小         |
| B16 | Slack 卡片执行步骤 >50 blocks 静默截断(丢终态/深链)                                                                                                                           | 🟡 P2 | W4·出站 | [AGENT]     | 小         |
| B17 | 出站/A2UI 面 19 处硬编码中英混排,零 i18n(`workflow-to-a2ui.ts`)                                                                                                               | 🟡 P2 | W4·出站 | [AGENT]     | 中         |
| B18 | requeue 重叠窗口 + reconcile-vs-requeue 双启动竞态 + HITL 占队列槽                                                                                                            | 🟡 P2 | W4·竞态 | [AGENT]     | 中         |
| B19 | Telegram/Discord 本地文件 multipart 上传缺失(声明能力但发字符串被拒)                                                                                                          | 🟡 P2 | W4·平台 | [AGENT]     | 中         |
| B20 | Discord webhook 模式 presence 永久失败;WeCom media-after-stream 未验证;Telegram welcome 事件缺                                                                                | 🟡 P2 | W4·平台 | [AGENT]     | 中         |
| B21 | 无 clone/导出导入;非 Tauri 删除跳过 keyring 清理;capability-matrix UI 不显通道能力;移动原生列表无 health;usage-presence mode 漂移;`trigger` 无编辑器;WeChat/QQ 图标仅颜色区分 | 🟡 P2 | W4·管理 | [AGENT]     | 中         |

---

## W1 — 活性 / 正确性(P1,先修)

### W1.1 · B1 · `/status` 团队绑定用错 resolver,与真实 dispatch 漂移 [P1] [CONFIRMED]

**问题**:`/status` 控制命令用 `resolveEffectiveTeamBinding`(**缺 dispatch-rule 层**)展示团队绑定,而真实入站 dispatch 用 `resolveEffectiveRouting`(**含** rule 层)。一条团队来自**匹配 dispatch 规则**的会话,实际会派发到该团队,但 `/status` 报告为 instance-default/none。其次 `/status` 直接打印 `adapterRow.default{Model,Provider,Reasoning}`,而团队回合(= X7)根本忽略这些 pin —— 运营者看到一个团队永不应用的模型。且注释自称「同一 resolver,不会漂移」是**假的**。

**证据**(本会话 read):

- `lib/connectors/commands/dispatch.ts:187` `const teamBinding = resolveEffectiveTeamBinding(adapterRow, override ?? null)`;`:185-186` 注释 "Same resolver the runtime dispatch uses, so `/status` can't drift"。
- 真实 dispatch 用另一个:`lib/connectors/runtime.ts:706-707` → `resolveEffectiveRouting`(`lib/connectors/dispatch-rules.ts:157`),它有 rule 层(`:172-182`);`resolveEffectiveTeamBinding`(`lib/connectors/policy-resolve.ts:102`)只有 `teamDisabled→override→instance-default`,无 rule。
- model pin 展示:`dispatch.ts:193-201` 打印 `adapterRow.default*`;团队实际忽略见 §4 / X7。

**修法**:

- `/status` 改调 `resolveEffectiveRouting`(需先 `matchDispatchRule(adapterRow.dispatchRules, ...)`,与 runtime 同参),移除 `:185-186` 失效注释。
- 团队绑定成立时,model/provider/reasoning 行改为标注「团队回合由团队默认模型接管,此 bot pin 不适用」(或在 X7 落地后打印团队 resolved 值)。

**验收**:单测 —— 构造一个 `dispatchRules` 命中 teamId 的 adapterRow + 空 override,断言 `/status` 输出的 team 与 `resolveEffectiveRouting` 一致(此前为 none)。`pnpm test -- lib/connectors/commands`。

---

### W1.2 · B2 · 网关 socket 半死时前台+在线无自愈 [P1] [CONFIRMED]

**问题**:网关型传输(Discord gateway / Slack socket / QQ gateway / DingTalk stream)的 socket 半死(平台 idle 断连、未上抛的 RST)后,`health()` 仍报 `running` 直到 Rust 层显式 `/close`。三条本应兜底的路径都不覆盖它:被动心跳只探 OneBot+Lark-webhook;心跳 sweep 只记录不重拨;resume-reconnect 只在 `online`/`visibility` 且离开≥5min 触发。→ 前台常驻、网络不变时,bot 在 Health 里长绿但静默丢全部入站数小时,直到用户切走再切回窗口。

**证据**(本会话 read):

- 被动探测面窄:`lib/connectors/health/passive-heartbeat.ts:57-61 isPassiveTransport` 仅 `onebot` 与 `lark`(webhook)返 true;网关适配器无被动 ping。
- sweep 只记录:`heartbeat-sweep.ts` 每 30s `recordHeartbeatNow`,从不调 `requeueAdapter`。
- resume 唯一再拨路径且门控严:`lib/connectors/resume-reconnect.ts`(`online`/`visibilitychange→visible` 且 `DEFAULT_MIN_AWAY_MS=300_000`);其 docstring 自陈正是这个 half-open 场景,却把恢复门控在 resume 信号上。

**修法**(推荐 A):

- **A [主动 liveness]** 给网关传输加一条主动心跳:心跳 sweep tick 时,对 `!isPassiveTransport && transport∈{gateway,socket,stream}` 的适配器调用其底层 Rust 连通探针(Discord/Slack 已有 gateway 连接态可查;QQ/DingTalk 查 Rust 连接表);探针失败 → 触发一次 `requeueAdapter`(带节流,避免抖动)。
- **B [事件上抛,纵深]** Rust 传输层在检测到底层 socket close/error 时,主动 emit `connectors://<type>/<id>/close`,由 TS 侧订阅 → `requeueAdapter`(消除轮询延迟)。

**验收**:e2e/集成 —— mock 一个网关适配器 `health()` 返回 stale-running(无 close 事件),推进心跳 sweep,断言触发 `requeueAdapter` 且写 `adapter.reconnecting` 审计。`pnpm test -- lib/connectors/health`。

---

### W1.3 · B3 · workflow fan-out 在传输 for-await 循环上被 await(队头阻塞 + HITL 停滞)[P1] [CONFIRMED]

**问题**:`route-handler` AI 回合已被**刻意解耦**(入 FIFO 队列,不 await —— 正是为防传输循环被 HITL 挂起回合与慢回合霸占),但**同一 pipeline 尾部的 workflow fan-out 没享受同款处理** —— 它被 `await` 到整个 workflow run 完成(可数分钟)。后果:(A) 任一订阅 `trigger.connector.inbound` 的慢 workflow 阻塞该适配器**全部后续入站**(跨所有会话);(B) 对既触发慢 fan-out 又启一个挂 HITL 审批的 ai-run 回合的消息,用户的 Allow 点击(同一传输循环上的回调)要等 fan-out 完成才能处理 —— 正是 turn-queue 本要消灭的死锁的窄版重现。

**证据**(本会话 read,await 链逐段坐实):

- `lib/connectors/bus.ts:607` `await this.fanOutWorkflowTriggers(event)`(在被 `dispatchInboundFull` await 的 `runInboundPipeline` 内);
- `bus.ts:969` `await Promise.all(dispatches)`,每个 `:945 await dispatchTrigger(...)`;
- `lib/workflow/runtime/trigger-bridge.ts:63` `await runWorkflow(...)` —— 直到整 run 结束才 resolve。
- 对照:route-handler 回合在 `bus.ts:592-594` 入队不 await,其解耦理由注释在 `:578-591`。

**修法**:把 fan-out 也从传输临界区解耦 —— fire-and-forget 到一个有界后台调度(或复用 route-handler 的 per-convKey 队列语义),`dispatchInboundFull` 不再 await workflow run 完成;保留失败审计(`workflow_dispatch_failed`)。**依赖/协同 crosslink X1**:X1 会给 fan-out 前加 PII 门 —— 门本身是同步快检,放在解耦点之前即可,两者不冲突(先 PII 门拦截,通过者再异步派发)。

**验收**:集成 —— 一个 `trigger.connector.inbound` 订阅指向 mock 的长跑 workflow(人为 3s),连发两条入站,断言第二条的 `dispatchInboundFull` 不被第一条的 workflow run 阻塞(时间断言);HITL 场景断言 Allow 回调在 fan-out 完成前即被处理。`pnpm test -- lib/connectors/bus.workflow-trigger`。

---

## W2 — 平台覆盖定时炸弹(P1)

### W2.1 · B4 · Matrix E2EE 完全休眠 [P1] [CONFIRMED]

**问题**:Matrix 房间默认端到端加密,但适配器**不接线**任何加密:入站 `m.room.encrypted` 事件被一次性 warn 后丢弃,出站往加密房发**明文** `m.room.message`(对收件方渲染为未加密/告警)。一整套 Rust 加密层(OlmMachine)已建成并注册为 Tauri 命令,却**零适配器调用方** —— 典型「建成即休眠」,且违反 Working Rule 7(未在类型标注休眠 + UI 未标注 inert + 无 pin 测试)。

**证据**(本会话 read/grep):

- Rust 11 函数全注册:`src-tauri/src/lib.rs:874-884`(`connectors_matrix_crypto_init/encrypt_event/decrypt_event/share_room_key/...`);实现 `crates/cognia-connectors/src/matrix_crypto.rs`;TS wrapper `lib/connectors/tauri/commands.ts` 的 `connectorsMatrixCrypto*` 有单测。
- 适配器 0 调用方:`rg 'connectorsMatrixCrypto|encryptEvent|decryptEvent|olm' lib/connectors/adapters/matrix/` 仅命中 `index.ts:350` 的注释「…unused (the `connectorsMatrixCrypto*` commands…」+ `:349-357` 自陈「E2EE is not wired up yet」。

**修法**(**大**,建议独立子计划,先决策范围):

- **[OPEN 范围]** 是「接线 E2EE」还是「先按 Rule 7 诚实标注休眠 + UI 明示 Matrix 仅支持非加密房 + 加一个 pin 测试」?后者是最小合规动作(几行),前者是完整特性(OlmMachine 生命周期 / 密钥备份 / 设备验证 / 附件加解密的 TS 侧编排,配合 `matrix_crypto.rs` 已有函数)。
- 若接线:入站 decrypt(`connectors_matrix_crypto_decrypt_event` + sync 变更喂 `receive_sync_changes`)、出站对加密房 `encrypt_event` + 缺会话时 `get_missing_sessions/share_room_key`、附件 `encrypt/decrypt_attachment`、`update_tracked_users`。
- 无论哪条:补 `matrix/*.test.ts` 覆盖加密房分支,消除 Rule 7 三轴违规。

**验收**:接线路线 —— 对加密房 mock 一次 encrypt→decrypt round-trip 断言明文还原;休眠路线 —— 断言加密房入站被显式标记 unsupported 且 UI 渲染 inert 徽标 + 测试 pin。

---

### W2.2 · B5 · QQ-official webhook UI 不可达 + server 自启键值不匹配 + 无测试 [P1] [CONFIRMED]

**问题**:QQ 正弃用 WS 网关(适配器源码自陈),webhook 是未来路径,Rust+TS 后端全建成(seeded-Ed25519 验签、op-13 in-band、`transport-webhook.ts`),但三处耦合缺陷让它对用户不可达:① 配置表单**硬编码** `transportMode:"gateway"`,无任何 UI 控件选 webhook;② 即便走 `settings.transport="webhook"` 逃生口,`adapterNeedsInboundServer` 只认 `row.transportMode==="webhook"` → 选了 webhook 但入站 HTTPS server 不启 → 死入站;③ webhook 路径无 TS 测试(违反 co-located 规则)。→ QQ 网关一旦下线,全部 QQ bot 变黑,用户无 UI 切换。

**证据**(本会话 read/grep):

- 表单硬编码:`components/settings/connections/forms/qq-official-config.tsx:117 transportMode: "gateway"`;无 Select 改它。
- 键值不匹配:`lib/connectors/server-transport.ts:46 if (modes.includes("webhook") && row.transportMode === "webhook") return true` —— 键在 `row.transportMode`,而逃生口写在 `settings.transport`。
- Rust 侧正确已接:`crates/cognia-connectors/src/axum_app.rs` 路由 `qq_official_webhook_handler`(仅确认存在,未逐行)。
- 无测试:`lib/connectors/adapters/qq-official/` 有 `transport-webhook.ts` 无 `transport-webhook.test.ts`。

**修法**:

- 表单加 transport 选择(gateway/webhook),写入 `row.transportMode`(而非 `settings.transport`),复用其它 webhook 平台(Lark/Slack)的 webhook-URL 展示区块;或统一 `adapterNeedsInboundServer` 同时认 `settings.transport`(二选一,推荐前者 —— 单一真相源 `transportMode`)。
- 补 `transport-webhook.test.ts`。

**验收**:单测 —— `adapterNeedsInboundServer({transportMode:"webhook", type:"qq-official"})===true`;表单选 webhook 后 `createAdapterInstance` 落 `transportMode:"webhook"`;webhook 验签+op13 的 transport 测试。`pnpm test -- lib/connectors/adapters/qq-official lib/connectors/server-transport`。

---

## W3 — 用户可见的 UX / i18n(P1)

### W3.1 · B6 · draft/manual 模式桌面不可编辑 [P1] [CONFIRMED]

**问题**:三种模式(auto/manual/draft)在 runtime 完整接线(`mode-router.ts` + `runtime.ts` draft-prepare + `createDraft` + Inbox `draft-*` UI + 移动 `draft-approval-panel`),但**桌面所有 11 个创建对话框把 `defaultMode` 硬编码为 `"auto"`**,详情面板只读 Badge 展示,桌面用户**无法选** manual/draft。讽刺的是**移动端反而能选**(`connector-policy-sheet.tsx:135` 有 `<Select>`)—— 反向 parity。→ 整条「AI 起草、人审后发」流程的桌面入口缺失,一个已建成的核心模式对桌面用户不可用。

**证据**(本会话 grep):

- 11 表单硬编码:`rg 'defaultMode' components/settings/connections/forms/*-config.tsx` → 11 处全为 `defaultMode: "auto"`;桌面连接器组件**无任何**绑定 `defaultMode` 的可编辑控件(`rg 'defaultMode' components/settings/connections/ | rg -i 'select|onValueChange|RadioGroup|setDefaultMode'` = 空)。
- 移动有:`components/mobile/connector/connector-policy-sheet.tsx:135 <Select value={defaultMode} onValueChange=...>`。

**修法**:在共享编辑面板(如 `config-detail.tsx` 或 `adapter-form-sections.tsx`)加一个 mode `<Select>`(auto/manual/draft),写 `updateAdapterInstance({defaultMode})`(字段 live 读,无需 requeue);复用移动端 sheet 的 i18n key `defaultMode`/`defaultModeHelp`(注意这两 key 在桌面 namespace 是否存在,不存在则补,见 W3.2 同批)。详情面板 Badge 从只读升为可编辑或加编辑入口。

**验收**:RTL —— 渲染 config 面板,改 mode 为 draft,断言 `updateAdapterInstance` 收到 `{defaultMode:"draft"}`;移动端不回归。`pnpm test -- components/settings/connections`。

---

### W3.2 · B7 · i18n 引用但缺失的 key(运行时渲染 raw key/抛错)[P1] [CONFIRMED]

**问题**:`lint:i18n` 只数**新增字面量**,查不出「`t()` 包了但两 locale 都没定义」这类更严重的缺陷 —— next-intl 会渲染 raw key path(或 strict 下抛错)。本次审计确认两组:

**证据**(本会话 python 直查 `i18n/messages/{en,zh-CN}.json`):

- `testRequiresDesktop` 仅 `discord/lark/slack/telegram` 定义;`dingtalk/matrix/qqOfficial/wecom/wechatOa` **en+zh 双缺失**,而这 5 个对话框都引用它:`dingtalk-config.tsx:243`、`matrix-config.tsx:301`、`qq-official-config.tsx:244`、`wecom-config.tsx:263`、`wechat-oa-config.tsx:277`。恰在 web/mobile 模式(该提示本该显示时)炸。
- `wechatOa` namespace 还缺:`webhookUrlTunnelOffHelp`(`:94,:360`)、`webhookUrlCopyAria`(`:342`)、`webhookUrlCopy`(`:347`)、`webhookUrlTunnelLoading`(`:352`)—— 这些 key 在 lark/slack/telegram 有,从未拷进 wechatOa;且 `appCredentialsRequired`(`:107` toast)是 **typo**,namespace 里是 `credentialsRequired`,`appCredentialsRequired` 全库无定义。

**修法**:走 split-source 系统 —— 编辑 `i18n/messages/{en,zh-CN}/settings/connections.json`,给 5 个 namespace 补 `testRequiresDesktop`,给 `wechatOa` 补 4 个 webhookUrl* key,把 `wechat-oa-config.tsx:107` 的 `t("appCredentialsRequired")` 改为 `t("credentialsRequired")`(或补 key,推荐改调用 —— 语义已有)。然后 `pnpm i18n:build`。

**验收**:`pnpm lint:i18n && pnpm i18n:sort:check` 通过;补一个断言 —— 对这 5 namespace 断言 `testRequiresDesktop` 在 en+zh 均存在(防回归)。web 模式手测 5 个对话框不再显示 raw key。

---

## W4 — P2 批(休眠 / 诊断 / 出站 / 竞态 / 平台 / 管理)

> 每项都可独立成 commit。[CONFIRMED] 项证据已一手复核;[AGENT] 项**动手前先按 §0.1 阳性对照复核该条具体主张**。

### 4A · 建成即休眠(违反 Working Rule 7 —— 清理或接线,二选一并标注)

| ID      | 问题 + 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 修法                                                                                                                                                                                                                         | 置信        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **B8**  | `lastKnownSkillCapabilities` 读而不写:读于 `build-options.ts:1809`(每渠道 skill 系统提示)+ `help/help-dispatch.ts:69`(help 卡族);boot 只写 `lastKnownCapabilities`(A2UI),**无任何 writer**(阳性对照:`rg 'lastKnownSkillCapabilities\s*[:=]' lib components \| rg -v test` = 空;且不在 `adapter-instances.ts` update 白名单)。后果:助手永不知渠道服务哪些 `lark.*`/`im.*` skill 族,help 卡永远回退「无内置」。类型标注为 active(`connector-types.ts:210`)实为 inert。 | 在 boot 与 hot-add(`install-connector-runtime.ts:474,639`)持久化 `platformSkillCapabilities()`(Lark 已返真实族 `adapters/lark/index.ts`),并加入 update 白名单;或删字段 + 改 help/build-options 直接实时查 + 按 Rule 7 标注。 | [CONFIRMED] |
| **B9**  | `userTokenStoredAt` 全休眠:声明 `connector-types.ts:417` + 在 update 白名单 `adapter-instances.ts:78`,但**零生产读、零生产写**(实际 OAuth「已连接」态由 `settings.connectedUser` 驱动)。                                                                                                                                                                                                                                                                             | 删字段(连同白名单项),或按其 docstring 真正驱动 OAuth「Connect vs Re-authorise」判定。二选一 + 标注。                                                                                                                         | [CONFIRMED] |
| **B10** | `TunnelTab` 未注册:`tabs/tunnel-tab.tsx`(隧道启停 + 每适配器 webhook-URL 复制)**零 import**,不在 `connections-section.tsx` 的 `TAB_IDS`、不在 `tabs/index.ts`(阳性对照:`rg 'tunnel' <两文件>` = 空)。有通过的测试掩盖休眠。webhook 平台(Lark/Slack/Telegram/wechat-oa)运营者无 in-app 隧道控制。                                                                                                                                                                     | 决策:纳入 Tab 注册(补 i18n + 验证隧道命令仍有效),或删除 tab+测试并标注。                                                                                                                                                     | [CONFIRMED] |
| **B11** | `IdentityMergeDialog` 无产品入口(仅 test/stories 渲染);CRM 身份合并不可达。                                                                                                                                                                                                                                                                                                                                                                                          | 决策:接一个入口(如 conversations/identities 面),或删除并标注。                                                                                                                                                               | [AGENT]     |
| **B12** | `memberOverride`/`resolveMemberConfig`(`build-options.ts:713`)per-member 覆盖机制 **dead**(仅定义+测试,零生产调用方);model 优先级里的 `memberOverride?.modelOverride` 层恒 inert。                                                                                                                                                                                                                                                                                   | 与 X7 协同:若 X7 落地「团队回合过 resolveSendOptions」则顺带接线 per-member 覆盖;否则删除 + 标注。                                                                                                                           | [AGENT]     |

### 4B · 诊断 / 可观测

| ID      | 问题 + 证据                                                                                                                                                                                                                                                                                                                                                                        | 修法                                                                                                                                  | 置信        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **B13** | auto/draft 未匹配消息静默丢弃且**零审计**:`mode-router.ts:32,41` 在 auto/draft 且 `!matched`(且非 `storeUnmatchedInDraftMode`)返 `"drop"`;bus 只在 `blocked` 写 `policy_blocked`、`decision!=="drop"` 写 `received`(`bus.ts:531-546`);`types/connectors/audit.ts` 入站 kind 只有 `received/deduped/policy_blocked`,**无 `inbound.dropped`**。运营者看不到「收到 N 条、选择不答」。 | 加 `inbound.dropped` audit kind,在 `!blocked && decision==="drop"` 分支写一条(含 reason=`no_rule_match`);Health 侧可选汇总。          | [CONFIRMED] |
| **B14** | sibling 反环两处:① 预算在 gate 处消耗(`at-gate.ts:186`)**先于**回复决策 → 过网关但被策略丢的消息仍烧预算,doc 承诺的语义偏移;② `selfIdsOf`(`sibling-bots.ts:51-58`)只认 `lastWhoamiResult.openId`/`settings.selfBotOpenId` —— 新加、未探 whoami、无手设 self-id 的 sibling 自我 id 集为空 → 永不匹配 → bot↔bot 环可能(叠加 Dexie fail-open catch)。                                 | ① 把预算消耗移到确实决定回复之后;② sibling 匹配缺 self-id 时降级为保守(视为潜在 sibling 或强制先探 whoami),并在 whoami 未就绪时告警。 | [AGENT]     |

### 4C · 出站 / A2UI

| ID      | 问题 + 证据                                                                                                                                                                                                                                                                                                        | 修法                                                                                                                       | 置信    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------- |
| **B15** | deferred 积压无界:mute/quiet/breaker deferral 走 `markFailed` 不动 `attempts` 也不 dead-letter(`outbound-runner.ts:657,886`);`enforceQueueSoftCap` 只能把 `pending` victim 老化(`outbound-jobs.ts:296`)。永久静音的适配器/会话的 job 以 `failed` 永存,`failed` 行逼近 5000 cap 后 sweep 无可 shed → IDB 无界增长。 | 给 deferred `failed` 行加 TTL/上限老化(区分「因静音 deferred」与「真失败」),或 soft-cap victim 纳入陈旧 `failed`。         | [AGENT] |
| **B16** | Slack 卡片执行步骤 >50 blocks 静默截断:`workflow-to-a2ui.ts:220` 只 cap pending 尾(`PENDING_DECLARATION_MAX=20`),executed 步骤显式无界;Slack `block-kit.ts:70` + `serialize.ts:51 clampBlocks slice(0,50)` 硬切,丢溢出行/divider/`terminalBody`/深链,无标记。                                                      | executed 步骤也 cap(折叠为「…N more」)并确保 terminalBody+深链始终在最后保留槽内;或分卡。                                  | [AGENT] |
| **B17** | 出站/A2UI 面无 i18n:`workflow-to-a2ui.ts` 19 处硬编码中英混排(`:136,144,151,155` `开始/完成/失败/跳过`;`:305-311` `Running/...`;`:79/87` `Approve/Cancel`;`:317` `Open run detail`;`:323/:395`),`a2ui-bridge/` 零 next-intl。`lint:i18n` 只扫 `.tsx` 故漏掉。已知 `activity-to-a2ui.ts` 有 locale bag 可参照。     | 给 a2ui-bridge 引 headless i18n(`lib/headless/i18n.ts:resolveMessage`)或参照 `ActivityI18n` 注入 locale bag,把 19 串外置。 | [AGENT] |

### 4D · 竞态(设计权衡,评估后择机)

| ID      | 问题 + 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 修法                                                                                                                                                                                        | 置信    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **B18** | 三处并发窗口:① requeue 重叠 —— `lifecycle.ts:40,71` `stop()` fire-and-forget 后立即 `restart()`,单会话平台(Discord identify/Lark long-conn)旧+新 socket 短暂共存可被拒/双丢;② reconcile-vs-requeue 双启动 —— reconcile 只与 reconcile 串行,requeue 中途任何并发 `adapterInstances` 写触发 liveQuery → 见 enabled∉running → 热增第二实例 → 两 socket 一泄漏 → 双发;③ HITL 挂起回合占 `queue.depth`(`bus.ts:641`),卡审批可 HOL 阻塞后 `turn_queue_overflow` drop(depth>10)。 | ① requeue 对单会话平台 await stop 完成再 restart;② reconcile 与 requeue 共享同一串行锁(把 requeue 也纳入 `reconcileRunning`);③ HITL 挂起回合可考虑不占常规 depth 或单独上限。逐项评估 ROI。 | [AGENT] |

### 4E · 平台媒体 / 事件覆盖

| ID      | 问题 + 证据                                                                                                                                                                                                                                                                                                               | 修法                                                                                                                                             | 置信    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| **B19** | Telegram/Discord 本地文件 multipart 上传缺失:`telegram/serialize.ts:115` 直传 `seg.url`(本地路径当字符串被 Bot API 拒),无 `uploadFile`;Discord 仅 voice 走真 multipart(`voice-upload.ts` + `discord_upload.rs`),image/file/video URL-only(`discord/serialize.ts:116`)。但 `*_CAPS` 声明了 `send.image/file/voice/video`。 | 加 Rust multipart 命令(仿 `connectors_discord_upload`)+ 适配器 `uploadFile`,本地文件走上传;或收窄能力声明并标注。                                | [AGENT] |
| **B20** | ① Discord webhook 模式 `presence.status` 永久失败(`index.ts:692` gateway null 抛错,runner 无限重试),能力标志按 transport 漂移;② WeCom media-after-stream 未验证(`wecom/index.ts:663` 自陈,若平台拒 post-stream 媒体帧则静默丢附件);③ Telegram welcome/system 事件缺失(`parse.ts:200`)。                                   | ① webhook 模式下不声明 presence.status(能力按 transportMode 派生);② 对 WeCom 做一次真机验证或降级为发送前媒体;③ 补 Telegram member/system 解析。 | [AGENT] |

### 4F · 管理 / 可访问性

| ID      | 问题 + 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 修法                                                                                                                                                                                                                                                                                | 置信    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **B21** | ① 无 clone/复制、无 bot 配置 export/import(仅运行时数据 audit/DLQ 导出);② 非 Tauri 删除跳过 keyring 清理(`adapter-list-row.tsx:105` isTauri-gated,Dexie 行仍删)→ 移动/web 残留密钥;③ `capability-matrix-tab.tsx` 只显 A2UI 组件层级,**不显任何通道 Capability**(edit/delete/reactions/chat.create/media);④ 移动原生列表无 health/status(`connector-policy-list.tsx:86`);⑤ `usage-presence.tsx:128` 非-badge 平台 mode 显示与存储漂移(显示 "card" 但不回写);⑥ `trigger`(TriggerPolicy)无编辑器;⑦ WeChat 三兄弟 / QQ+OneBot 共享同一 glyph 仅颜色区分(色盲不可辨,`platform-icons/index.tsx`)。 | 分拆:clone = 复制行(换 id + 清 credentialsRef,提示重填密钥);删除的 keyring 清理在非 Tauri 也应尽力(或提示);capability-matrix 增列展示通道 Capability(从 `getPlatformCapabilities` 派生);移动列表加 health 徽标;usage-presence 修正 mode 回写;图标加形状/字母区分。逐项独立 commit。 | [AGENT] |

---

## 4. 对既有 crosslink 计划的补充(不新立项,仅追加证据)

> 本次审计独立**再确认**了 crosslink 计划的两条,并各补一条证据/衍生缺陷。落地时并入 crosslink X1/X7,勿在此另开 commit。

- **给 X1(PII)追加两个出站 sink 的证据 → 佐证必须选「C 纵深」**:除 X1 已列的 `action.connector.send` 外,本次确认 `outbound-runner.ts:836 hasNoLeakingPiiDeep` **仅在插件 transform 分支**生效(`:834`),而 `workflow-progress-runner.ts`(工作流进度/终态卡广播到**所有**订阅会话,含跨适配器非源会话)与 `scheduled-outbound.ts:123 handleOutboundSend`(时区广播,`source:"manual"`)都经 raw `enqueueOutbound` **无扫描**。→ 只做 X1 的 A/B(入站门)不够,必须落 **C**:在 outbound-runner 主发送路径对原始 segments 无条件 `hasNoLeakingPiiDeep`,一处覆盖全部出站 sink。
- **给 X7(团队 model pin 失效)追加一手复核**:`imAdapterRow:` 全库**唯一**生产者是 `runtime.ts:615`(单角色路径);`startTeamRunFromIM`(`team-dispatch.ts`)不转发 adapterRow;teammate 模型来自 `teammate-character.ts:70 modelHint||teammate.config?.model||team.config?.defaultModel`。X7 结论成立。**衍生 → 本文 B1**:该失效在 `/status` 上被错误地展示为「已 pin」,B1 修 `/status` 真实性,与 X7 修实际生效互补,建议同波次落地。

---

## 5. 附:11 平台能力矩阵(调研交付物,[AGENT] 读码所得,动手前按需复核)

✅ 实现 · 🟡 部分 · 🩹 stub · ❌ 无

| 能力                               | tg          | discord         | slack     | lark         | onebot        | wecom    | wx-personal | wx-oa           | qq               | dingtalk   | matrix        |
| ---------------------------------- | ----------- | --------------- | --------- | ------------ | ------------- | -------- | ----------- | --------------- | ---------------- | ---------- | ------------- |
| 入站接收                           | ✅          | ✅              | ✅        | ✅           | ✅            | ✅       | ✅          | ✅              | ✅gw/🟡wh(UI死)  | ✅         | ✅            |
| 发文本                             | ✅          | ✅              | ✅        | ✅           | ✅            | ✅       | ✅(仅回复)  | ✅(48h窗)       | ✅(被动)         | ✅         | ✅            |
| 编辑                               | ✅          | ✅              | ✅        | ✅           | 🩹            | ❌       | ❌          | ❌              | ❌               | ❌         | ✅            |
| 删除                               | ✅          | ✅              | ✅        | ✅           | ✅            | ❌       | ❌          | ❌              | ❌               | ❌         | ✅            |
| 表情回应                           | ✅          | ✅              | ✅        | ✅           | ✅            | ❌       | ❌          | ❌              | ❌               | ❌         | ✅            |
| chat.create/members/update/contact | ❌          | ❌              | ❌        | ✅           | ❌            | ❌       | ❌          | ❌              | ❌               | ❌         | ❌            |
| 媒体上传(出)                       | 🟡URL only  | 🟡仅voice真上传 | ✅        | ✅           | ✅            | ✅(分片) | ❌          | ❌              | ❌               | ❌         | ✅顶层/❌E2EE |
| 媒体下载(入)                       | ✅          | ✅              | ✅        | ✅           | ✅            | ✅       | ✅          | 🟡              | 🟡               | 🟡         | ✅/❌E2EE     |
| welcome/系统事件                   | ❌(B20)     | 🟡              | ❌        | ✅           | ❌            | ✅       | ❌          | ❌              | ❌               | ❌         | 🟡            |
| 传输                               | wh+longpoll | gw+wh           | socket+wh | long-conn+wh | rev-ws+fwd-ws | gw(WS)   | longpoll    | wh              | gw+wh(死)        | gw(Stream) | longpoll      |
| 验签                               | ✅secret    | ✅Ed25519       | ✅HMAC    | ✅token+AES  | ✅bearer      | N/A      | N/A         | ✅token+sig+AES | ✅seeded-Ed25519 | N/A        | N/A           |

**已确认无「flag 声明真但方法缺失」的危险漂移** —— 每个声明的能力都有真实方法(OneBot 的 `edit`/`setTyping` 是诚实的未声明 no-op,是安全的反向)。Lark 是能力最全的参照实现。

---

## 6. 建议落地顺序

1. **W1(活性/正确性 P1)** —— B3(fan-out 解耦,与 X1 PII 门协同,一并做)、B1(`/status` 真实性)、B2(网关 liveness)。这三条影响每天的可用性。
2. **W3(用户可见 P1)** —— B7(纯翻译,零风险)、B6(桌面 mode picker,移动端已有可抄)。
3. **W2(定时炸弹 P1)** —— B5(QQ webhook,网关下线前必须)、B4(Matrix E2EE,先按 §W2.1 的 [OPEN] 决策做最小合规还是完整接线)。
4. **W4(P2)** —— 优先 4A 休眠清理(Rule 7 合规,多为几行删/接 + 标注),再按 ROI 取 4B/4C/4F。
5. **并入 crosslink** —— X1 落地时带上 §4 的 C 纵深证据;X7 与 B1 同波次。

> 每个 user-facing 改动记得 `pnpm changeset`(选 `cognia-next`)。门禁:`pnpm test:coverage:changed -- --strict`(≥90%)、`pnpm lint:i18n && pnpm i18n:sort:check`、`pnpm typecheck`。UI 改动走 `verify` skill 真跑一遍。
