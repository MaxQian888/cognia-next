---
title: ADR-0033 — Integrated terminal Phase 3 — desktop UX (split panes, command navigation, reload restore, link-to-editor, locate-in-conversation)
description: "Phase 3 turns the integrated terminal into a primary development terminal. (1) VS Code-style flat split panes per tab, layered additively over the existing tab/session store. (2) The dead prompt-boundary decoration stub is reworked into real OSC 633 command markers with exit-code colouring + jump-to-command navigation. (3) Webview-reload session restore: the Rust process (and its PTYs) survive a reload, so a `SeqEvent` wire envelope + a swappable Channel slot + `terminal_reattach` rewire a fresh Channel and replay the retained buffer — reusing the `WsTerminalRegistry` consumer-swap pattern. (4) Clickable `path:line:col` terminal links open a read-only Monaco file viewer resolved against the session cwd. (5) Agent-spawned terminal tabs can jump back to the chat session that created them. WebRTC/mobile/server-side phases stay scoped out."
---

# ADR-0033 — Integrated terminal Phase 3

**Status**: Accepted (2026-05-23)
**Authors**: Max Qian + Claude Opus 4.7
**Supersedes**: extends ADR-0031 (does not replace it)
**Affects**: `stores/terminal/`, `components/terminal/`, `lib/terminal/`, `components/providers/initializers/terminal-bridge-initializer.tsx`, `src-tauri/src/terminal/{session,commands,mod}.rs`, `src-tauri/src/companion_api/ws_terminal.rs`, `src-tauri/src/lib.rs`, `i18n/messages/{en,zh-CN}.json`

## Context

ADR-0031 shipped a complete integrated terminal (xterm.js dock, `portable-pty` backend, OSC 633, mobile WS transport with a `seq` replay buffer, agent MCP tools, settings, i18n). Phase 3 closes the gap from "works" to "primary dev terminal", driven by the desktop-local-development use case. The hard constraint throughout was **maximum reuse, zero re-implementation** — every new file was audited against existing infrastructure before being written.

## Decisions

### D1 — Split panes as a flat, additive per-tab pane group

VS Code's *terminal* split is a flat row/column of panes, not the arbitrary nesting its editor uses. Modelling it as a flat group keeps the change additive and the existing tab/session store untouched.

