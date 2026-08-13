---
title: "ADR-0115：统一 Memory 与 RAG 基础设施"
description: 为 Memory、Twin、Project Knowledge、Knowledge Base 和 External RAG 提供唯一的安全检索内核与可恢复控制面。
---

# ADR-0115：统一 Memory 与 RAG 基础设施

## 状态

已接受（2026-08-13）。这是 Heavy ADR。采用分阶段上线；每阶段都必须具备独立开关、兼容边界、质量门禁和回滚演练。

## 背景

Cognia 有五个检索域：长期 Memory、Digital Twin、Project Knowledge、Knowledge Base 和 External RAG。它们的所有权、授权、保留、审阅与展示语义不同，不能合并成同一业务实体；但它们重复实现了 query embedding、词法检索、向量融合、重试、索引生命周期与诊断。

重复实现造成了真实缺口：locality 有时错误地按 vector backend 判断；部分聊天和 Workflow 路径绕过 PII 边界；向量故障会被伪装为空结果；旧索引可能在新索引成功前被删除；Memory job 把无输出、跳过和成功都记成 `completed`；trace/cache 没有统一的无正文身份与保留策略；未审阅 procedural 内容可能进入检索；旧治理字段把未知值伪装为已知值。

## 决策

### 1. Canonical profile 与 locality

`RetrievalProfileV1` 是稳定配置边界，记录 embedding provider/model、vector backend、预算、expansion/rerank 与安全策略。其规范化 SHA-256 fingerprint 不受对象键顺序影响。fingerprint 改变必须构建新 generation，禁止原地修改 serving generation。

Provider locality 只读取 `@cognia/provider-embedding/embedding-catalog`。`native-local`、`local-openai`、`browser` 为本地；Bedrock 与托管 provider 始终为远端，与 vector database 是否本地无关。

### 2. 唯一出站 embedding 网关

所有应用拥有的 query/document embedding 必须经过 `SafeEmbeddingGateway`：

- 远端 provider 只接收脱敏投影；脱敏后仍检测到 PII 时 fail closed；
- 本地 provider 仅在 profile 显式允许时接收原文，默认仍脱敏；
- cache key 为 `provider:model:SHA256(safeText)`，结果、job、trace、cache 均无正文；
- 空向量、非有限数值和维度不匹配在 vector search 前失败。

Query expansion、云 rerank 和最终完整 prompt 也执行相同 locality/PII 总闸。检索内容始终按 data-only 边界注入。

### 3. 唯一组合式检索内核

`@cognia/rag` 拥有唯一融合与预算编排内核。请求携带 reader scope、允许域、query、预算、可选的安全预计算 embedding 和取消信号。Domain adapter 只负责授权 join、域特有评分、加密正文解析和 UI 映射。

词法检索始终可用。向量未配置、embedding 失败、超时或维度不匹配时返回明确的 BM25 partial/degraded 结果及机器可读原因，禁止伪装成正常空结果。

旧 `RAGRuntime`、`RAGPipeline`、Workflow、Plugin、MCP、RPC 和 Companion 接口在兼容周期内保持签名，只作为新服务的 façade。

### 4. 无正文 trace

`RetrievalTraceV1` 仅保存 query hash、profile fingerprint、generation id、候选/命中 ID、分项分数、排除原因、cache、预算、延迟和 grounding 计数。禁止 query 正文、content、path 和用户标识；写入时拒绝正文型字段。

成功/no-output job 与 trace 保留 30 天且每 profile 最多 20,000 条；失败、隔离与安全事件 90 天；无正文 audit 180 天。

### 5. Generation 索引

每个 corpus/profile 通过 `staging → validating → active → retiring` 构建，`failed` 为终态分支。校验记录 count、content hash 和 vector dimension。事务同时切 active pointer 并退休旧 generation；失败不得修改 pointer。云向量必须使用 generation namespace 或强制 metadata filter。Project snapshot 只在 activation 后推进。

### 6. 可靠任务

`RetrievalJob` 与 `MemoryJob` 统一为：

`queued | running | retry_wait | succeeded | no_output | skipped | failed | cancelled`。

任务具备 lease、heartbeat、attempt 上限、dedupe、取消和过期租约恢复；重试使用指数退避。策略拒绝是 `skipped`，没有可持久化结果是 `no_output`，重试耗尽是 `failed`，都不得报告为成功。

Memory consolidation 按 profile + scope + namespace 串行；Memory 变更、evidence 绑定与 audit 投影必须原子提交。对账检测 orphan vector、missing chunk 和错误 active pointer。

### 7. Memory 治理与多 Agent 隔离

全局 `useMemory`、`learnFromChats` 只是默认值；session 的 `inherit/on/off` 可以覆盖。硬门禁仍是 `enabled`、temporary、Agent operations/scopes、external-context policy 与 `autoExtract`。

