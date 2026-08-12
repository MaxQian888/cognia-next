# Decision / Evidence / Lineage、Provenance 与冲突治理设计研究

> 研究日期：2026-08-11  
> 范围：统一决策契约、统一 provenance envelope、conflict-before-merge  
> 依据：Cognia 当前仓库实现、ADR、Semantica 固定提交 `6f310d1d7acf11013dc7e68d4e68823eb96cec4d`、W3C PROV-DM、OpenTelemetry 与 CloudEvents 规范  
> 本文是设计研究，不包含生产代码变更

## 0. 结论先行

三个议题应该作为同一个治理基础设施推进，但不能做成一个无边界的“大事件表”。推荐的领域边界是：

1. **Decision 是权威领域对象**：回答“谁基于什么证据和哪版策略，选择了什么，以及选择后来是否被执行”；
2. **Evidence 是最小披露的引用对象**：默认只存 source identity、digest、审查/污染状态和访问范围，不复制原始内容；
3. **Lineage 是显式关系**：区分 `used`、`generated`、`derived-from`、`supported-by`、`contradicts`、`supersedes`、`governed-by` 等关系，不能把时间相关性伪装成因果；
4. **ProvenanceEnvelope 是传输与投影边界**：承载身份、关联、时间、隐私和 integrity 元数据，并引用 Decision / Evidence / Lineage；它不是新的业务真相源；
5. **ConflictSet 是合并门禁**：只有经过主体、谓词、作用域、有效期归一化后仍互斥的 assertions 才进入冲突；冲突解决本身必须生成 Decision。

Cognia 已有约 60%–70% 的必要原语，但分散在 Workflow、Agent execution、tool permission、Connector、Memory、Twin、capture 和 observability 中。最小可行路径不是引入图数据库或 RDF，而是：

- 新增纯 TypeScript、跨运行时可序列化的核心契约；
- 用 deterministic idempotency key 建一个 append-only decision journal 与可重建 projection；
- 先接入 workflow branch / approval、tool authorization、memory conflict resolution；
- 再接 connector route/facts、Twin re-distill 和 content capture；
- 最后做只读 Context Inspector 和可选的关系投影。

## 1. 研究边界与术语

### 1.1 “决策”不是普通日志

本文只把会改变后续行为、授予权限、产生外部副作用或修改长期知识状态的选择定义为 Decision，例如：

- Workflow 选择某条 branch，导致其他路径被 skip；
- tool permission 被规则、自动模式或用户允许/拒绝；
- human approval / risk gate 被解决；
- Connector 将入站消息路由为 AI run、draft、store-only 或 drop；
- Memory 冲突被 keep、keep-both 或 merge；
- Twin 从历史资料中抽取到一条“某人过去做过的决定”。

普通 token、日志、span、无副作用的内部函数分支不应全部升级成 Decision，否则会造成写放大和无效噪声。

### 1.2 观察到的决策与系统控制决策必须区分

Twin 当前 `DecisionRecord` 是**从材料中观察到的历史决策**；Workflow/授权产生的是**Cognia 当下做出的控制决策**。两者可以共享 subject、evidence、actor、time 等核心字段，但生命周期不同：

| 类型       | 语义                                        | 典型状态                                      |
| ---------- | ------------------------------------------- | --------------------------------------------- |
| `observed` | 从 source/evidence 推断“过去发生过某个选择” | observed、disputed、superseded                |
| `control`  | Cognia 或用户现在选择下一步怎么做           | proposed、resolved、executed、failed、revoked |

如果不分开，系统可能把“资料声称用户曾允许 X”错误地当成“当前已授权 X”。这是安全边界，不只是命名问题。

### 1.3 Provenance、trace 与 audit 的职责不同

- **Trace**：一次执行经过哪些 operation、耗时和错误；
- **Audit**：某个受治理事件发生了，通常面向合规或运维；
- **Provenance**：某个产物或事实由哪些 entity、activity、agent、evidence 和 policy 产生；
- **Decision**：为什么选择该结果，以及谁拥有决定权；
- **Lineage**：以上对象之间的显式关系。

它们应该通过 IDs 关联，而不是合成一套超大 schema。

## 2. Cognia 当前能力盘点

### 2.1 Workflow：执行拓扑完整，决策语义不足

当前基础：

