# Semantica 可借鉴思路与 Cognia 适配建议

> 研究日期：2026-08-11<br>
> 外部基线：`semantica-agi/semantica` 主分支提交 [`6f310d1`](https://github.com/semantica-agi/semantica/commit/6f310d1d7acf11013dc7e68d4e68823eb96cec4d)，版本 `0.6.0`<br>
> 证据原则：Semantica 判断只引用其仓库源码、README、Release 和 GitHub Issues；Cognia 判断以当前仓库实现与 ADR 为准
> 标记规则：未特别标明的 Semantica 描述是源码事实；“建议”“推断”均为本文对 Cognia 的适配判断

## 0. 结论先行

Semantica 值得借鉴，但**不建议现在把它作为 Cognia 的运行时依赖，也不建议照搬完整 Knowledge Graph / RDF / reasoning stack**。

最值得迁移的是五个产品与领域建模思路：

1. 把 Agent 的关键“决策”建模为一等领域对象，而不是埋在 message、tool log 或 workflow event 中；
2. 用统一 provenance envelope 串起证据、活动、执行者、策略版本和派生产物；
3. 在 merge / dedup 前显式保留冲突，并提供自动策略与人工复核两条路径；
4. 在现有向量检索旁增加一层**薄的、可重建的关系投影**，用于解释和追踪，不替换现有存储；
5. 把 provenance、conflict、decision 做成用户能操作的 Inspector，而不是只有后台 API。

Cognia 已经具备大部分底层原语：

- Twin 已有带来源 chunk 的 `DecisionRecord`；
- Memory 已有 evidence、audit、conflict、soft invalidation、污染状态和治理门禁；
- Workflow 已有 root / parent / retry lineage 与 trace ID；
- 已有 sqlite-vec、多后端 `IVectorStore`、MCP External Bridge、插件 registry 和可视化 workflow；
- 已有跨运行时 observability 与 PII gate 设计。

所以真正的缺口不是“再造一个 Semantica”，而是把这些分散能力收敛成一个跨 Agent / Workflow / Twin / Memory 的 **Decision + Evidence + Lineage contract**。

## 1. 横向判断

| Semantica 思路                  | Cognia 当前基础                                           | 真正缺口                                                   | 建议优先级 |
| ------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- | ---------- |
| Decision 是一等对象             | Twin `DecisionRecord`、workflow run、approval / risk 事件 | 决策只在各自子系统内存在，缺统一身份、证据、策略和结果模型 | P0         |
| 统一 provenance 与 hash chain   | Memory evidence/audit、workflow lineage、Observability V1 | 缺可跨域导航的 lineage envelope；审计记录形状不统一        | P0         |
| 冲突先于 merge                  | Memory 已保留 `CONFLICT`，冲突项不进入 recall             | Twin / capture / connector 等知识入口未共享同一冲突协议    | P0–P1      |
| Context Graph + vector hybrid   | sqlite-vec、Twin/Memory RAG、多类结构化记录               | 缺跨对象关系投影与显式 causal edge                         | P1         |
| Precedent search                | 现有 embedding / hybrid retrieval                         | 缺决策专用索引、结构化过滤和误匹配评估                     | P1         |
| Explorer / governance workbench | Memory、Twin、Workflow、Logs 各有管理 UI                  | 缺“一次行动为什么发生”的统一 Inspector                     | P1         |
| RDF / OWL / SHACL / Datalog     | 无直接业务刚需；已有插件与 workflow policy                | 需求、成本和维护责任均未成立                               | 暂不做     |

## 2. 借鉴一：把关键决策从日志提升为领域对象

### 2.1 Semantica 的做法

Semantica 的 `Decision` 固化了 `category`、`scenario`、`reasoning`、`outcome`、`confidence`、`timestamp`、`decision_maker`、有效期、embedding 和 metadata；`DecisionContext` 保存实体快照、风险因素和跨系统输入；Policy 另有版本字段。见 [decision_models.py](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/semantica/context/decision_models.py#L86-L215)。

记录过程不是只写一条 log：`DecisionRecorder` 把决策写入图、链接相关实体、记录来源文档，并把实际应用的 policy version 固化在关系上；政策例外也作为对象保留 approver、时间和 justification。见 [decision_recorder.py](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/semantica/context/decision_recorder.py#L100-L310)。

### 2.2 Cognia 已经有什么

- [`types/twin/index.ts`](../../types/twin/index.ts) 的 `DecisionRecord` 已有 `context`、`choice`、`rationale`、`sourceChunkIds` 和 timestamp；
- [`lib/twin/distill/agents/knowledge-agent.ts`](../../lib/twin/distill/agents/knowledge-agent.ts) 会校验 source chunk 并生成稳定 decision ID；
- [`types/workflow/visual.ts`](../../types/workflow/visual.ts) 的 `WorkflowRunLineage` 已保存 root、parent、step 和 retry 关系；
- Memory、remote control、MCP 和 workflow 各自已有 audit event。

但 Twin decision 目前更像“从资料中抽取的人物决策记忆”，不是“Cognia 自己做过什么关键选择”的全局记录；workflow lineage 则描述执行拓扑，不表达为什么选了某个分支、应用了哪个 policy、谁批准了例外。

### 2.3 建议的最小落点

新增统一契约时，先覆盖高价值边界，不要记录每一个 token 或普通 tool call：

```ts
interface AgentDecisionRecordV1 {
  id: string
  kind:
    | "workflow-branch"
    | "tool-authorization"
    | "human-approval"
    | "connector-action"
    | "memory-resolution"
  actor: { kind: "user" | "agent" | "system"; id: string }
  subjectRefs: string[]
  evidenceRefs: string[]
  policyRef?: { id: string; version: string }
  choice: string
  rationale?: string
  confidence?: number
  outcome: "proposed" | "approved" | "executed" | "rejected" | "failed" | "superseded"
  causalParentIds: string[]
  traceId?: string
  runId?: string
  decidedAt: number
}
```

建议首先接入四个 producer：risk ceremony、tool permission / approval、workflow 条件分支、connector auto-reply。Twin 中抽取的历史 decision 可以通过 adapter 投影到同一读取模型，但不必迁移原表。

### 2.4 前置条件与权衡

- `reasoning` 不应默认存原始 chain-of-thought；只存面向用户的 rationale、输入引用和机器可读规则结果；
- `confidence` 必须说明来源，模型自报概率不能冒充校准后风险概率；
- schema、producer 和 UI 需要 contract tests。Semantica 当前 Explorer 把 decision timestamp 写成 float、响应 schema 却要求 string，导致所有 decision routes 返回 500，正好说明跨层 schema 漂移的风险。见 [Issue #884](https://github.com/semantica-agi/semantica/issues/884)；
- 会增加写放大、PII 保留和删除治理成本，因此只记录“改变后续行为或产生外部影响”的决策。

## 3. 借鉴二：统一 provenance envelope，但先用内部模型

### 3.1 Semantica 的做法

Semantica 将 entity、chunk、relationship、source/conflict provenance 收敛到一个 `ProvenanceEntry`。记录包含 entity / activity / agent、source location、confidence、派生关系、有效时间、版本替换、bundle、invalidation 等字段；`sequence_id + previous_checksum` 形成可检测中间删除的 hash chain。见 [provenance/schemas.py](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/semantica/provenance/schemas.py#L35-L212) 和 [ProvenanceManager](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/semantica/provenance/manager.py#L59-L187)。

它还支持 W3C PROV-O 导出、上下游 lineage、软失效与完整性验证。这个方向的核心价值不是 RDF，而是**任何产物都能回答“来自什么、由谁、通过什么活动、依据哪版规则生成”**。

### 3.2 Cognia 已经有什么

- [`packages/memory/src/types/governance.ts`](../../packages/memory/src/types/governance.ts) 的 `MemoryEvidence` 已使用 source identity、excerpt hash、reviewed 和 contamination state，且明确不保存原文；
- [`packages/memory/src/types/memory.ts`](../../packages/memory/src/types/memory.ts) 已有 provenance、source channel、supersession、soft invalidation 和 conflict references；
- [`types/workflow/visual.ts`](../../types/workflow/visual.ts) 已有跨 nested/retry run 的 lineage；
- [ADR-0102](../content/docs/en/adr/0102-unified-observability-crash-diagnostics.md) 已定义跨 runtime trace context、版本化事件 envelope 与隐私 manifest。

这些契约的目的不同，不能粗暴合表，但可以共享一个只包含引用的 `LineageEnvelopeV1`：

```text
subjectRef
activityRef / activityKind
actorRef / actorRole
usedRefs[]
derivedFromRefs[]
policyRef
traceId / runId
validTime / recordedTime
contentHash / previousEnvelopeHash
privacyClass / retentionClass
```

### 3.3 建议

1. 先定义跨域 envelope 和 resolver，由各子系统保留自己的权威表；
2. Inspector 按 reference 读取 Memory evidence、Workflow lineage、tool event、approval 和产物；
3. 只有出现企业审计/交换需求时，再做 W3C PROV-O export adapter，不让 RDF vocabulary 侵入内部业务模型；
4. hash chain 按 account / workspace 或 audit bundle 分区，避免单一全局写锁；
5. hash chain 只能**发现**篡改，不能防篡改；删除合规需 tombstone、密钥擦除和 retention policy 配合。

不建议直接移植 Semantica provenance wrapper：其 `PipelineWithProvenance` 当前因引用不存在的模块而无法实例化。见 [Issue #858](https://github.com/semantica-agi/semantica/issues/858)。

## 4. 借鉴三：冲突先于 merge，并保留人工决议

### 4.1 Semantica 的做法

其官方流水线把 `Conflict Detection` 放在 `Deduplication` 和 KG construction 之前，避免先合并后抹掉不同来源的矛盾。见 [ARCHITECTURE.md](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/ARCHITECTURE.md#L39-L61)。

`Conflict` 保存冲突值、sources、confidence、severity 和 recommended action；Resolver 支持 voting、credibility-weighted、most-recent、first-seen、highest-confidence、manual review 和 expert review，并在结果中保留 strategy、sources、confidence 和 notes。见 [conflict_detector.py](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/semantica/conflicts/conflict_detector.py#L75-L141) 与 [conflict_resolver.py](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/semantica/conflicts/conflict_resolver.py#L75-L259)。

### 4.2 Cognia 已经有什么

[`packages/memory/src/consolidate/consolidator.ts`](../../packages/memory/src/consolidate/consolidator.ts) 已把 consolidation 分成 ADD / UPDATE / DELETE / CONFLICT / NOOP；冲突双方通过 `conflictWithIds` 保留。[`packages/memory/src/history-filter.ts`](../../packages/memory/src/history-filter.ts) 会让未解决冲突不进入 prompt recall。这比“last write wins”安全得多。

### 4.3 建议

- 把 Memory 现有 conflict contract 提升为共享模式，优先接入 Twin re-distill、content capture enrichment 和 connector-derived facts；
- `ConflictSet` 至少保存字段、候选值、source/evidence refs、valid time、sensitivity、resolution status、resolver actor 和策略版本；
- 只有低风险、同权威域的冲突可按 recency / explicit user override 自动处理；身份、政策、权限、程序性记忆进入人工复核；
- 冲突解决本身也写入 `AgentDecisionRecordV1`，形成闭环。

不要照搬 Semantica 的默认 voting：来源数量不等于真实性，credibility score 也可能固化来源偏见。Semantica 当前仍缺多种 resolver 路径的测试覆盖。见 [Issue #865](https://github.com/semantica-agi/semantica/issues/865)。

## 5. 借鉴四：建立“薄关系投影”，不要重建第二个真相源

Semantica 同时使用图与向量：图负责显式关系、路径、时态和因果查询，向量负责模糊相似性与 precedent retrieval；其文档也把该层定位为现有 LLM、vector store 和 agent framework 之下的补充。见 [README](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/README.md#L84-L99) 和 [Context module guide](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/docs/choose-your-module.md#L78-L143)。

Cognia 不需要先上 Neo4j、RDF triple store 或新的 Python service。更合适的是可从现有权威表重建的 projection：

```text
Session -> Message -> Evidence
Run -> Step -> ToolCall -> Artifact
Decision -> Evidence / Policy / Approval / Outcome
Memory -> Evidence / SupersededMemory / Conflict
```

初期可以使用 SQLite adjacency tables + recursive CTE，或只在 Inspector 查询时组装局部图。关键规则：

- source tables 仍是权威，关系投影必须可丢弃重建；
- `caused_by` 只接受 producer 显式写入；时间先后或共享实体只能标为 `related_to` / `inferred_relation`；
- 每条 edge 携带 tenant/workspace scope 和 evidence ref；
- 删除、permission 和 retention 从源对象传播到投影。

尤其不能照搬“看似因果”的启发式。Semantica 的 `trace_decision_causality()` 会把“共享实体且时间更早的决策”作为潜在 cause，再生成 `influences` hop；这只能表示相关线索，不能证明因果。见 [context_graph.py](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/semantica/context/context_graph.py#L2806-L2865)。

## 6. 借鉴五：先做 Context Inspector，再做大图谱

Semantica 的 Explorer 把 Knowledge Graph、Timeline、Decisions、mutation Registry、Entity Resolution、Ontology 和 Lineage 分成治理工作区。见 [Explorer README](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/explorer/README.md#L130-L141)。

对 Cognia，更有价值的第一步不是全屏 Sigma.js graph，而是一个可从消息、tool call、workflow run、memory 和 connector action 打开的 **“Why / Context Inspector”**：

- 这次行动的 actor、模型/agent、输入 evidence 和 policy；
- 显式 decision chain 与 human approval；
- 用到的 memory / twin chunks，以及污染/可信状态；
- 产生的 artifact、connector side effect 和下游 run；
- conflict、superseded、retry、rollback / revoke 入口。

UI 必须从真实运行链路做 E2E 验证。Semantica 当前 flagship Decisions routes 因 schema mismatch 全部 500，说明“治理 UI 存在”不等于“审计链可用”。见 [Issue #884](https://github.com/semantica-agi/semantica/issues/884)。

## 7. 可选借鉴：决策先例检索与 capability matrix

### 7.1 Precedent retrieval

Semantica 把“搜索过去相似决策”作为 decision lifecycle 的独立能力。Cognia 已有 hybrid memory retrieval 和 native sqlite-vec，可先为 `AgentDecisionRecordV1` 建小型索引：

1. 用 category、workspace、actor、policy version、outcome、time 做硬过滤；
2. 只对 scenario + user-facing rationale 做 embedding similarity；
3. 结果明确标注“相似案例，不代表正确先例或因果”；
4. 用离线 fixture 评估 false analogy，再允许它影响自动决策。

这适用于 repeated workflow resolution、tool permission 建议和 connector action review，不应直接自动批准高风险操作。

### 7.2 后端 capability matrix

Semantica 通过 registry 和 optional backend 组织 graph/vector/provider，但其用户仍在请求明确的 graph backend feature matrix。见 [vector registry](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/semantica/vector_store/registry.py#L45-L155) 与 [Issue #888](https://github.com/semantica-agi/semantica/issues/888)。

Cognia 已有 `IVectorStore` 和 typed plugin registries；值得补的是机器可读 capability，而不是继续增加 adapter 数量，例如：

```text
supportsMetadataFilter
supportsHybridSearch
supportsTransactions
supportsTemporalQuery
supportsLocalOnly
supportsAuditExport
```

Capability negotiation、conformance tests 和 UI 降级说明必须一起交付，否则“支持某 backend”容易被误读为“所有功能等价”。

## 8. 明确不建议借的部分

### 8.1 不直接集成 Semantica 0.6.0

原因不是许可证，而是产品边界和当前成熟度：

- `pyproject.toml` 的 core dependencies 直接包含 Torch、Transformers、spaCy、OpenCV、librosa、FAISS 等，虽然另有 optional extras，基础安装仍然很重。见 [pyproject.toml](https://github.com/semantica-agi/semantica/blob/6f310d1d7acf11013dc7e68d4e68823eb96cec4d/pyproject.toml#L55-L162)；
- provenance pipeline 当前不可实例化：[Issue #858](https://github.com/semantica-agi/semantica/issues/858)；
- Explorer decision API 当前不可用：[Issue #884](https://github.com/semantica-agi/semantica/issues/884)；
- Web/API ingestion 有公开的 SSRF 缺口，可访问 loopback、私网和 cloud metadata endpoint：[Issue #867](https://github.com/semantica-agi/semantica/issues/867)；
- conflict resolver 尚有明显测试空白：[Issue #865](https://github.com/semantica-agi/semantica/issues/865)。

因此适合**参考领域模型并在 Cognia 现有安全、PII、测试和存储边界内重实现**，不适合直接暴露其 ingestion、Explorer API 或作为新的常驻 sidecar。

### 8.2 不提前引入 RDF / OWL / SHACL / Datalog

这些能力只有在出现明确的跨组织语义交换、监管导出、复杂本体校验或确定性规则推理需求时才值得承担。当前先做内部 decision/evidence contract，未来再提供 export adapter，成本更可控。

### 8.3 不把 context graph 变成新的权威数据库

Cognia 已经有 Dexie、Rust SQLite、workflow run store、observability spool 和 vector store。再引入一个独立 truth store 会带来双写、删除一致性、权限传播、备份恢复和跨设备同步问题。Graph 应先是 derived projection。

## 9. 推荐落地顺序

### Phase A — 契约与只读 Inspector（P0）

1. 定义 `AgentDecisionRecordV1` 与 `LineageEnvelopeV1`；
2. 为 approval、risk ceremony、workflow branch 做 adapter / producer；
3. 做只读 Context Inspector，串起现有 run、evidence、policy 和 artifact；
4. 加 producer/consumer contract tests、PII 与 retention 测试。

验证标准：选一条 workflow + tool approval 的真实链路，用户能从最终 artifact 一步追到 decision、approval、evidence 和原始 run，且没有保存 raw chain-of-thought。

### Phase B — 冲突与显式关系投影（P1）

1. 把 Memory conflict contract 扩展到 Twin / capture；
2. 建可重建 adjacency projection；
3. 只允许显式 causal edges，推断关系单独标记；
4. 增加人工 resolve、supersede 和 revoke 流程。

验证标准：两份相互矛盾的来源不会被 silent merge；冲突项不会进入 prompt；人工决议后保留完整前后历史。

### Phase C — Precedent 与标准导出（条件式 P2）

1. 对决策做结构化过滤 + vector similarity；
2. 建 false-analogy evaluation fixtures；
3. 有真实企业需求后再加 PROV-O / JSON-LD export；
4. 只有出现 ontology/policy 客户需求时评估 SHACL / deterministic rules。

## 10. 最终判断

Semantica 的核心启发不是“知识图谱比向量库高级”，而是：

> Agent 系统中最重要的资产不是更多上下文，而是能被追问、复核、纠正和复用的决策与证据链。

Cognia 已有实现这件事所需的大多数模块。最有杠杆的下一步，是把已有 Twin decisions、Memory evidence/conflicts、Workflow lineage、approval、MCP audit 和 observability trace 连接成统一的读取与治理体验；先得到一个可信的 Context Inspector，再决定是否需要持久图、标准语义网或更重的推理引擎。