自动写入在有 Project 时默认 workspace，否则 global。character/agent/branch/path 缩窄必须有明确 applicability rationale。读取始终携带 project、agent、Git branch 与规范化 workspace-relative path。

用户、assistant、tool evidence 使用不同 role。Assistant 输出不得伪装成用户事实。Team、subagent 与外部 Agent finding 首先成为私有、untrusted inbound draft；共享 Memory 需要 supervisor policy 或用户显式晋升。

旧未审阅 procedural 行迁移到 `pending_instruction`，检索硬排除。接受后通过既有 inbound draft/materializer 晋升为 verified instruction、disabled Skill 或 Workflow。

排序纳入 relevance、recency、importance、confidence、provenance、feedback、staleness、review 与 contamination；expired、conflict、quarantined、pending procedural 为硬排除。

### 8. 加密与设备密钥

Canonical 正文、safe projection、evidence excerpt 和 lexical segment 只以 `EncryptedContentEnvelopeV1` 落盘：AES-256-GCM、key id、随机 96-bit IV、ciphertext 与 AAD hash。Profile DEK 与 pairing/signing key 分离。

每台设备在自身安全边界生成 wrapping key：Desktop 使用 OS keyring，Mobile 使用 SecureStorage，Headless 使用配置的 secret store，Web 使用解锁后的 Browser Vault。Vault locked 是明确状态，禁止明文降级。

同步只传 ciphertext envelope；不支持 key protocol 的客户端收到 `upgrade_required`。Portable backup 使用既有 backup passphrase/key 封装 DEK。Plaintext export 必须单独确认并审计。

### 9. 授权、信任与删除

Source authorization 与 workspace trust 在评分前判断。撤权立即从 eligibility 排除，再退休 generation 并异步清理 vector/cache。Chunk 携带 trust/contamination；高风险 prompt-injection chunk 隔离，canonical 正文不被静默修改。

删除级联业务实体、source/chunk/evidence、加密 index/cache 与 sync tombstone。Tombstone 等所有已知设备确认后至少再保留 30 天。Audit 只保留去正文、去标识事件。

### 10. Grounding 与压缩连续性

RAG 回答生成 claim→chunk 支持和精确 offset。交互聊天在流结束后标注 unsupported claim；自动化、对外发送和高风险路径低于门槛时阻止或安全重试。

Compaction 复用 working set、boundary、undo 与 Optical Archive。`CompactionCheckpointV1` 保存 goal、已完成工作、活动状态、决策/依据、evidence ref、阻塞、下一步、约束、do-not-repeat、精确重注入版本与 token 计数。resume/fork/model-switch 在预算内确定性重注入 policy、verified instruction、working set、selected Skill 和 eligible Memory/RAG。

## 存储、迁移与回滚

Dexie v163 新增 profile、generation、active pointer、job、trace、encrypted content、tombstone 与 migration journal。v164 新增 Memory 治理索引并迁移 job 状态，v165 为派生 RAG chunk 增加 generation 索引，v166 增加共享上线 kill switch，v167 为 Companion 有界同步增加 Memory updatedAt 索引。旧 confidence/expiry/staleness 明确保持 unknown；旧未审阅 procedural 进入 pending review。

迁移采用可恢复 journal/watermark：新增 schema → 双读比对 → 有界批次加密正文/词法段 → 补 unknown 治理字段 → 构建并校验 generation → 质量门禁 → 原子切读写 → 验证后清空旧明文。

回滚只切 active pointer 与 compatibility adapter；不恢复明文，也不降级到无法解密当前 envelope/key protocol 的客户端。单一 kill switch 停止新 kernel、新摄取与新晋升，同时保留解密、导出、删除、对账与安全 BM25 读取。

## 容量与 SLO

Desktop/Headless 每 profile 目标 100,000 Memory 历史、1,000,000 chunks、10 GB canonical 内容。Web/Mobile 使用同一契约的有界离线集合与最近命中缓存，认证 Desktop/Headless 为在线 authority。

- 热 BM25 p95 ≤ 150 ms；
- native hybrid p95 ≤ 500 ms；
- 首批 context ≤ 700 ms；
- 额外峰值内存 ≤ 512 MB；
- UI 主线程不执行索引。

超时返回明确 BM25 partial result。

## 验证

必须覆盖 locality/PII fail-closed、session override/scope、治理排序与硬排除、任务状态/lease 故障注入、generation 切换失败、encryption/AAD/key rotation、撤权/删除/tombstone、grounding、迁移重启/回滚、中英固定语料 eval、规模/SLO、coverage/type/lint/i18n/static-export/data-governance audit、plugin/companion contract、build 和 Web/Mobile/Tauri E2E。