- [`types/workflow/visual.ts`](../../types/workflow/visual.ts) 的 `WorkflowRunLineage` 已有 `rootRunId`、`parentRunId`、`parentStepId`、`retryOfRunId` 和 `retryMode`；
- `WorkflowRunRow` 已有关联 trace、security context、deployment/version/dependency lock；
- `StepExecutionResult.decision` 能让 runtime 选择 branch；
- [`types/workflow/waitpoint.ts`](../../types/workflow/waitpoint.ts) 的 waitpoint 是 durable、first-writer-wins 的审批/风险门禁；
- [`lib/workflow/runtime/event-log.ts`](../../lib/workflow/runtime/event-log.ts) 提供 append-only、单 run 单调 sequence 的 event log。

主要缺口：

- branch choice 只作为 step result 的一个字段被消费，未形成可独立查询的 durable decision；
- 未选 edge 被 skip，但“为什么选 A 而不是 B”没有 policy/evidence/rationale；
- waitpoint resolution 有 outcome、respondedBy 和 resolvedAt，但没有 proposer、policy snapshot、evidence、request digest 和 override 关系；
- workflow event payload 为 `unknown`，不同 producer 容易产生 schema 漂移。

### 2.2 Agent execution 与 tool permission：已有局部 decision trace，但大多易失

[`packages/agent-config-types/src/agent-execution.ts`](../../packages/agent-config-types/src/agent-execution.ts) 已定义 `AgentExecutionDecisionTrace`，记录 surface、feature flags、legacy input、resolved runtime/route/model/fallback 和 divergence；[`lib/ai/agent/execution/resolve-agent-execution-spec.ts`](../../lib/ai/agent/execution/resolve-agent-execution-spec.ts) 会生成它。

这是很好的专用 producer，但它被明确设计为 volatile，当前执行服务主要只传播 `traceId`。它不能直接承担全局 DecisionRecord，因为：

- 它描述 runtime resolver，不覆盖 tool approval、workflow、Memory 或 Twin；
- trace ID 使用进程内 counter，不适合作为跨重试、跨设备幂等身份；
- 没有 durable actor/evidence/policy ref；
- 没有 proposal → resolution → execution lifecycle。

tool permission 当前存在多条允许/拒绝路径：confinement、ruleset、always-allow、accept-edits、read-only、auto-mode rule/model、plugin hook、remote approval、用户 modal。自动 allow/deny 有些只在 sidecar 内完成，没有统一 durable record；因此最终结果相同的两次授权，可能无法解释分别是哪条策略生效。

### 2.3 Connector：路由决策清晰，记录仍以通用 audit 为主

- [`lib/connectors/policy-eval.ts`](../../lib/connectors/policy-eval.ts) 返回 matched/blocked/reason；
- [`lib/connectors/mode-router.ts`](../../lib/connectors/mode-router.ts) 将结果路由为 `ai-run`、`manual-store`、`draft-prepare`、`store-only` 或 `drop`；
- [`types/connectors/audit.ts`](../../types/connectors/audit.ts) 有大量 decision-like audit kind；
- [`lib/connectors/runtime.ts`](../../lib/connectors/runtime.ts) 已为 AI run 的 permission request/resolution 写 canonical agent envelope。

缺口是 route choice、matched rule、binding/policy version、override actor 和产生的 execution/draft/outbound artifact 没有共同决策身份。通用 `fields` 能记录信息，却不能保证每条 action 都具备可查询的 why-chain。

### 2.4 Memory：冲突治理最成熟，但 resolution 还不是完整 Decision

当前实现已经具备：

- [`packages/memory/src/types/governance.ts`](../../packages/memory/src/types/governance.ts) 的 `MemoryEvidence` 使用 source ID、redacted excerpt hash、contamination 和 reviewed，不复制原文；
- [`packages/memory/src/consolidate/consolidator.ts`](../../packages/memory/src/consolidate/consolidator.ts) 支持 ADD / UPDATE / DELETE / CONFLICT / NOOP；
- 冲突双方通过 `conflictWithIds` 保留，并被 recall 路径排除；
- [`lib/memory/control-plane/manage.ts`](../../lib/memory/control-plane/manage.ts) 支持 keep、keep-both、merge，保留 soft invalidation、supersession、PII gate、evidence 和 audit。

仍有四个关键缺口：

1. LLM consolidation 的选择没有 durable judge decision、模型/提示/策略版本和 evidence set；
2. `resolve-conflict` 没有 command/idempotency ID、resolver actor、理由和 policy ref；
3. merge 创建的 manual evidence 没有把原冲突证据、resolution decision 和新版本连成完整 lineage；
4. 多表更新与 vector side effect 不是同一个跨边界事务，需通过 canonical write + outbox/idempotent projection 明确故障语义。

