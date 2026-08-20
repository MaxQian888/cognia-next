---
title: "ADR-0110：MCP 控制面治理"
description: 在不合并入站 External Bridge 的前提下，统一治理出站 MCP 定义、凭证、策略、运行时作用域、Agent 投射与审计。
---

# ADR-0110：MCP 控制面治理

## 状态

已接受——由 schema v151 落地；2026-08-21 扩展决策 13–14（按工具禁用规则、配对端写入）。

## 背景

出站消费、外部 Agent 投射、内置托管和入站 External Bridge 是四个合理但不同的 MCP 平面。此前配置与生命周期分散在未校验的 Dexie 行、Agent 文件、渲染器一次性客户端、原生探针和 sidecar 会话中，导致命名空间覆盖、凭证进入备份/移动端、导入后未评审即执行，以及工作流每次调用都重连。

## 决策

1. `mcpServers` 是版本化 Registry。`id` 是稳定身份；规范化 `name` 是唯一外部命名空间；`displayName` 只用于展示。
2. 新建、导入、插件与 preset 定义均以 `pending`、禁用、无投射开始；已有定义作为 `legacy` 保持可用。可执行文件或端点发生实质变化时使信任失效并增加 `revision`。
3. 持久化配置使用 transport 判别联合。敏感 env/header/参数/URL 经 keyring 写后读校验，再替换为基于稳定 ID 的 `SecretRef`。OAuth 改用 server ID，并保留一个版本的旧名称回退读取。
4. 所有出站连接统一经过 policy 与远程 egress guard。非交互场景的 pending 决策默认拒绝。默认仅 HTTPS；重定向、私网与保留地址必须显式评审。
5. Agent 投射通过 `mcpSyncJobs` 持久化并合并。目标只来自 `MCP_AGENT_ADAPTERS`；重命名/删除 tombstone 在重读并验证 Agent 文件前不会丢失。
6. `McpRuntimeGateway` 管理 workflow/plan/CLI 的 client-managed 连接。池键包含 scope、server、定义 revision 与 credential version；绝不跨 chat session 或 workflow run 复用。连接/发现并发上限为 4，连接/列表超时 15 秒，工具调用上限 60 秒；连接重试一次，工具调用不自动重试，连续连接失败进入有上限的熔断。
7. 能力按 fingerprint 缓存 5 分钟。GUI 与 custom-mode 选择器消费同一份规范化 runtime/capability 快照。
8. 配对移动端只接收 `McpServerSummary`。默认备份只含脱敏定义和缺失凭证清单。持久审计不保存参数、结果、header 或 secret，并按 30 天 / 10,000 行保留。
9. 入站 External Bridge 保持独立。其唯一 MCP URL 为 `GET|POST|DELETE /mcp/stream`；`/mcp` 与 `/mcp/sse` 直接删除而不重定向。它保留按 client 的 credential verifier、scope 交集、client-bound session ID、loopback/DNS rebinding 防护和默认拒绝，并只共享无内容审计词汇。活动 session 上限为 128，空闲 session 会回收，过载会明确失败。
10. 设置页能力发现使用 sidecar `mcp-discover` feature operation；手写 Rust 探针及其 Companion/Tauri 命令面退役。
11. Anthropic 远程服务器以 SDK-managed stdio relay 的形式交给 Agent SDK。Relay 负责受防护的上游 HTTP/SSE socket，使 DNS 在实际连接时校验，而不是只在 SDK handoff 前校验。
12. `loadMcpOperationsSnapshot` 从既有 audit、cache 与 sync 表派生持久化的按服务器失败率、连接 P95、能力新鲜度与 Agent 同步延迟，不创建第二套日志。
13. 一条定义携带两条按工具的禁用轴：`disallowedTools`（精确裸工具名）与 `disallowedToolPatterns`（通配规则，发送时针对能力缓存展开）。可执行体/端点变更，或规则被**放宽**，会重新触发信任复核；收紧则不会——强制复核会禁用服务器，让按工具开关无法使用。仅改规则的编辑不清除能力缓存行，因为那些工具名正是通配规则展开所依赖的对象。
14. `McpServerSummary` 额外携带禁用规则与最近一次探测得到的工具名，在每次能力缓存写入时投射。配对端可写且仅可写两条命令：`mcp_set_enabled` 与 `mcp_set_tool_rules`，二者都经由 `updateMcpServer`，使信任门、同步镜像与 Agent 投射的行为与本机编辑一致。定义的增删改与 OAuth 流程仍然仅限宿主端。

## 影响

- Preset 只是安装模板，不再作为可执行回退。
- 命名空间重命名会触发投射变更；display name 修改不会。
- 只有用户显式选择目标且宿主成功解析后，字面量凭证才会进入 Agent 文件。
- Legacy SSE 使用 2024-11-05 回退；当前 stdio 与 Streamable HTTP 使用 2025-11-25。
- 入站 Bridge 不提供 single-token HTTP facade 或兼容路由；客户端必须使用 scoped client credential 与 `/mcp/stream`。
- Registry、Sync Coordinator 与 Runtime Gateway 均是可独立回滚的边界。
- 通配禁用规则的完整度取决于最近一次探测：未展开的规则不禁用任何东西，这是 fail-open 的方向，因此设置界面会明确显示每条规则当前覆盖了多少个工具。
- 决策 8 是被收窄而非推翻：配对端拿到的仍然只有 summary，只是这份 summary 现在大到足以渲染并治理一份工具列表。

## 参考

- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
