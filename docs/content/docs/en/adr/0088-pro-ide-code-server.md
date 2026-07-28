---
title: "0088 — Pro IDE (embedded code-server)"
description: "Ownership, layout and theming rules for the embedded code-server editor: one native webview owned outside React, handed off between hosts, painted from the app palette, and never destroyed by an unmount."
---

# ADR 0088 — Pro IDE (embedded code-server)

**Status:** Accepted
**Date:** 2026-07-21

> **2026-07-28 amendment:** the original companion channel described below was
> replaced by the [Managed IDE Extension Platform](../subsystems/managed-ide-extension-platform).
> The current design uses isolated managed/native profiles, JSON-RPC 2.0 with
> challenge authentication and capability negotiation, signed generated proxy
> VSIX packages, and a separate scoped binary content channel. The `0.2.x`
> newline bridge is compatibility-only for one release. Decisions about native
> webview ownership, pane handoff, theming, and process visibility remain in
> force.

## Context

"Pro IDE" is an optional embedded [code-server](https://github.com/coder/code-server)
(browser VS Code) that augments — never replaces — the Monaco project editor. The
first cut shipped the hard parts: a pinned, checksum-verified download
(`src-tauri/src/codeserver/download.rs`), a loopback child process per project
root (`process.rs`), a dedicated native child webview (`webview.rs`), and agent
file auto-follow through `lib/files/project-editor-bridge.ts`.

It was built as an *optional escape hatch*, but the product position is a
**first-class editor surface** — peer to Monaco, somewhere a user stays. That gap
produced a cluster of defects that share one root cause: **the pane was modelled
as a React component when it is really a native resource with a lifetime longer
than any component.**

Concretely, before this ADR:

- Leaving the Editor tab unmounted the pane, which destroyed the webview and
  rebooted the whole VS Code workbench — losing open editors, cursor, and
  terminals. The process survived; the *session* did not.
- `codeserver_stop` / `stop_all` / `status` / `download` had **zero** production
  callers. A code-server outlived every pane and could only be stopped by
  quitting the app, with no surface showing it existed.
- The Editor tab lived in a scrolling page at a fixed `70vh`. A native webview
  cannot follow DOM scroll, so the pane visibly tore.
- A crashed instance left a dead page pinned *above* the DOM, hiding the pane's
  own error and retry UI.
- The embedded editor was painted in stock VS Code colors inside a themed app.

## Decision

### 1. The webview is owned outside React

`lib/codeserver/pane-manager.ts` is the sole caller of the `codeserver_embed_*`
commands. React surfaces `claim` it and `release` it; they never create or
destroy it.

- `release` (unmount, tab switch, route change) **parks the webview off-screen
  and drops ownership. It does not destroy.** The next claim re-shows the same
  live VS Code.
- `destroy` is reserved for an explicit stop or app teardown.
- Every native round-trip is serialized through one promise chain. Create,
  navigate and `set_bounds` against a single webview must not interleave, or a
  late `create` resurrects a webview a concurrent `release` just parked.

**Consequence:** a live VS Code webview stays resident while the user is
elsewhere in the app. That is the price of not losing editor state, and it is
why decision 3 exists.

### 2. Two hosts, one pane, explicit handoff

`CODESERVER_EMBED_LABEL` is a singleton (one child webview of the main window),
but two surfaces host a project editor: the Agent Team workspace Editor tab and
the chat-side workspace dock. Claiming from a second host **revokes** the first,
which falls back to Monaco. There is no split-brain and no second webview.

The engine choice is persisted per scope in `project-editor-session-store`, and
the switch itself is one shared component (`editor-engine-toggle.tsx`) so the
two hosts cannot drift.

### 3. Process lifecycle belongs to the shared registry; install does not

Running instances are rows in the unified managed-process registry
(`src-tauri/src/process_registry/`), exactly like the chat sidecar, MCP server
and terminals — so the performance panel's Managed Processes tab lists them with
live CPU/memory and a kill button. `ManagedSubsystem::CodeServer` routes control
on the **canonical project root**, which is also the instance key. code-server is
the only subsystem that supports native `Restart` (stop + re-ensure), because it
has no renderer-side state to keep in sync.

Install state is a different concern and gets its own home: **Settings → Pro
IDE** owns the pinned version, disk footprint, pre-fetch, stale-version cleanup
and full uninstall.

### 4. A native overlay dictates layout and motion

The webview floats above the DOM. It cannot be clipped, covered, or tweened by
CSS, and its bounds are re-pushed over IPC roughly once per frame. Three rules
follow, and they are not stylistic:

- **The host must not scroll.** The Editor tab gets the same full-height
  treatment as chat (`overflow-hidden` + `min-h-0 flex-1`). A scrolling page
  makes the pane tear.
- **Animated ancestors are collapsed, not compensated.** While a surface holds
  the pane, `html[data-pro-ide-active]` reduces the sidebar shell transitions to
  1ms (`app/globals.css`). Letting a 200ms transition run would force VS Code to
  relayout on every frame of it. 1ms rather than 0 matches the existing
  reduce-motion guards so `transitionend` still fires.
- **Anything the user must read requires parking the pane.** Effective
  visibility is `region visible && phase === "ready"`. Without this, a crashed
  instance covers its own retry button.

### 5. Theming rides `workbench.colorCustomizations`, not a theme extension

The app palette is projected into code-server's `settings.json`. VS Code's
`WorkbenchThemeService` watches that file and re-applies through
`updateDynamicCSSRules()` with **no window reload**, and the setting accepts the
full Theme Color reference set.

A generated theme *extension* was considered and rejected: extensions are
discovered at startup, so every palette change would need a reload — which
destroys the session decision 1 exists to protect — and it buys nothing the
settings key does not already provide.

Two further rules:

- The color map is **not hand-authored**. It is the inverse of
  `lib/appearance/vscode-theme/token-mapping.ts`, the same curated table the
  VS Code theme *importer* uses. One table, both directions.
- Syntax colors are left to the base theme (`workbench.colorTheme`), mirroring
  how the Monaco counterpart (`lib/canvas/themes/cognia-active-theme.ts`)
  inherits its base theme's `tokenColors`. We own the chrome only.

Writes are read-merge-write over the user's file, so settings they make from
inside VS Code survive. Comments do not survive the round-trip.

### 6. Threat model: loopback + `--auth none` is accepted, and why

code-server runs on an ephemeral loopback port with `--auth none`. This was
audited against upstream rather than assumed:

- `--auth none` still runs `authenticateOrigin` (since 4.10.1): the `Origin`
  header must match `Host`. Browser-originated CSRF / DNS-rebinding is therefore
  already blocked.
- A request with **no** `Origin` header skips the check entirely. The residual
  exposure is other local processes and other local user accounts — not web
  pages.
- `--trusted-origins` was proposed and **rejected**: it only ever *adds* allowed
  origins on top of the default `Origin == Host` rule. It cannot tighten
  anything, and it cannot reach the no-Origin case at all.
- `--auth password` is not usable for an embedded pane: code-server supports no
  URL token or pre-set cookie, only an interactive login page.

Accepted position: on a single-user desktop, a process running as the user
already has the files and can run code, so code-server adds no new authority
against that adversary. **Multi-user machines are not covered.** The only fix
that reaches them is decision 6's rejected alternative below.

## Alternatives considered

**Unix socket + a token-bearing loopback proxy.** `--socket` / `--socket-mode`
would cut the exposure down to filesystem permissions, but a webview cannot
navigate to a unix socket, so it needs a proxy that correctly forwards the
WebSocket upgrades VS Code depends on heavily. Real work, subtle failure modes;
recorded as debt rather than done half-way.

**A separate OS window instead of an embedded pane.** Sidesteps every
native-overlay constraint in decision 4, but abandons the premise that the editor
sits beside the agent in one workspace.

**A companion extension over a loopback WebSocket.** Superseded by the managed
broker. The implemented transport is plain loopback TCP with JSON-RPC
`Content-Length` framing; it avoids a WebSocket handshake because both endpoints
are native processes on the same host.

## Consequences

- Switching tabs or routes keeps the VS Code session. The cost is a resident
  webview, made visible and killable by decision 3.
- `codeserver_open_file` still shells out to `code-server --reuse-window`, i.e. a
  Node cold start per jump (~0.5–2s). A last-write-wins debounce with
  single-flight serialization keeps agent auto-follow from launching a process
  storm and from chasing stale targets.
- A health watchdog polls `/healthz` and emits `codeserver://instance-exited`
  after two consecutive misses (~10s), so a crash surfaces as a retryable error
  instead of a dead page. Its task handle is stored on the instance and aborted
  on every retirement path — a detached poll loop would outlive its process and
  hang `cargo test`.

## Known debt

- **The native ecosystem is intentionally separate.** Open VSX extensions run
  only in Native Extensions IDE. Managed proxies are generated from Cognia
  plugins and never accept third-party entrypoints. Sharing extension state or
  credentials across those trust domains remains explicitly unsupported.
- **Pinned Code upgrades remain a release operation.** The managed platform
  now has signed, transactional plugin/proxy updates, but changing
  code-server/Code itself still requires archive digest refresh, catalog/schema
  diffing, regenerated fixtures, and the full E2E matrix.
- **Multi-user machine exposure**, per decision 6.
- **`components/ui/progress.tsx` never forwards `value` to the Radix root**, so
  every `<Progress>` in the app reports itself as indeterminate to assistive
  tech. Pre-existing and repo-wide; the download bar renders correctly but is not
  announced.