### 2.5 Twin：已有历史 Decision，但存在 silent replacement 与未显式冲突

[`types/twin/index.ts`](../../types/twin/index.ts) 的 `DecisionRecord` 有 context、choice、rationale、sourceChunkIds 和 timestamp；[`lib/twin/distill/agents/knowledge-agent.ts`](../../lib/twin/distill/agents/knowledge-agent.ts) 从 redacted chunks 中抽取，并校验 source IDs。

但 [`lib/db/twin-profile.ts`](../../lib/db/twin-profile.ts) 的 upsert key 是 normalized `context + choice`：

- 同 context、不同 choice 会并存，却没有被标成潜在冲突；
- 同 context、同 choice 会替换旧记录，可能丢失旧 rationale/evidence，除非旧项 pinned；
- 没有 extraction job/model/policy version、observed time、valid time、confidence origin 和 review status；
- `DecisionRecord` 名称容易与系统控制决策混淆。

### 2.6 Content capture：保留 source，但只做 exact dedup

[`types/capture/index.ts`](../../types/capture/index.ts) 的 `CapturedItem` 保存 raw text/source URL、source app、capturedAt、enrichment 和 fingerprint；[`lib/capture/capture-manager.ts`](../../lib/capture/capture-manager.ts) 在 enrichment 前用 fingerprint exact-dedup，重复时直接返回 `null`。

这对原始 capture blob 去重是合理的，但它不是事实层 conflict detection。建议保持 raw capture immutable，把后续抽取出的 claims 建成独立 assertions，并以 CapturedItem 作为 EvidenceRef；不要在 capture row 上直接 merge 语义事实。

### 2.7 现有 envelope 不能直接充当 provenance 真相源

- [`packages/logging/src/observability-event.ts`](../../packages/logging/src/observability-event.ts) 的 `ObservabilityEventV1` 已有 scope、correlation、privacy、delivery 和 trace context；它适合遥测，可能被采样、裁剪或按日志 retention 删除；
- `AgentEventEnvelope` 提供 at-least-once eventId/sequence 和 canonical recovery stream，但只覆盖 agent run；
- Workflow event log 是 per-run recovery/audit stream；
- Connector audit 是子系统审计记录。

正确方向是共享一个小型 envelope header 和引用规范，并由 provenance producer 投影到 observability；不能把 observability spool 反过来设为决策权威表。

## 3. P0：统一 Decision / Evidence / Lineage 契约

### 3.1 推荐的聚合边界

不要设计单个 `DecisionEvidenceLineageRow`。建议最少分为五个对象：

```ts
type ResourceRefV1 = {
  namespace: string
  type: string
  id: string
  version?: string
  scope?: { tenantId?: string; workspaceId?: string; projectId?: string }
}

type PolicyRefV1 = {
  namespace: string
  id: string
  version?: string
  digest: string
  snapshotRef?: ResourceRefV1
}

type EvidenceRefV1 = {
  schemaVersion: 1
  id: string
  kind:
    | "message"
    | "file"
    | "capture"
    | "connector"
    | "memory"
    | "twin-chunk"
    | "tool-result"
    | "approval"
    | "policy-evaluation"
    | "manual"
  sourceRef: ResourceRefV1
  digest: { algorithm: "sha256"; value: string; canonicalization: string }
  excerpt?: { redacted: string; digest: string }
  observedAt: string
  validTime?: { from?: string; to?: string }
  review: { status: "unreviewed" | "verified" | "disputed"; reviewedBy?: ResourceRefV1 }
  contamination: "clean" | "external-context" | "unknown"
  privacy: { classification: string; retentionClass: string; contentCaptured: boolean }
}

type DecisionCaseV1 = {
  schemaVersion: 1
  id: string
  mode: "control" | "observed"
  kind:
    | "workflow-branch"
    | "tool-authorization"
    | "human-approval"
    | "connector-route"
    | "connector-action"
    | "memory-resolution"
    | "twin-observation"
    | "fact-resolution"
    | "execution-route"
  subjectRef: ResourceRefV1
  question: { code: string; candidateRefs?: ResourceRefV1[] }
  proposer?: ActorRefV1
  decider?: ActorRefV1
  executor?: ActorRefV1
  basis: {
    evidenceRefs: string[]
    policyRefs: PolicyRefV1[]
    parentDecisionRefs: string[]
  }
  resolution?: {
    outcome: string
    selectedRefs?: ResourceRefV1[]
    reasonCode: string
    rationale?: string
    rationaleOrigin: "human" | "rule" | "model-summary" | "system"
    confidence?: { value: number; meaning: "extraction" | "classification"; source: string }
  }
  lifecycle: {
    state:
      | "observed"
      | "proposed"
      | "resolved"
      | "executed"
      | "failed"
      | "revoked"
      | "disputed"
      | "superseded"
    proposedAt?: string
    decidedAt?: string
    effectiveAt?: string
    executedAt?: string
    recordedAt: string
    expiresAt?: string
  }
  correlation: CorrelationRefV1
  privacy: PrivacyManifestV1
}

type LineageEdgeV1 = {
  schemaVersion: 1
  id: string
  from: ResourceRefV1
  to: ResourceRefV1
  relation:
    | "used"
    | "generated"
    | "derived-from"
    | "supported-by"
    | "contradicts"
    | "supersedes"
    | "caused-by"
    | "approved-by"
    | "governed-by"
    | "resulted-in"
    | "related-to"
  assertion: "explicit" | "derived" | "inferred"
  evidenceRefs?: string[]
  actorRef?: ActorRefV1
  policyRef?: PolicyRefV1
  recordedAt: string
  validTime?: { from?: string; to?: string }
}
```

