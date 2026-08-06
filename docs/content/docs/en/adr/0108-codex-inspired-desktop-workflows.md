---
title: ADR-0108 — Codex-inspired desktop workflows
description: "Durable chat execution contexts, project environments, unified review, controlled browser development, and inspectable agent threads."
---

# ADR-0108 — Codex-inspired desktop workflows

**Status**: Accepted (2026-08-06)

## Context

Cognia already owns the Guild/DM/Team/Canvas shell, terminal, scheduler, browser annotations, Computer Use, Job Center, skills, plugins, MCP, notifications, subagents, Git UI, and the task-scoped resource model in ADR-0086. Compared with the current Codex desktop workflows, the missing product paths were durable chat-bound worktrees, one review-to-PR flow, project-local setup environments, temporary browser adjustment and controlled CDP access, faster task entry, and a global view of hidden agent threads.

## Decision

ADR-0086 remains authoritative for isolation, snapshots, patches, conflicts, undo, pinning, pruning, and 30-day retention. A `SessionExecutionContext` binds one persisted chat to Local or one managed Task Workspace identity. Repeated and scheduled turns reuse that identity; scheduled managed execution and environment setup fail closed. Local-to-Worktree handoff previews the dirty baseline, `.worktreeinclude` is an explicit secret-aware allowlist, and non-Git roots use the existing shadow-isolation fallback. Historical restoration reconstructs the selected settled run and refuses to race a live child run.

`ProjectEnvironment` definitions are device-local. They contain OS-aware setup scripts and reusable actions, non-sensitive variables, and opaque references to Cognia's existing OS keyring. Secret values are resolved only in Rust, injected only into the child process, and redacted before IPC. Setup runs inside the final Local or managed execution root. Interactive runs may explicitly bypass one failure; scheduled runs never bypass.

The review boundary is provider-neutral. Review scopes are last turn, uncommitted changes, one commit, or a branch comparison across selected roots. Comments have SHA-256 content identity and stale anchors fail closed. Existing hunk controls remain authoritative for accept, reject, stage, and comment. An editable `ReviewFeedbackBundle` is published as one review. `PullRequestProvider` keeps GitHub as the first adapter and preserves authentication, lookup, commit/push, draft creation, rejection, and recoverable offline states.

Browser Adjust applies a temporary live preview and always reverts on cancel, navigation, unmount, or acceptance; acceptance emits structured feedback rather than mutating the page permanently. CDP authority is local-Tauri-only and bound to the Cognia task, embedded-browser session, exact origin, capability set, and expiry. Both renderer and native gates must approve every command. Grant, use, rejection, revocation, and expiry metadata are append-only and exclude request bodies, response bodies, query strings, and secrets. Remote, Companion, cloud, and web targets are denied.

Project pinning and recency augment, rather than replace, Cognia's workspace switcher. Quick Chat uses the existing Cmd/Ctrl+N entry and creates an ordinary persisted task inheriting the active project's primary root and default environment. The global Agent thread browser projects hidden subagent sessions under their lineage. Opening navigates across project and task; promoting a completed child creates a new primary snapshot through existing branch semantics. Live ownership is never transferred, and a running child cannot be promoted.

The Dexie environment, CDP grant, and CDP audit tables are explicitly omitted from sync, export, backup, and device-clear surfaces. Non-Tauri platforms may inspect durable chat/review data but cannot execute local environments, managed native operations, or CDP commands.

## Consequences

- Cognia keeps one task isolation and patch ledger instead of building a Codex-shaped duplicate.
- Setup and CDP secrets never enter renderer persistence or cross-device sync.
- A chat, scheduled run, terminal, review, and restoration operation agree on one execution root.
- GitHub-specific behavior is replaceable without weakening the shared review contract.
- The desktop shell gains the missing workflows without visually cloning Codex.

## Verification

Co-located TypeScript/RTL and Rust tests cover durable binding and reuse, dirty and non-Git handoff, cumulative apply/conflict/undo/restore, environment retry and scheduled no-bypass, review scopes and provider failures, Browser Adjust reversion, CDP grant isolation and audit, project pinning/Quick Chat, and nested agent promotion guards. Authenticated Playwright paths and a real Tauri smoke run exercise the native command registrations and permission allowlist.
