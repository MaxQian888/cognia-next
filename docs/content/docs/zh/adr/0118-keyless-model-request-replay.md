---
title: "ADR-0118：无 API Key 的确定性模型请求回放"
description: "录一次真实请求面，之后无需 API Key 即可回放 Agent 运行"
---

# ADR-0118：无 API Key 的确定性模型请求回放

- 状态：已接受，分阶段发布
- 日期：2026-08-14

## 背景

系统里没有任何地方记录真正发给模型的内容。最终 system prompt、归一化后的
message 列表、tool schema 及其顺序、解析后的请求配置，分散在
`lib/claude/build-options.ts`、执行 resolver 和 sidecar 中拼装完成后即被丢弃。
因此 prompt 或工具装配的回归在人类察觉到行为异常之前是不可见的，也没有任何
Agent 级测试能在没有真实 API Key 的情况下在 CI 中运行。

可复用的基础已经存在：Eval Lab（ADR-0101）有加密资产
（`lib/ai/eval/artifact-crypto.ts`、`lib/ai/eval/assets.ts`）、可移植 bundle
（`lib/ai/eval/replay-bundle.ts`、`packages/eval-core/src/portable.ts`），以及带
`preflight`、`run`、`import`、`status`、`report`、`export` 的 `cognia eval`
CLI。E2E 已经会启动本地 mock Anthropic server
（`tests/e2e/mocks/anthropic/server.ts`），证明 localhost 方案可行，但它只覆盖
浏览器用例的 wire 级 chat。持久化的 `AgentEventEnvelope` 日志也已存在，并且本来
就要求消费方忽略未知事件类型，所以它的词汇表可以 additive 地扩展。

## 决策

三个版本化契约落在 `packages/agent-config-types`：`ModelRequestSurfaceV1`
（identity lineage、runtime、provider、model、purpose、解析配置、
prompt/message/tool schema 的引用与 digest、ADR-0117 的 composition digest、
现有 execution fingerprint 以及 request digest）、`ReplayScenarioV1`（actor、
输入步骤、运行平台、回放层级、权限脚本、工作区种子、预期结果）、
`ReplayTapeV1`（归一化匹配条件，以及要提供的模型流、错误、取消或 hang 行为）。

新增唯一一个 additive canonical 事件 `model-request`，只携带 digest 与加密资产
引用，绝不携带 prompt 或响应正文。不引入第二套事件总线。

回放分两层。**Canonical replay** 重放 `AgentEventEnvelope` 帧，验证渲染、恢复、
权限状态与父子日志。**Runtime replay** 跑真实 SDK、Agent loop、tool pipeline、
权限系统与持久化，只把模型端点替换成本地 tape server。

请求按 actor 匹配，而不是全局顺序：每个父/子 actor 持有独立的 replay lease，
在自己未消费的 tape 中按归一化 request digest 匹配，因此并发子 Agent 不会互相
打乱。同一 actor 内若出现 digest 相同但预期响应不同的两条 tape，fixture 构建
直接失败，不做模糊匹配。每次运行结束都执行 `assertConsumed`，在缺失请求、多余
请求、未消费权限条目、未完成子 Agent 和孤儿日志上失败。

存储复用 eval 加密资产存储与 `.cognia-eval` bundle，扩展 `model-request`、
`model-stream`、`permission-tape`、`session-log`、`transport`、
`workspace-manifest` 六种 artifact kind。录制是 opt-in：普通运行只持久化 digest
与引用。捕获点位于 PII gate 之后，authorization 头、API Key 和敏感环境变量绝不
进入快照。真实录制保持加密且不入 git；fixture 只有被标记为 synthetic 并通过
secret 与 PII 扫描后才允许提交。回放只允许 loopback 网络和一次性工作区。删除
eval 资产时同步删除对应的 replay artifact 引用。

`cognia eval` 新增 `record`、`replay`、`refresh`。`record` 必须带显式 live 标志
并串行执行；`replay` 在无 Key 条件下针对只读 fixture 运行；`refresh` 只能重新
生成可派生的 golden，绝不允许重录模型 tape。Eval Lab 增加独立的 Replay 工作区，
支持导入、preflight、运行、diff 和显式的 refresh 审批。

先实现 Claude Agent SDK：扩展现有 localhost mock harness，用一个无权限的占位
token 满足 SDK 的参数校验——它不是凭据，也不产生任何外发请求。随后是 AI SDK 的
本地 provider adapter。External 与 ACP 使用 scripted peer；当外部 Agent 不暴露
其内部模型请求时，只捕获 wire protocol 与 canonical 事件，并在报告中声明降级的
fidelity，而不是谎称拿到了完整快照。浏览器只支持 canonical replay；runtime
replay 需要 Tauri 或 headless 宿主，不可用时明确说明原因。

## 复用边界

不新建数据库、事件总线、加密方案或 CLI。本决策扩展 eval artifact 存储与 bundle
格式、`cognia eval` 命令、canonical 事件词汇表、现有 E2E mock harness，以及现有
权限与沙箱系统。Agent RPC 与执行 resolver 继续拥有运行时路由，回放只替换模型
端点。

## 兼容与回滚

`model-request` 是 additive 的，旧消费方忽略未知类型。录制默认关闭并由 flag
控制；关闭后已写入的 artifact 仍可按原保留策略读取。Replay suite 先作为可选
检查发布，稳定后才提升为合并门禁，因此 harness 自身的回归不会阻塞无关工作。

## 影响

prompt、tool schema、权限与 lineage 的回归变成可 diff 的对象，Agent 级用例可以
在无 Key、无外网的 CI 中运行。代价是录制路径必须始终位于 PII gate 之后、
fixture 语料需要以 synthetic 方式持续维护，以及对外部 Agent 必须公开承认
fidelity 阶梯而不能含糊带过。
