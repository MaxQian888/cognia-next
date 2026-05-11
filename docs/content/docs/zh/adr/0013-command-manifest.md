---
title: "0013 — Companion API Command Manifest"
description: "Explicit, hand-written allowlist of Tauri commands exposed to mobile clients via /api/v1/_rpc — picked over codegen/macro alternatives because the mobile API surface is a curated subset, not a 1:1 mirror of every Tauri command."
---

# ADR 0013 — Companion API Command Manifest

**Status:** Accepted
**Date:** 2026-05-08
**Branch:** `feat/mobile-m1-foundation`
**Related issues:** [#34](https://github.com/MaxQian888/cognia-next/issues/34) (M2.2)
**Predecessor:** [ADR 0012 — Transport Abstraction](./0012-transport-abstraction.md)

---

## Context

ADR 0012 introduced a `Transport` interface so frontend wrappers can swap
between Tauri IPC (desktop) and HTTP/WS (mobile companion). The next
question: **how does the desktop's axum server know which Tauri commands
to expose, and how do TS callers stay in lockstep with the Rust route
table?**

Today `src-tauri/src/lib.rs` registers **200+ commands** through one
`tauri::generate_handler!` macro. Naively mirroring them all into the
RPC router would:

1. Expose desktop-only / dangerous commands (tray manipulation, wallpaper
   writes, system-scheduler elevation, native log directory access) to
   any paired phone — a real security regression.
2. Bloat the API surface to the point where security review is impractical.
3. Conflate "internal Tauri ergonomics" (ad-hoc commands the desktop UI
   spawns for one-off interactions) with "stable mobile-facing API"
   (what we'd publish in the OpenAPI spec for V2 cloud deployment).

Mobile actually needs ~30-40 of those 200+: chat send/interrupt, agent
config IO, skill CRUD, MCP testing, subscription credential CRUD,
settings read/write. The rest are desktop-internal.

## Decision

**Hand-written explicit allowlist in Rust.** Skip codegen, skip macros.

The companion API surface lives in
`src-tauri/src/companion_api/commands.rs` as a single match statement
that dispatches on command name. Each arm is a thin shim that calls the
existing Tauri command's underlying function (the `#[tauri::command]`
annotation only registers the IPC binding — the function body is callable
from any other Rust caller).

Rationale:

1. **The allowlist IS the API.** Every command exposed to mobile shows up
   here. No drift risk, no surprise exposure — adding a new mobile-facing
   command is an explicit, auditable PR. Removing one is a one-line delete.
2. **Security review is bounded.** Reviewers see ~40 entries, not 200.
3. **Per-command shape control.** Some Tauri commands have ergonomic
   payloads that don't translate cleanly to JSON (e.g., they take
   `tauri::State` or `tauri::AppHandle`). The shim layer normalizes the
   request payload before calling through.
4. **Versioning lives in the URL prefix (`/api/v1/`), not in Rust types.**
   The hand-written shim is the only thing that has to be backward-compatible
   when V2 reshapes some inputs — the underlying Tauri command can evolve
   freely.
5. **No build-time tooling.** No new generator script, no syn-style parsing,
   no maintainability burden for cargo-watch hot reload, no CI cliff.

### What was rejected

- **Option B — codegen from TOML/YAML manifest into Rust + TS.** Solves
  drift well but adds a build step, a generator script, and a "where is
  the source of truth?" mental tax. Worth it for 200+ commands, not for 40. Reconsidered if the API surface ever crosses ~150 commands.
- **Option C — Rust macro emits TS shim.** Macro complexity hurts more
  than the typo risk it prevents. Also one-way (Rust → TS), so it can't
  validate that a TS wrapper has a corresponding shim.
- **Option D — mirror all 200+ commands.** Security regression, see Context.

## Consequences

**Win:**

- Explicit security perimeter. Adding a command to the mobile API requires
  someone to write 5-10 lines in `companion_api/commands.rs` — no
  accidental exposure via "I added a Tauri command and forgot it ended up
  on the phone."
- Each shim is the natural place for per-command rate limits, idempotency
  keys, or auth-scope checks if those ever go beyond the global middleware.
- M2.5 (the `/api/v1/_rpc/<name>` route table) is a thin axum router whose
  match arms one-to-one mirror this file. Reviewers can read both side by
  side.

**Cost:**

- Adding a mobile command is a two-place edit (Tauri command + companion
  shim). Acceptable: the second edit is the API contract, not duplication.
- TS `transport.call(name, args)` calls have to know the command name as a
  string literal. M2 ships them inline; if maintenance pain emerges,
  M3-or-later can add a thin `CompanionApi` typed wrapper that exports
  named functions for each entry — but the manifest itself stays
  hand-written.
- A drift-detection CI test is **not** added in M2. The allowlist is small
  enough that PR review catches drift; if the surface grows past ~80
  commands we revisit with a parity test that reads both lists and diffs.

## Skeleton (lands in M2.5)

```rust
// src-tauri/src/companion_api/commands.rs
//
// Allowlist of Tauri commands the desktop exposes to paired mobile
// clients via POST /api/v1/_rpc/<name>. Each arm dispatches to the
// existing Tauri command's underlying function. Adding a new entry is
// a two-place edit: implement the Tauri command, then add the shim
// here. PR review enforces the allowlist; no codegen.

pub async fn dispatch(
    name: &str,
    args: serde_json::Value,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, RpcError> {
    match name {
        "claude_send" => claude::commands::claude_send(/* ... */).await,
        "claude_interrupt" => claude::commands::claude_interrupt(/* ... */).await,
        "claude_approve" => claude::commands::claude_approve(/* ... */).await,
        // ... ~30-40 entries total for V1 ...
        unknown => Err(RpcError::UnknownCommand(unknown.to_string())),
    }
}
```

The TS side stays as it is today: each wrapper module
(`lib/claude/ipc.ts`, `lib/external-bridge/tauri-control.ts`, etc.)
exports named functions that call `transport.call("snake_case_command", args)`.
The transport routes to Tauri IPC on desktop or `/api/v1/_rpc/snake_case_command`
on mobile. Both eventually hit the same Rust function — desktop via
Tauri's invoke pipeline, mobile via the `dispatch` match statement.

## What's next

M2.3 adds `POST /api/v1/auth/pair`, M2.4 adds the JWT verifier middleware,
and M2.5 fills out the `dispatch` match statement above with ~30-40 entries
covering the V1 mobile feature set. M2.6 adds the WS event channel; M2.7
ships the real `CompanionTransport` on the TS side.

## References

- ADR 0012 — Transport Abstraction
- M2 issue chain: [#33](https://github.com/MaxQian888/cognia-next/issues/33)
  → [#34](https://github.com/MaxQian888/cognia-next/issues/34)
  → [#35](https://github.com/MaxQian888/cognia-next/issues/35) ‖ [#36](https://github.com/MaxQian888/cognia-next/issues/36)
  → [#37](https://github.com/MaxQian888/cognia-next/issues/37) ‖ [#38](https://github.com/MaxQian888/cognia-next/issues/38)
  → [#39](https://github.com/MaxQian888/cognia-next/issues/39) ‖ [#40](https://github.com/MaxQian888/cognia-next/issues/40)
- Existing handler list (200+): `src-tauri/src/lib.rs` `tauri::generate_handler!`