这里的代码只是设计草图。最终 contract 应放在无浏览器/Node/Tauri 依赖的纯 TS package 中，并配 JSON Schema、runtime validator 和跨 rail fixtures。

### 3.2 Decision 不应是可随意覆盖的一行

推荐使用：

- `DecisionCase`：稳定聚合身份和当前只读 projection；
- `DecisionEvent`：append-only 状态转换，如 proposed/resolved/executed/revoked；
- `DecisionLink`：到 evidence、policy、artifact、parent decision 的引用。

这样能解决 approval 竞态、crash recovery 和 override：同一个 request 的 first-writer-wins resolution 不会因重放产生第二条决策；用户 override 自动规则时，新增事件和 `supersedes` edge，而不是改掉历史。

### 3.3 三类 actor 必须拆开

“AI 提议，用户批准，Connector 执行”包含三个责任主体：

- `proposer`：提出候选行动；
- `decider`：拥有选择权的人/规则/系统；
- `executor`：实际产生 side effect 的 agent、plugin、workflow 或 connector adapter。

只存一个 `actor` 会让“AI 为什么自己批准了自己的动作”之类的审计问题无法回答。

### 3.4 rationale 不是 chain-of-thought

允许保存：

- human-entered justification；
- rule ID、matched clause 和 reason code；
- 模型输出的简短、安全解释；
- evidence/policy references。

禁止默认保存：

- raw chain-of-thought / thinking stream；
- 完整 tool input、secret、header、credential 或未脱敏 connector content；
- 仅凭时间顺序生成的伪因果解释。

### 3.5 Confidence 必须有类型

控制决策如“用户点击允许”通常不需要 confidence；抽取型 observed decision 才可能需要。字段必须表达它是 extraction/classification confidence，不能被 UI 当成事实真值或安全风险概率。

## 4. P0：统一 ProvenanceEnvelope

### 4.1 推荐职责

`ProvenanceEnvelopeV1` 是跨 producer 的轻量 transport/projection contract：

```ts
interface ProvenanceEnvelopeV1 {
  schemaVersion: 1
  eventId: string
  eventType: string
  source: string
  subjectRef: ResourceRefV1
  occurredAt: string
  recordedAt: string
  correlation: {
    traceId?: string
    spanId?: string
    sessionId?: string
    requestId?: string
    runId?: string
    workflowId?: string
    stepId?: string
    turnId?: string
    attemptId?: string
  }
  actorRefs: ResourceRefV1[]
  activityRef?: ResourceRefV1
  decisionRefs: string[]
  evidenceRefs: string[]
  inputRefs: ResourceRefV1[]
  outputRefs: ResourceRefV1[]
  policyRefs: PolicyRefV1[]
  privacy: {
    classification: string
    redactionVersion: string
    contentCaptured: boolean
    removedFields: string[]
    retentionClass: string
  }
  integrity?: {
    canonicalization: string
    digest: string
    partition?: string
    previousDigest?: string
  }
  data?: Record<string, string | number | boolean | null>
}
```

