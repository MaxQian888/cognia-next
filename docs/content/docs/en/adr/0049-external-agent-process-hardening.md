---
title: ADR-0049 — External-agent process management hardening (Windows launch · event-driven IO · shutdown cleanup · Codex liveness)
description: "Harden the native external-agent process layer and its TypeScript lifecycle for correct full-chain loading/startup: resolve commands against PATH × PATHEXT so Windows .cmd/.bat shims (npx, opencode, cursor-agent) actually launch, complete the migration to event-driven stdout/stderr/exit forwarding, kill agent processes and ACP terminals on app exit instead of orphaning them, stop leaking released-terminal children, and give the Codex app-server adapter an active health probe."
---

# ADR-0049 — External-agent process management hardening

**Status**: Accepted (2026-06-20)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: ADR-0048 (Codex support expansion; ACP execution fidelity), the external-agent subsystem (`lib/ai/agent/external/`, `src-tauri/src/external_agent/`), and the documented five-stage spine (normalize → connect → session → execute → translate).

## Context

The external-agent subsystem (ACP / OpenCode / Codex app-server adapters, the
manager spine, presets, readiness ladder, env-builder) is mature: the TS side
owns all protocol parsing and the Rust side is a thin stdio bridge. A full-chain
review of **process management, loading, and startup** — with the native
process layer mid-refactor from a 50 ms polling drain-loop to an event-driven
sink — surfaced five concrete defects. None are in the protocol logic; all are
in the launch / lifecycle plumbing.

## Decisions

### 1 · Resolve commands against PATH × PATHEXT before spawning (the headline fix)

`tokio::process::Command::new("npx")` on Windows only auto-appends `.exe`; it
does **not** consult `PATHEXT`. Every executable preset launches a bare command
that on Windows lives as a `.cmd` shim (`npx -y @zed-industries/codex-acp`,
`opencode serve`, `cursor-agent`), so the spawn failed with "program not found"
— while `check_command_exists`, which *did* check `.cmd`, reported the preset
`executable`. Readiness and spawnability disagreed across the whole chain.

New `src-tauri/src/external_agent/command_resolver.rs` resolves a bare command
to a concrete path (PATH × `PATHEXT`, default `.COM;.EXE;.BAT;.CMD;.PS1`).
`process.rs` and `terminal.rs` resolve before `Command::new`; Rust ≥ 1.77.2 then
executes the resolved `.cmd`/`.bat` correctly (BatBadBut hardening). The bare
name is returned unchanged on Unix (no `PATHEXT`; `Command` already PATH-searches)
and when nothing is found (the spawn surfaces its own error). `check_command_exists`
is reimplemented on top of the **same** resolver, so a preset reported
`executable` is now one that will actually spawn.

### 2 · Event-driven stdout/stderr/exit (complete the migration)

The 50 ms poll loop (`receive_external_agent_stderr` + a per-tick manager lock)
is removed. Each process gets stdout/stderr reader tasks that push lines to an
`ExternalAgentEventSink`, plus one supervisor task that awaits the child (or a
`oneshot` kill request) and pushes the exit event — the single source of exit
truth. The Tauri command layer's `TauriEventSink` emits
`external-agent://{stdout,stderr,exit,state-change}`. The manager state drops its
outer `Mutex` (the manager is already internally synchronized), so spawn/send/
kill/status no longer serialize against each other.

### 3 · Kill agent processes and ACP terminals on app exit

The `RunEvent::Exit`/`ExitRequested` handler cleaned the CLI bridge and CUA
sandbox but not external agents, orphaning auto-spawned `opencode serve` / `npx`
children and their ACP terminals. The handler now `block_on`s
`ExternalAgentState::kill_all()` and the new `AcpTerminalManager::kill_all()`.

### 4 · `kill_on_drop` on ACP terminals

`process.rs` set `kill_on_drop(true)`; `terminal.rs` did not, so releasing a
still-running terminal leaked the child (and its reader tasks). `terminal.rs`
now sets it too — releasing or dropping a terminal reaps the child, which closes
stdout/stderr and lets the reader tasks end.

### 5 · Active liveness probe for the Codex app-server adapter

`CodexAppServerAdapter` inherited the base `healthCheck()` (returns the cached
connection flag), so a wedged-but-not-exited server stayed `connected` forever
and the manager's health timer never reconnected it — unlike ACP (`ping`) and
OpenCode (`config.get()`), which round-trip. Codex now overrides `healthCheck()`
to round-trip a cheap, side-effect-free `model/list`: any reply — including a
JSON-RPC *error* response — proves the server is processing messages (healthy);
only a request timeout or a torn-down transport is unhealthy.

## Out of scope

- Hardening the `node` spawn sites in `claude/sidecar.rs` and `mcp_server/*`
  with the same resolver. They resolve `node.exe` reliably today; folding them in
  is a separate, broader change with its own blast radius.
- PATH augmentation for project-local CLIs (`node_modules/.bin`). Presets target
  PATH-installed tools; local installs remain the user's responsibility.

## Consequences

- Windows users can launch every executable ACP/Codex preset; readiness no longer
  lies. Verified by `cargo test --lib external_agent` (incl. a Windows-gated
  `.cmd`-resolution test) and the Codex `healthCheck` jest suite.
- No process or ACP terminal survives app exit.
- The Rust process layer has no polling loop and no hot-path manager lock.
