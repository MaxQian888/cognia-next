---
title: "ADR-0112：统一决策、来源链与冲突账本"
description: 以一个隐私安全的本地契约统一控制决策、内容证据、血缘和合并前冲突，使行动原因可检视。
---

# ADR-0112：统一决策、来源链与冲突账本

## 状态

已接受（2026-08-11）。

## 背景

Cognia 已分别持久化 Memory 证据与冲突、Workflow 血缘、Twin 观察、connector 审计和 Action Review receipt。这些领域模型能回答局部问题，但无法在不编写专用关联逻辑的前提下共同回答“为什么执行这次行动”。Twin 重蒸馏也只会去重等价选择，无法把相反选择保留为显式复核对象。

## 决策

1. `@cognia/agent-config-types/governance` 定义带版本、零依赖的 `DecisionCaseV1`、`DecisionEventV1`、`EvidenceRefV1`、`LineageEdgeV1`、`ConflictSetV1` 与 `ProvenanceEnvelopeV1`。领域载荷留在原有存储中；账本只保存引用、脱敏的用户可见理由、基础类型元数据和 SHA-256 摘要，绝不保存 prompt、工具参数/结果、connector 正文、采集文本、密钥或模型思维链。
2. Dexie v157 新增六张设备本地表：`governanceDecisions`、`governanceDecisionEvents`、`governanceEvidence`、`governanceLineage`、`governanceConflicts`、`governanceProvenance`。写入依靠 producer 稳定 ID 保证幂等；决策事件只追加，并推进当前状态投影。
3. Producer 覆盖 Workflow 分支、所有 `approveTool` 结果、Action Review receipt/effect、Memory 冲突解决、Twin 决策、内容采集持久化和 connector 入站路由。投影采用 best-effort，失败不能打断源行动。
4. 冲突检测发生在语义合并之前。同一归一化上下文与选择的 Twin 观察会合并证据引用；同一上下文的不同选择保持分离，转为 `disputed` 并创建开放的 `ConflictSet`。Memory 现有 `CONFLICT` 与人工解决流程投影为同一套通用冲突、决策和血缘对象。原始 capture 与 connector 事件保持不可变证据，不会被静默提升为事实。
5. “安全与隐私”设置页挂载实时 Context Inspector，展示最近决策的结果、理由、事件/证据/血缘/来源链数量和未解决冲突状态。界面只读取脱敏账本。
6. 六张表均为受保护、账户域内、设备本地的审计数据；不进入 portable backup 和 Companion sync，删除账户数据库时随账户删除。

## 影响

- Workflow、授权、审批、connector、Memory 和 Twin 共用一种查询模型，同时保留各自专用源记录。
- 重放安全，状态变化可通过事件解释。
- 矛盾在 consolidation 前进入复核，而非被覆盖。
- 账本是轻量派生关系投影，不引入 RDF/OWL 或规则引擎。
- 即使治理投影失败，源行动仍可执行；缺失投影表现为审计缺口，而不是行动中断。

## 验证

覆盖契约校验器、Dexie v157 schema/index 迁移、仓储幂等与事件排序、各 producer 的内容脱敏、Twin 证据合并/冲突创建、Memory 冲突解决、Workflow 路由、connector 路由、工具授权成功/失败、Context Inspector 交互、i18n 对齐、数据目录对 sync/backup 的排除、typecheck、lint、coverage 与 static export。

## 参考

- `docs/research/decision-evidence-lineage-conflict-design-2026-08-11.md`
- `docs/research/semantica-borrowable-ideas-2026-08-11.md`