核心限制：`data` 只允许小型、已校验的语义字段；大内容通过 refs 访问，以便差异化 ACL、删除和 selective disclosure。CloudEvents 同样建议事件保持紧凑并链接大对象，其 `source + id` 唯一性也适合 Cognia 的 at-least-once producer 去重。

### 4.2 时间必须至少分三种

| 时间                        | 回答的问题               | 示例                |
| --------------------------- | ------------------------ | ------------------- |
| `occurredAt` / `decidedAt`  | 行为什么时候发生         | 用户 10:03 批准     |
| `recordedAt`                | 本地 ledger 什么时候收到 | 离线设备 10:08 同步 |
| `validTime` / `effectiveAt` | 事实或策略什么时候有效   | 8 月起改用 pnpm     |

没有 valid time，系统会把版本演化误判为冲突；没有 recorded time，则无法解释延迟同步和 replay。

### 4.3 Policy 必须可冻结

当前很多策略来自 mutable settings、rules、binding 或 mode。只保存 `policyId` 不够，至少要保存：

- namespace/id；
- version（如果已有）；
- canonical digest（必须有）；
- 可选 snapshotRef；
- effective time。

这使“为什么昨天允许、今天拒绝”可以回答为策略版本变化，而不是归因于随机模型行为。

### 4.4 Trace 是引用，不是权威来源

OpenTelemetry trace 擅长表达 span hierarchy、时间、status 和跨进程 correlation；Cognia 已有相应基础。但 telemetry 可能采样、截断、关闭 content capture 或按 retention 删除，因此：

- provenance envelope 引用 trace/span；
- observability 可从 decision/provenance 投影摘要；
- Inspector 在 trace 缺失时仍能从 decision ledger 回答核心 why；
- 不把 domain decision 只存成 span attribute/event。

### 4.5 Integrity chain 放在 P1，且按分区实现

Semantica 使用 sequence + previous checksum。Cognia 可借鉴，但不应在 P0 建单一全局链：

- 全局链会引入写锁、跨设备排序和恢复复杂度；
- hash chain 只能发现篡改，不能阻止有权限的 writer 重算整条链；
- “不可变审计”与用户删除权存在张力。

如果企业审计需求成立，应按 workspace/audit bundle 分区，使用 canonical serialization，删除时保留不含内容的 tombstone；高敏内容可以用独立密钥加密并通过 crypto-erasure 删除。

## 5. P0–P1：冲突先于合并

### 5.1 推荐流水线

```text
source ingest
  → normalize identity / predicate / scope / time
  → validate PII, trust boundary and schema
  → exact duplicate check
  → retrieve comparable assertions
  → conflict detection
      → no conflict: dedup / enrich / append
      → conflict: create ConflictSet, quarantine actionability
  → resolution decision
  → materialized active projection
```

重点是 exact duplicate 可以先处理，但 semantic merge 必须在 conflict detection 之后。

### 5.2 ConflictSet 最小契约

```ts
interface ConflictSetV1 {
  schemaVersion: 1
  id: string
  subjectRef: ResourceRefV1
  predicate: { namespace: string; key: string }
  scope: { workspaceId?: string; projectId?: string; characterId?: string }
  members: Array<{
    assertionRef: ResourceRefV1
    valueDigest: string
    evidenceRefs: string[]
    validTime?: { from?: string; to?: string }
    observedAt: string
    authorityClass:
      | "explicit-user"
      | "trusted-system"
      | "local-derived"
      | "connector-derived"
      | "external-untrusted"
  }>
  detection: {
    kind:
      | "mutually-exclusive"
      | "temporal-overlap"
      | "identity-ambiguous"
      | "policy-violation"
      | "semantic-contradiction"
    detectorRef: ResourceRefV1
    policyRef: PolicyRefV1
    confidence?: number
  }
  risk: "low" | "medium" | "high" | "critical"
  status: "open" | "resolved" | "dismissed" | "superseded"
  resolutionDecisionRef?: string
  createdAt: string
  resolvedAt?: string
}
```

### 5.3 不同值不一定冲突

满足以下条件后才比较冲突：

1. 同一 normalized subject；
2. 同一 predicate/field；
3. 作用域相同或存在覆盖关系；
4. valid-time 区间重叠；
5. 值在该 predicate 的约束下互斥。

示例：

