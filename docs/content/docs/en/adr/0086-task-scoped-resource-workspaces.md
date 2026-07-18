---
title: "0086 — Task-scoped resource workspaces"
description: "Isolated agent execution, an authoritative local patch ledger, and explicit review/apply/undo across Cognia runtimes."
---

# ADR 0086 — Task-scoped resource workspaces

## Status

Accepted behind `developer.taskWorkspace`; GA requires the runtime matrix below.

## Context

Cognia already has a Workspace Dock, project editor, Git review, Companion transport, external agents, and Agent Team worktrees. Agent writes were nevertheless observed through several partial mechanisms: tool events missed shell/compiler writes, desktop file watching did not cover headless hosts, and repository-wide discard could not distinguish agent, user, and external contributions.

## Decision

One user intent owns a `TaskWorkspace`; retries, continuations, and child agents are versioned `TaskRun`s. Every run executes outside the user's live root: a Git worktree for repository roots and a materialized shadow for non-Git roots. Unsafe isolation fails closed.

`cognia-task-workspace` is the transport-neutral implementation shared by Tauri and `cognia-server`. SQLite stores metadata and gzip-compressed SHA-256 content-addressed blobs in the execution host's app-data directory. Neither file bodies nor patches enter chat sync, telemetry, or resource events. The default retention is 30 days and the default blob budget is 1 GiB; pinned and unapplied tasks are not pruned.

Tool events are provisional hints. A debounced, ignore-aware watcher provides low-latency summaries, while settle-time snapshots are authoritative. Events are revisioned, bounded below 32 KiB, signal overflow/resync, and never contain file bodies. Reads are structured and bounded; transfers use verified chunks no larger than 24 KiB.

Settling creates forward and inverse patch data for files, symlinks, modes, binary replacements, deletes, creates, and renames. Applying is an atomic preflight plus three-way merge against baseline hashes. Files and text hunks are selectable. Undo applies only the recorded inverse contribution and conflicts rather than discarding unrelated live changes. Conflict resolution is explicit: retry merge, apply task bytes, or keep current bytes.

Sensitive paths expose locked metadata only. Each body read/download requires explicit authorization; Companion additionally requires the existing remote-control/service capability. HTML and SVG are sanitized for static preview. Explicit execution uses a script-enabled opaque iframe with network, clipboard, navigation, extra directories, and downloads denied by CSP/sandbox.

The existing Workspace Dock is the only product surface. It defaults to Current task when a task exists, restores persisted tasks by session, aggregates child runs while retaining run/agent attribution, and supports Source, Preview, Diff, file/hunk apply, exact undo, upload/download, and mobile review.

## Compatibility and rollout

The legacy `code_adoption` commands remain for one compatibility cycle, but persisted metrics are projected from authoritative agent-origin task resources when available. `fs_read_workspace_file` remains available; an unbounded editor read is no longer silently truncated, while task previews use the structured resource API.

The flag stays off until built-in chat, ACP/Codex/Claude/OpenCode, Agent Team, Tauri, Companion, headless, Docker, and Kubernetes PVC deployments pass the same DTO, permission, reconnect, isolation, and patch semantics. No second AgentServer or WebSocket protocol is introduced.

## Consequences

The execution host owns more local storage and background reconciliation work, but task attribution and reversibility no longer depend on Git cleanliness or tool-event completeness. Applying may be blocked when inverse data cannot be retained; this is preferable to presenting an operation as reversible when it is not.