`stores/terminal/terminal-store.ts` gains three maps keyed by a group **anchor** (the tab's session id): `splitPanes` (ordered extra pane ids beside the anchor), `focusedPaneByAnchor`, `splitDirection`. A session renders as a tab unless it is a non-anchor member of some group. New mutations: `addPaneToGroup` / `setFocusedPane` / `groupAnchorOf` / `panesForGroup` / `tabsForProject`. `removeSession` promotes the next pane to anchor when the anchor closes, so the group (and its tab) survives, and the active pointer follows. Pane **sizes** are persisted by the existing `hooks/ui/use-resizable-layout` hook (keyed per anchor) — not duplicated in the store.

`components/terminal/terminal-pane-group.tsx` renders the group via the existing `components/ui/resizable` primitives, reports the focused pane + its imperative handle to the dock so the search overlay / history rail / command-jump keys all target the focused pane. Keybindings: `Ctrl/Cmd+\` (split row), `Ctrl/Cmd+Shift+\` (split column), `Alt+Arrow` (move focus).

### D2 — Command navigation + exit-code decorations (reworked dead stub)

`terminal-instance.tsx` had a non-functional decoration effect: it registered a marker at the *current cursor line* inside a React effect (not where the command ran), only marked the last boundary, and never coloured by exit code. Phase 3 removes it and subscribes the instance to `session.onIntegration`: at `command_start` it registers an xterm marker + gutter decoration (neutral); at `command_end` it recreates the decoration coloured by exit code (green/red) — xterm decorations expose no recolour API, so recreation is the supported path. `lib/terminal/command-markers.ts` owns the pure `exitMarkerColor` + `prevMarkerLine`/`nextMarkerLine` maths; the instance handle gains `jumpToPrevCommand`/`jumpToNextCommand`, bound to `Ctrl/Cmd+↑/↓` in the dock. The store still receives the same events (via `spawn-orchestrator`) for the history rail — this listener owns only the in-terminal gutter.

### D3 — Webview-reload session restore

The Tauri Rust process — and thus every live `PtySession` — outlives a webview reload; only the JS `Channel` + the in-memory session registry are torn down. Phase 3 makes the desktop sessions resumable by **reusing the `WsTerminalRegistry` consumer-swap pattern** rather than inventing a new one:

- `session.rs` gains a `SeqEvent { seq, event }` wire envelope (the desktop Channel now carries seq, so the renderer knows the resume point) and a swappable `ChannelSlot { channel, last_seq }` on `PtySession`. The sink sends through whatever Channel is installed; `last_seq` dedupes replay-vs-live so each event reaches a given channel exactly once, and a failed send (dead channel after reload) leaves `last_seq` untouched so the event is replayed.
- `terminal_reattach(id, on_event, resume_from)` (`commands.rs`, registered in `lib.rs`) installs a fresh Channel and replays `replay.since(resume_from)`. **Lock-ordering safety**: the reader/waiter threads take the replay lock and the channel-slot lock *sequentially* (push → release → sink), never nested, so `reattach` can hold the slot lock while snapshotting `replay.since()` without deadlock — making the swap atomic w.r.t. the sink.
- The renderer (`lib/terminal/session.ts`) tracks `lastSeq` and exposes `TerminalSession.reattach(id, resumeFrom = 0)`. `resume_from = 0` replays the whole retained buffer (≤512 KiB / 5 min), which also restores recent scrollback into the fresh xterm.
- `lib/terminal/rehydrate.ts` runs on boot (`terminal-bridge-initializer`, Tauri-only): `terminal_list_all` → rebuild rows → `reattach` → `wireSessionToStore` → restore the validated UI layout. Sessions are not restored across a full app restart (the process is gone).

### D4 — Path / error links → read-only Monaco viewer

`lib/terminal/terminal-links.ts` is a pure matcher for `path:line:col`, tsc paren form, and V8 stack frames, plus cwd resolution. `terminal-instance.tsx` registers an xterm `ILinkProvider` (coexisting with `WebLinksAddon` for URLs); clicking resolves the path against the session cwd (tracked in the store) and opens `stores/terminal/file-viewer-store.ts`. `components/terminal/file-viewer-dialog.tsx` reads the file via the existing `lib/file/file-operations.readTextFile` and renders it in a read-only `@monaco-editor/react` editor, revealing the target line. It deliberately does **not** use `mountMonacoWorkbench` — a transient viewer must not register as the vscode-shim's active text editor and confuse LSP providers.

### D5 — Locate-in-conversation for agent terminals

Agent-driven terminal tabs already carry `agentSpawner` (the chat session id, set by `dock-tool-handler`). The tab context menu and history rail gain a "locate in conversation" affordance that calls `useChatStore.setActiveSession(agentSpawner)` (the proven pattern from `chat-header`'s fork action) and routes to the chat view. Message-level scroll is deferred — chat has no scroll-to-message infrastructure yet.

### D6 — `wireSessionToStore` extraction

The command-capture + integration→store + exit→store+audit wiring was inlined in `spawnFromDock`. Phase 3 extracts it to `spawn-orchestrator.wireSessionToStore` so a reattached session behaves identically to a freshly-spawned one, with no duplication.

### D7 — Reload-safe split-pane layout restoration

The persisted terminal shell now carries a reload-only metadata snapshot: split membership and order, orientation, focused pane, active tab per project, and custom titles. Live `TerminalSessionRow` objects remain in memory only. On hydration the snapshot is kept in `pendingReloadLayout`, separate from live state, so registering surviving PTYs one by one cannot overwrite the complete saved layout with a partial one.

After `terminal_list_all` has been fully processed, `rehydrateTerminals` applies the snapshot as one transaction. The store accepts only sessions that successfully reattached, rejects cross-project panes and duplicate group membership, falls back from stale focus/active ids, and then clears the pending snapshot. A successful empty Rust session list clears metadata left by a full app restart; a failed list call retains it because the IPC failure may be transient. Web and Capacitor clear the snapshot at initialization because their PTYs cannot survive a reload. Pane sizes continue to use the existing `useResizableLayout` persistence keyed by anchor id.

## Test coverage

Per-file co-located tests (CLAUDE.md rule #3): `terminal-store.test.ts` (split mutations + anchor promotion), `terminal-pane-group.test.tsx`, `command-markers.test.ts`, extended `terminal-instance.test.tsx` (markers, jump, link provider), `terminal-links.test.ts`, `file-viewer-store.test.ts`, `file-viewer-dialog.test.tsx`, extended `terminal-dock.test.tsx` (split / focus / locate), extended `terminal-tab-context-menu.test.tsx` + `terminal-history-panel.test.tsx` (locate), extended `session.test.ts` (`SeqEvent` envelope + `reattach`), `rehydrate.test.ts`. Rust: `session.rs` reattach replay + dedupe tests (`#[cfg(test)]`).

**305 frontend terminal tests pass; `pnpm build` / `pnpm typecheck` / `pnpm lint:i18n` green; `cargo check` clean.** The Rust unit tests are written but cannot execute on the Windows dev machine (Tauri test binaries fail to launch with `STATUS_ENTRYPOINT_NOT_FOUND` — a WebView2/runtime-DLL limitation, not a code defect; they run in CI). The real app binary launches fine.

## File summary

**Net-new**: `components/terminal/terminal-pane-group.tsx` (+test), `components/terminal/file-viewer-dialog.tsx` (+test), `lib/terminal/command-markers.ts` (+test), `lib/terminal/terminal-links.ts` (+test), `lib/terminal/rehydrate.ts` (+test), `stores/terminal/file-viewer-store.ts` (+test), this ADR (en + zh).

**Extended**: `stores/terminal/terminal-store.ts` (split layer), `components/terminal/{terminal-dock,terminal-instance,terminal-history-panel,terminal-tab-context-menu}.tsx`, `lib/terminal/{session,spawn-orchestrator}.ts`, `components/providers/initializers/terminal-bridge-initializer.tsx`, `src-tauri/src/terminal/{session,commands,mod}.rs`, `src-tauri/src/companion_api/ws_terminal.rs`, `src-tauri/src/lib.rs`, both i18n message files.

**Wire change**: the desktop terminal Channel now carries `{ seq, event }` (`SeqEvent`) instead of a bare `TerminalEvent`.

## Follow-ups explicitly scoped out

1. ~~**WebRTC WAN terminal transport**~~ — **shipped**; see ADR-0031 follow-up #1.
2. **Mobile OSC 633 delivery** — ADR-0031 follow-up #2, still deferred.
3. **Server-side workflow execution + consent bridge** — ADR-0031 follow-up #3.
4. ~~**AI command assistance** in the dock~~ — superseded by ADR-0039 (terminal autocomplete), which shipped.
5. ~~**Message-level locate-in-conversation**~~ — **shipped**: rows carry `agentSpawnerMessageId` and the dock routes through `messagePermalinkQuery` (ADR-0094 provided the scroll-to-message seam).

## Phase 4 — dock usability (this change)

Layered on top of the durable out-of-process host, which arrived after this ADR was written.

- **Host owns `PathInjection`.** The app's managed-CLI registry is an in-process
  static (`cli_bridge::detect`), so the separate host process cannot derive it.
  It now travels over the `Hello` frame and is stored on the host — not per
  connection, because remote spawns (Companion WS, WebRTC) arrive on connections
  that never send one, and sessions are host-owned anyway. Only a *local*
  identity may write it. Re-pushed when the in-app CLI download registers a new
  directory; already-running shells keep their old PATH (a PTY's environment is
  fixed at `execve`).
- **Frame kinds 21–23** — `FlowControl`, `HistoryQuery`, `HistorySnapshot`.
  `TransportState` (18), previously never constructed, now reports flow-control
  transitions. **Compatibility invariant: the host never volunteers a frame kind
  the client did not solicit**, because clients reject unknown discriminants
  outright. A new *pushed* kind must first be negotiated through the `Hello`
  ack's `protocolFeatures`.
- **Capability negotiation.** The bridge reuses an already-running host, which
  may be an older binary installed as a login service, so post-release commands
  gate on the advertised feature list and degrade with a clear error.
- **End-to-end flow control.** `FlowGate` (std `Mutex` + `Condvar`) parks the
  PTY reader thread, so unread bytes stay in the kernel buffer and the child
  blocks on write. Pauses are reference-counted across attachments
  (slowest-consumer-wins) and released on five independent paths — detach,
  disconnect, attachment overflow, kill, and a 30 s reaper for a client that
  paused and then stopped running. Before this, a flood overran the host's
  bounded per-client queue and the attachment was *dropped*: the tab went dead,
  not slow.

### Known next step

`Channel<HostSeqEvent>` serialises `bytes: Vec<u8>` as a JSON array of decimal
numbers — roughly 4× expansion plus a JSON parse per chunk, and the largest
constant factor in the flood path. Flow control makes the system correct; it
does not make it fast. Moving to a binary channel body is the follow-up.