- “2026-01 使用 npm”与“2026-08 起使用 pnpm”是 revision/supersession；
- “项目 A 用 pnpm”与“项目 B 用 npm”是不同 scope；
- “喜欢简洁回答”与“法律报告需要详细引用”可能是条件规则，不是冲突；
- 同一项目、同一时期，“只用 npm”与“只用 pnpm”才是明确冲突。

### 5.4 自动 resolution policy

| 场景                                            | 默认动作                            | 理由                         |
| ----------------------------------------------- | ----------------------------------- | ---------------------------- |
| exact duplicate，同 digest                      | dedup，合并 evidence refs           | 不丢来源，不需要人工复核     |
| explicit user 新声明覆盖旧声明，valid time 清楚 | 自动 supersede                      | authority 与时间都明确       |
| 同权威域、低风险、明确版本号更高                | 自动 supersede                      | 可解释且可回滚               |
| connector-derived 与 explicit user 冲突         | 保留 user，隔离 connector assertion | 防止外部内容改写用户长期偏好 |
| 多个第三方来源互相冲突                          | open conflict                       | 数量不代表真实性             |
| 身份、权限、政策、程序性记忆                    | 人工复核                            | 外部影响与安全风险高         |
| 模型只给出模糊 confidence                       | open conflict                       | 未校准概率不能直接授权 merge |

不要采用默认 majority voting；它会让重复转载或来源偏见看起来像“共识”。

### 5.5 Memory 扩展

保留当前“不让 unresolved conflict 进入 recall”的安全默认，同时补充：

- consolidation 每次 ADD/UPDATE/DELETE/CONFLICT/NOOP 都写 judge Decision；
- ConflictSet 引用两侧 MemoryEvidence，不只引用 memory IDs；
- resolution command 需要 deterministic ID、resolver actor、rationale、policy version；
- keep-both 需要填写 scope/condition 或 resolution note，否则“验证两个互斥值”会留下语义债务；
- merge 生成新 revision，并建立 `derived-from`、`supersedes`、`resulted-in` edges；
- canonical rows 先事务提交，vector update 用 outbox/idempotent reconciliation。

### 5.6 Twin 扩展

Twin 的历史 Decision 应投影为 `mode: observed`：

- source chunks → EvidenceRefs；
- distill job、model binding、prompt/policy digest → activity/policy refs；
- 同 context 的互斥 choice 先进入 ConflictSet，不直接作为两个 equally-active decisions；
- 同 context+choice 的重复抽取合并 evidence refs，不覆盖旧 evidence；
- pinned/manual edit 形成新的 Decision/Revision，不抹掉 distill 产物；
- unresolved 高风险项不注入 runtime system prompt；低风险项可以带 disputed 标记展示，但不能假装已验证。

### 5.7 Content capture 扩展

- CapturedItem 继续作为 immutable source；
- fingerprint exact-dedup 只处理 source blob；
- URL reader/OCR enrichment 作为 derived artifact，记录 activity、版本和 content digest；
- 从 capture 提取的事实写成 assertions，并在进入 Memory/Twin 前跑 conflict gate；
- source URL、app、文件名等 metadata 也可能是敏感信息，不能默认进入可导出的 envelope data。

### 5.8 Connector facts 扩展

这里的 “connector facts” 应指从入站内容派生并准备进入 Memory、Twin 或 project knowledge 的 assertions，而不是每条原始消息。建议：

- 原始 inbound event 保持 connector 的 canonical source；
- binding/policy evaluation 与 route 分别产生 Decision；
- fact extraction 带 `provenance: inbound`、connector evidence 和 contamination state；
- procedural/global memory 的现有门禁继续 fail closed；
- 与 local explicit evidence 冲突时不 silent merge，也不让 connector 数量取得多数优势；
- outbound side effect 必须能反查 route decision、authorization decision 和 execution outcome。

## 6. “为什么做出这次行动”的标准查询

以 connector auto-reply 为例，Inspector 应能沿以下显式链回答：

```text
Outbound message
  ← generated by Connector activity
  ← resulted from connector-action Decision
  ← approved by tool-authorization / human-approval Decision
  ← proposed by Agent run
  ← used inbound message + Memory/Twin EvidenceRefs
  ← governed by binding policy + permission policy versions
  ↔ correlated with trace/run/session/request IDs
```

回答应包含：

- 最终行动与执行结果；
- proposer / decider / executor；
- human override 或 auto rule；
- evidence 和污染/审查状态；
- policy ID、version/digest；
- 明确 causal parent；
- retries、失败和 supersession；
- 已删除或无权限 evidence 的 tombstone，而不是泄露内容。

