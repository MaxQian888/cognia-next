# Hooks and Agent Fleet gap analysis

**Date:** 2026-08-06
**Scope:** Cognia lifecycle Hooks and Agent Fleet compared with the bundled runtimes and their current official contracts.
**Method:** Repository source inspection, local runtime probes, installed SDK type inspection, and primary upstream documentation/source only. Version-sensitive conclusions are pinned to the versions below.

## Executive conclusion

Cognia already contains most of the required building blocks, but they are split between two competing authority paths:

- Hooks have a Rust settings runtime, an SDK-native sidecar adapter, a CLI adapter, and external-agent bridges without a single versioned capability contract.
- Agent Fleet has a useful external-process monitor, while ADR-0090 already defines the canonical execution envelope and durable recovery authority. The Fleet monitor must become a projection of that authority rather than a second session database.

The target is therefore consolidation rather than replacement: one semantic hook core with provider adapters, and one canonical event history projected into Fleet read/control surfaces.

## Version evidence

| Runtime                 | Evidence checked                                        | Result                                                           |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| Claude Agent SDK        | Pinned dependency and installed TypeScript declarations | `0.3.220`; 31 hook events                                        |
| Claude Agent SDK latest | npm registry observed on 2026-08-06                     | `0.3.223`                                                        |
| Codex                   | Local `codex --version` and local hook schema/help      | `0.145.0`; 11 hook events                                        |
| Codex latest            | npm registry observed on 2026-08-06                     | `0.146.1`                                                        |
| OpenCode SDK            | Installed generated client declarations                 | `1.17.13`; Question APIs, V1 abort, and V2 interrupt are present |

The Claude SDK event set is:

`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PermissionRequest`, `PermissionDenied`, `Setup`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`, and `MessageDisplay`.

The local Codex event set is:

`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, and `Stop`.

## Hooks comparison

| Capability                | Upstream/native contract                                                                     | Previous Cognia state                                                                                                  | Required target                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Event catalog             | Claude 31; Codex 11                                                                          | Shared catalogs exposed 27 and omitted `Setup`, `SubagentStart`, `DirectoryAdded`, `MessageDisplay`; Codex installed 9 | Runtime-probed, provider-scoped event capabilities with conservative degradation                   |
| Handler kinds             | Claude settings: `command`, `http`, `mcp_tool`, `prompt`, `agent`; Codex currently `command` | Product model/UI exposed `command` and legacy `webhook` only                                                           | Canonical `http` plus legacy `webhook` migration; expose only kinds proven by the selected runtime |
| Built-in Claude ownership | SDK-native hook registration                                                                 | Rust pre-ran `UserPromptSubmit`, then the sidecar registered it again                                                  | SDK-native, single-owner execution; no Rust pre-run                                                |
| Failure policy            | Runtime-specific                                                                             | Mostly implicit fail-open behavior                                                                                     | User hooks fail open with visible diagnostics; managed policy hooks fail closed                    |
| Outbound safety           | Host boundary depends on handler                                                             | Rust webhook posted payload directly; sidecar had a PII gate                                                           | Redact before any outbound handler, then block when sensitive data remains                         |
| Audit                     | Structured hook inputs/outputs exist upstream                                                | Partial logs/notices                                                                                                   | Persist event, provider, matched handler, decision, latency, redaction, error, and policy class    |
| LLM-backed handlers       | Claude supports `prompt` and `agent`                                                         | No shared budget/recursion rule                                                                                        | Charge the run governor, mark `hook-origin`, and cap recursion depth at one                        |
| External agents           | Provider protocols differ                                                                    | Ad-hoc mapping into the Rust runner                                                                                    | Canonical hook envelope plus the same capability negotiation contract                              |
| UI                        | Provider/runtime capabilities vary                                                           | Static event list and command/webhook form; webhook incorrectly marked unsupported                                     | Capability-aware event and handler choices with explicit degraded/unsupported reasons              |

## Agent Fleet comparison

| Capability         | Provider/runtime evidence                                                  | Previous Cognia state                                                        | Required target                                                                           |
| ------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Source of truth    | ADR-0090 canonical `AgentEventEnvelope` and execution handle already exist | Fleet registry folded a separate external-hook stream                        | Canonical history is authoritative; Fleet is a live/history projection                    |
| Codex lifecycle    | Local runtime proves 11 events                                             | Installer wrote 9 and incorrectly excluded `SessionEnd`                      | Probe before install; install the proven set including `SessionEnd` and `SubagentStart`   |
| OpenCode questions | Native question list/reply/reject APIs                                     | Manifest advertised no answer capability                                     | Use native Question API and surface answer/reject controls                                |
| OpenCode interrupt | V2 `session.interrupt`; V1 `session.abort`                                 | Manifest advertised no interrupt capability                                  | Prefer V2 interrupt, fall back to V1 abort; never infer support from provider name alone  |
| Commands           | Remote control needs delivery semantics                                    | In-memory queue removed commands on poll and swallowed async prompt failures | Durable at-least-once outbox with idempotency key, lease/ack/nack/result, retry, TTL      |
| Stop/restart       | Monitor lifetime is not session lifetime                                   | Stop removed configuration and token without reconciliation                  | Mark live rows `detached`; reconcile against provider/runtime state at startup            |
| Subagents          | Claude/Codex expose native subagent lifecycle                              | Primarily Task/tool heuristics                                               | Prefer native lifecycle; mark heuristic fallback as inferred                              |
| History            | Canonical replay needs full ordered events                                 | Fleet persisted only summary rows                                            | Persist redacted canonical detail for 30 days; retain summaries until user deletion       |
| Installer          | Multiple config files/hooks can partially update                           | Best-effort install/uninstall                                                | Transactional install with backup, rollback, status diagnosis, and repair                 |
| Registry           | Agent capabilities evolve                                                  | Provider branching is distributed                                            | Schema-driven registry plus runtime-probed effective capabilities                         |
| Product surface    | Built-in, Team, Workflow, and external runs share execution authority      | Fleet showed external monitored sessions                                     | Unified projection with origin/runtime badges and controls limited to proven capabilities |
| External control   | ACP/Codex/OpenCode have explicit protocol controls                         | Some control assumptions depended on terminal/process shape                  | No terminal keystroke injection; expose only protocol- or runtime-proven controls         |

## Architectural decisions

1. The hook capability contract is versioned independently from a provider's marketing/version string. A runtime probe produces the effective contract; a static manifest is only a safe baseline.
2. Provider adapters translate native payloads into a canonical hook envelope, then call a shared semantic core for matching, policy, PII handling, diagnostics, audit, and budget enforcement.
3. A hook event has one execution owner per runtime path. Built-in Claude hooks belong to the SDK sidecar; external/provider hooks use their adapter path.
4. Fleet projections are rebuildable. Durable canonical events and command-audit rows are facts; snapshot/history rows are derived views.
5. Raw provider payloads are ephemeral. Durable and remote projections contain only allowlisted, redacted fields.
6. Migration is phased: dual-read where needed, canonical-write first, projection verification, then removal of retired writers.

## Primary sources

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Anthropic Claude Agent SDK TypeScript repository](https://github.com/anthropics/claude-agent-sdk-typescript)
- [OpenAI Codex repository](https://github.com/openai/codex)
- [Codex advanced configuration: hooks](https://developers.openai.com/codex/config-advanced/#hooks)
- [OpenCode repository](https://github.com/anomalyco/opencode)
