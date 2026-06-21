---
title: ADR-0050 — Agent CLI TUI operation-experience hardening (editing chords · dead-command wiring · documentation)
description: "Document the cognia-agent Ink TUI as a first-class subsystem and harden its operation experience: add readline-style line kills and word motion to the composer, wire the advertised-but-dormant /permissions remove command, refuse conflicting keybinding rebinds, and complete missing argument hints — high-certainty fixes only, no cursor/undo/overlay rewrites."
---

# ADR-0050 — Agent CLI TUI operation-experience hardening

**Status**: Accepted (2026-06-20)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: the `cognia-agent` standalone agent (`cli/`), the new [Agent CLI TUI](../subsystems/cognia-agent-tui) subsystem page, and ADR-0026 (builtin skills & lark-cli bridge).

## Context

The `cognia-agent` interactive TUI (`cli/src/tui/`, ~175 source files: a pure
reducer, a slash-command system, 20 runtime controllers, 13 overlays, a
markdown/mention/theme layer, and a readline-style composer) has grown into a
mature subsystem, yet two gaps remained:

1. **It was undocumented.** The `subsystems/cognia-cli` section documents the
   *Rust plugin-author* CLI (`crates/cognia-cli`); the TypeScript agent TUI had
   no subsystem page or ADR, and `cli/README.md` still described the interactive
   TUI as a "later phase."
2. **A part-by-part review of the operation experience** surfaced a small set of
   high-certainty defects in the composer and command wiring. Many findings from
   the initial sweep were false positives (the status bar already shows the
   permission mode with a `bypassPermissions` warning; the markdown layer already
   has full CJK width handling; most `argumentHint`s already exist), so this ADR
   records only the **verified** changes and the ones deliberately **declined**.

## Decisions

### 1 · Readline-style line kills and word motion in the composer

The composer only bound `Ctrl+A/E` (line start/end) and `Ctrl+W` (delete word
left). Coming from bash/zsh/readline, users expect more. Added, as pure
`buffer.ts` ops driven by pure `keymap.ts` intents:

- `deleteToLineStart` (**Ctrl+U**) and `deleteToLineEnd` (**Ctrl+K**) — registered
  as the rebindable actions `lineKillToStart` / `lineKillToEnd`, so they show in
  `/keybind` and merge with user overrides like the existing chords.
- `moveWordLeft` / `moveWordRight` — bound to **Ctrl+←/→** (and Alt+←/→). When the
  terminal does not send the modifier with the arrow, the keymap degrades
  gracefully to a single-column move, so there is no regression on minimal
  terminals.

### 2 · Wire the advertised-but-dormant `/permissions remove`

`permissionsRemove()` was fully implemented and **its own report text told users
to run `/permissions remove <tool>`**, but the command was never wired: there was
no `remove` subcommand, and the runtime router silently fell through
`req.action === "remove"` to `permissionsList`. Added the `remove` subcommand
(with a `<tool>` hint) and routed it to `permissionsRemove(pd, req.arg)`. This
turns a misleading dead command into a working one.

### 3 · Refuse conflicting keybinding rebinds

`findKeybindingConflicts()` existed but was never called. `/keybind <action>
<key>` now computes the post-rebind table and **refuses** a spec that collides
with another action's key, naming the conflict and how to resolve it — instead of
letting the first action in `KEYBINDABLE_ACTIONS` silently win the shared key.
Rebinding an action onto its own current key is still allowed.

### 4 · Complete the genuinely-missing argument hints

Added `argumentHint`s that were actually absent — `/mcp enable|disable|toggle
<name>` and `/plugin show|enable|disable <id>` — so the inline command hint guides
these subcommands like their siblings already do.

## Explicitly declined (out of scope by design)

These were considered and **not** done, to keep the change high-certainty and
regression-free:

- **`Del` as forward-delete.** Splitting `key.backspace || key.delete` looks
  correct but is unsafe: many terminals report the **Backspace** key as
  `key.delete` (raw `0x7F`), so treating `key.delete` as forward-delete would
  break Backspace. The conflation is kept intentionally and documented.
- **Width-aware cursor rewrite, composer undo/redo, and an overlay back-stack.**
  Each is a larger, higher-risk refactor (the buffer indexes by UTF-16 offset, not
  display column; overlays are a single active slot by design). Deferred rather
  than rushed.

## Consequences

- The composer reaches readline parity for the common editing chords; the
  permission surface is fully controllable from the CLI; `/keybind` can no longer
  create a silent conflict; and partial subcommands all hint their arguments.
- The TUI is now a documented subsystem with this ADR and a subsystem page,
  correcting the stale "later phase" framing.
- All changes are pure-function or thin-wiring additions with co-located tests;
  no desktop, sidecar, or Rust code is touched.

## Verification

`pnpm cli:test` (touched suites green, including new buffer/keymap/keybinding/
command/runtime cases), `tsc --noEmit` clean for `cli/`, and the new pure ops are
unit-tested for both the in-line and cross-line cursor cases.

## Follow-up — iteration 2 (rendering, usage truthfulness, long-task visibility)

A second pass extended the same "find the dormant data, wire it, keep it pure"
approach across rendering and usage:

- **Live API rate limits (A1).** The sidecar's `fetch-interceptor` already emitted
  every `anthropic-ratelimit-*` header as a `usage_headers` message that nothing
  consumed. `useAgentSession` now folds it (via the pure `format/rate-limits.ts`)
  into `state.rateLimits`; `/limits` shows a live "API rate limits" block and an
  opt-in `ratelimit` footer segment summarizes the tightest remaining headroom.
- **Long-task budget/step (B1).** `driven-turns` now fills `ActivityState.max`
  (loop `--n` / goal `maxTurns`) and a `note` (run-scoped token total + an interval
  loop's cadence), so the activity pill shows a determinate bar and live budget.
- **Undo/redo (C1).** *Supersedes the iteration-1 deferral.* Implemented as a
  reducer-owned undo/redo stack that snapshots the buffer **only on text change**
  (cursor-only moves don't snapshot); `Ctrl+Z`/`Ctrl+Y` are rebindable
  (`KEYBINDABLE_ACTIONS` → 13). The width-aware cursor rewrite and overlay
  back-stack remain deferred.
- **Cost trend + SDK context (A2).** `/usage` adds a per-turn cost sparkline
  (`state.costHistory`, shared `turnCostUsd`). `/context` now routes through the
  runtime to append the SDK's authoritative live breakdown via a new
  `getContextUsage` control round-trip — the CLI sidecar protocol gained a
  `control`/`control_response` message pair (the desktop already had it).
- **Inline images (D1).** Tool results carrying base64 image blocks render inline
  on graphics-capable terminals (`format/terminal-graphics.ts`, now with kitty
  chunking) or as a compact placeholder, instead of a base64 wall
  (`format/result-images.ts` extracts + elides).

All additions keep the pure-core + thin-wiring shape with co-located tests; no
desktop, Rust, or sidecar code changed (the sidecar's `control` handler already
existed). The lone pre-existing `App.test` permission-overlay timeout is unrelated.