## 7. 存储、幂等与一致性建议

### 7.1 权威源与投影

| 数据                        | 权威源                            | 可重建投影                               |
| --------------------------- | --------------------------------- | ---------------------------------------- |
| workflow step/run/waitpoint | 现有 workflow tables              | decision/lineage index                   |
| tool request/result         | canonical agent/permission stream | authorization decisions                  |
| connector message/action    | connector source/audit/run tables | connector why-chain                      |
| memory row/evidence         | Memory tables                     | assertion/conflict/lineage view          |
| Twin chunks/profile         | Twin tables                       | observed decision/assertion view         |
| decision lifecycle          | 新 decision journal               | current decision cases / Inspector graph |
| telemetry                   | observability spool               | 非权威诊断 view                          |

Decision journal 是新领域对象的权威源；relation graph 必须是可重建 projection，不应成为第二份业务事实数据库。

### 7.2 Idempotency key

建议按 producer 使用稳定键：

- workflow branch：`workflow:<runId>:<stepId>:<attempt>:route`；
- waitpoint：`waitpoint:<waitpointId>:resolution`；
- tool permission：`tool:<sessionId>:<requestId>:authorization`；
- connector route：`connector:<adapterId>:<inboundEventId>:route`；
- memory conflict：`memory:<conflictSetId>:<resolutionCommandId>`；
- Twin observation：`twin:<jobId>:<normalizedSubject>:<predicate>:<valueDigest>`；
- capture claim：`capture:<captureId>:<extractorVersion>:<claimDigest>`。

所有跨进程传递都按 at-least-once 设计，consumer 以 producer namespace + eventId 去重。不要声称跨 Dexie、sidecar、Rust 和外部 connector 能实现真正 exactly-once。

### 7.3 失败语义

- 决策已记录、执行未发生：state 为 resolved，缺 executed event；可安全重试；
- 执行成功、projection 未写：source event/outbox 重放；
- approval 重复响应：first-writer-wins，后续写 `decision-resolution-rejected` audit，不修改结果；
- evidence 已删除：保留 content-free tombstone 与 digest，不显示缓存 excerpt；
- policy snapshot 缺失：decision 仍可读，但标记 explainability incomplete，不能伪造当前 policy 作为历史 policy。

## 8. 分阶段落地方案

### Phase 0A — 契约与 ledger（P0）

1. 建纯 TS contracts：ResourceRef、ActorRef、PolicyRef、EvidenceRef、DecisionCase/Event、LineageEdge、ProvenanceEnvelope；
2. 提供 JSON Schema/runtime validator 和 canonical serialization；
3. 建 append-only decision event sink、idempotent append、current projection；
4. 定义 privacy manifest、retention 与 tombstone 规则；
5. 给现有 observability/canonical agent/workflow events 做单向 adapter。

验收：相同 producer event 重放 100 次只形成一个语义决策；schema 在 browser、sidecar fixture、Rust wire adapter 间一致。

### Phase 0B — 高价值 producers（P0）

接入顺序：

1. workflow branch；
2. workflow approval/risk gate；
3. tool authorization 的所有自动/人工路径；
4. memory conflict resolution；
5. agent execution resolver trace adapter。

先采用 shadow write：旧表保持权威，比较旧行为与新 projection，不改变执行结果。

验收：任取一条 workflow + tool approval 链，可以从最终 step/artifact 找到 evidence、policy、decider 和 execution outcome，且未保存 raw chain-of-thought/tool secrets。

### Phase 1A — ConflictSet 与知识入口（P0–P1）

1. 把 Memory conflict 适配为共享 ConflictSet；
2. 为 Twin observed decisions 增加 conflict-before-upsert；
3. 为 capture enrichment 的 claims 增加 evidence/claim 分层；
4. connector-derived facts 进入 Memory/Twin 前统一过 conflict gate；
5. resolution 全部生成 Decision 与 lineage。

验收：构造时间、scope、authority 不同的 fixtures，版本演化不误报；真正矛盾不被 silent merge；unresolved 高风险事实不能影响 prompt 或外部 action。

### Phase 1B — Context Inspector 与薄关系投影（P1）

1. 从 message、tool call、workflow run、memory、Twin/capture、connector action 打开同一个 Why Inspector；
2. projection 只保存 refs/edges，可从源表重建；
3. causal edge 必须由 producer 显式声明；推断关系显示为 inferred；
4. 提供 revoke、supersede、resolve、查看 policy snapshot 的入口。

