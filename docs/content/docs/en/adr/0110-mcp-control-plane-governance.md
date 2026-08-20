---
title: "ADR-0110: MCP Control Plane Governance"
description: Govern outbound MCP definitions, credentials, policy, runtime scopes, Agent projection, and audit without merging the inbound External Bridge.
---

# ADR-0110: MCP Control Plane Governance

## Status

Accepted — implemented in schema v151; extended 2026-08-21 with decisions 13–14 (per-tool deny rules, paired-client writes).

## Context

Outbound consumption, external-Agent projection, built-in hosting, and the inbound External Bridge are legitimate but different MCP planes. Previously, configuration and lifecycle were split across unvalidated Dexie rows, Agent files, renderer one-shot clients, native probes, and sidecar sessions. Names could collide, credentials could reach backups/mobile, imports could execute before review, and workflow calls repeatedly reconnected.

## Decision

1. `mcpServers` is a versioned Registry. `id` is stable identity; normalized `name` is the unique external namespace; `displayName` is presentation-only.
2. New/imported/plugin/preset definitions start `pending`, disabled, and unprojected. Existing definitions remain operational as `legacy`. Material executable or endpoint changes invalidate trust and increment `revision`.
3. Persisted config is a transport-discriminated shape. Sensitive env/header/argument/URL values become stable-ID `SecretRef` values after verified keyring writes. OAuth uses server ID with one-release name fallback.
4. All outbound opens cross the same policy and remote-egress guard. Non-interactive pending decisions fail closed. HTTPS is required by default; redirects and private/reserved endpoints require explicit review.
5. Agent projection is durable and coalesced in `mcpSyncJobs`. Adapters come only from `MCP_AGENT_ADAPTERS`; rename/delete tombstones are retained until the projected file is re-read and verified.
6. `McpRuntimeGateway` owns client-managed workflow/plan/CLI connections. Pool keys include scope, server, definition revision, and credential version. Reuse never crosses chat sessions or workflow runs. Connect/discovery concurrency is four; connect/list timeout is 15 seconds; calls are capped at 60 seconds; connects retry once; tool calls never retry; repeated connection failures open a bounded circuit.
7. Capabilities are cached for five minutes by fingerprint. GUI and custom-mode selection consume one normalized runtime/capability snapshot.
8. Paired mobile receives only `McpServerSummary`. Default backups contain redacted definitions and a missing-credential manifest. Durable audit rows never contain arguments, results, headers, or secrets and are retained for 30 days / 10,000 rows.
9. The inbound External Bridge stays separate. Its only MCP URL is `GET|POST|DELETE /mcp/stream`; `/mcp` and `/mcp/sse` are deleted rather than redirected. It uses per-client credential verifiers, scope intersection, client-bound session IDs, loopback/rebinding protection, and default-deny policy while sharing the content-free audit vocabulary. Active sessions are capped at 128, idle sessions are reclaimed, and overload fails explicitly.
10. Settings capability discovery uses the sidecar `mcp-discover` feature operation; the hand-written Rust probe and its Companion/Tauri command surface are retired.
11. Anthropic remote servers are presented to the Agent SDK as SDK-managed stdio relays. The relay owns the guarded upstream HTTP/SSE socket, so DNS resolution is checked at connect time rather than only before SDK handoff.
12. `loadMcpOperationsSnapshot` derives persistent per-server failure rate/connect p95/capability freshness and Agent sync lag from the existing audit, cache, and sync tables; it does not introduce a second log.
13. A definition carries two per-tool deny axes: `disallowedTools` (exact bare names) and `disallowedToolPatterns` (globs, expanded against the capability cache at send time). Trust review re-opens on an executable/endpoint change or on a **relaxed** rule; a tightening does not, because forcing a review would disable the server and make a per-tool switch unusable. Capability rows survive a rules-only edit — the names are what the globs expand against.
14. `McpServerSummary` additionally carries the deny rules and the tool names from the last discovery, projected on every capability-cache write. A paired client may write exactly two commands, `mcp_set_enabled` and `mcp_set_tool_rules`, both routed through `updateMcpServer` so the trust gate, summary mirror, and Agent projection behave as they do for a local edit. Definition CRUD and the OAuth flow remain host-only.

## Consequences

- Presets are installation templates, never executable fallbacks.
- A namespace rename is an explicit projection change; a display-name edit is not.
- Literal credentials enter an Agent file only after explicit target selection and host-side resolution.
- Legacy SSE uses the 2024-11-05 fallback; current stdio and Streamable HTTP advertise 2025-11-25.
- The inbound bridge has no single-token HTTP facade or compatibility route; clients must use a scoped client credential and `/mcp/stream`.
- The Registry, Sync Coordinator, and Runtime Gateway are independently reversible seams.
- A glob deny rule is only as complete as the last discovery: an unexpanded pattern denies nothing, which is the fail-open direction, so the settings UI states how many tools each rule currently covers.
- Decision 8 is narrowed, not reversed: paired clients still receive only a summary, but that summary is now large enough to render and govern a tool list.

## References

- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