### 条件式 Phase 2

- 有企业合规需求后再做 partitioned hash chain 和 signed export；
- 有跨系统交换需求后再做 W3C PROV/JSON-LD adapter；
- 有真实复杂关系查询后再评估 SQLite adjacency/recursive CTE 或专用 graph store；
- 不提前引入 RDF/OWL/SHACL/Datalog 到内部核心模型。

## 9. 测试与验收矩阵

| 层级          | 必测内容                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------ |
| contract      | schema validation、forward-compatible enum、RFC 3339 time、canonical digest                |
| producer      | 每条自动 allow/deny、manual approval、workflow branch、connector route 都生成完整 Decision |
| replay        | duplicate、out-of-order、crash-after-source-write、projection rebuild                      |
| privacy       | 无 raw CoT、credential、header、未脱敏 content；metadata 也受 ACL/retention                |
| temporal      | valid time、recorded time、revision vs conflict、expired policy                            |
| conflict      | scope isolation、authority policy、keep/keep-both/merge、unresolved quarantine             |
| security      | project/workspace isolation、connector untrusted contamination、deleted evidence tombstone |
| cross-runtime | browser/sidecar/Rust/companion fixture parity                                              |
| E2E           | artifact → decision → approval → evidence → policy → run 的真实 Why path                   |

建议新增质量指标：

- 外部 side effect 中带 `decisionRef` 的覆盖率；
- explainability incomplete 的 decision 比例；
- silent merge 防护命中数；
- open conflicts 的风险分布与处理时长；
- replay duplicate suppression 与 projection rebuild parity；
- privacy contract violations（必须为 0）。

## 10. 明确不做

- 不记录完整 chain-of-thought；
- 不把所有日志或普通分支都升级成 Decision；
- 不用当前 policy 冒充历史 policy；
- 不通过共享实体 + 时间先后自动断言 `caused-by`；
- 不让 graph projection 成为第二个权威真相源；
- 不用多数投票自动解决高风险冲突；
- 不直接集成 Semantica 0.6.0 运行时；
- 不在 P0 建全局 hash chain、RDF store 或完整 ontology。

## 11. 需要在实现前拍板的五个产品决策

1. 哪些 action 被定义为“必须可解释的外部影响”，必须先有 decisionRef？
2. Decision/evidence 的默认本地 retention 与用户 hard-delete 语义是什么？
3. unresolved Twin/capture facts 是完全隔离，还是允许以 disputed context 注入低风险回答？
4. 哪些 policy 需要正式 version，哪些允许 digest-only snapshot？
5. Context Inspector 首期从 workflow、tool authorization、connector 还是 Memory 场景切入？

技术建议是：前三个 producer 选择 workflow branch、tool authorization、memory conflict resolution；它们分别覆盖自动决策、安全授权和知识冲突，能最快验证统一契约是否真正跨域。

## 12. 参考资料

### 外部一手资料

- [W3C PROV-DM](https://www.w3.org/TR/prov-dm/)：entity、activity、agent、usage、generation、derivation、attribution 与 bundle 的概念基础；本文只借鉴概念，不要求 RDF/OWL 实现。
- [OpenTelemetry Traces](https://opentelemetry.io/docs/concepts/signals/traces/)：trace/span hierarchy、links、events 与 context propagation；用于说明 telemetry 与 domain provenance 的职责边界。
- [CloudEvents specification](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md)：source + id 去重、事件 metadata/payload 分离、RFC 3339 time、紧凑事件和敏感信息边界。
- [Semantica decision models](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/semantica/context/decision_models.py#L86-L215)
- [Semantica provenance manager](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/semantica/provenance/manager.py#L59-L187)
- [Semantica conflict resolver](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/semantica/conflicts/conflict_resolver.py#L75-L259)

### Cognia 相关设计

- [Semantica 可借鉴思路与 Cognia 适配建议](./semantica-borrowable-ideas-2026-08-11.md)
- [ADR-0069 Long-term Memory external API surfaces](../content/docs/en/adr/0069-long-term-memory-external-api-surfaces.md)
- [ADR-0090 Unified Agent Execution](../content/docs/en/adr/0090-unified-agent-execution-and-gateway-compatibility.md)
- [ADR-0102 Unified Observability](../content/docs/en/adr/0102-unified-observability-crash-diagnostics.md)
