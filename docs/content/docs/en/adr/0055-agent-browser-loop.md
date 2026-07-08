---
title: ADR-0055 — Agent browser loop
description: "Give the product agent a snapshot→act-by-ref→re-snapshot browser loop over the existing embedded /browser webview (navigate, accessibility-tree snapshot with stable refs, click/type/fill/select/hover, console + network inspection, screenshot), exposed as gated plugin tools. Phase 1 drives the in-app embedded webview via injected JS for a shared human+agent pane; Phase 2 is guidance-based — a URL trust-tier router flags public origins untrusted and steers the model to the separately-attached Playwright MCP tools (mcp__playwright__*) for robust public-site automation, since a renderer plugin cannot transparently invoke external MCP tools."
---

# ADR-0055 — Agent browser loop

**Status**: Accepted (2026-06-25)
**Authors**: Max Qian + Claude

## Context

The in-app browser (`/browser`) shipped as a passive, human-facing design-feedback
tool: it previewed a local dev server, let a person click one element to grab its
CSS selector / `outerHTML` / text, write a comment, and ship that into chat. Every
browser operation was UI-only — the agent could not navigate, read, or act on the
page. The model's only web abilities were a separate HTTP-only track
(`web_fetch` / `web_search`, no JS rendering) and coordinate-based OS
`computer-use`, which cannot see the embedded webview's DOM.

The state of the art for agent browsers (Playwright-MCP, chrome-devtools-MCP, and
Codex's own in-app browser) converged on a common model-facing design: the model's
primary "view" is a **structured accessibility-tree snapshot, not pixels**;
elements are targeted by **opaque handles minted in the snapshot** (`ref` / `uid`),
never raw coordinates by default; the loop is **snapshot → act-by-ref →
re-snapshot**; console + network are first-class read-only tools.

## Decision

Add a `snapshot → act-by-ref → re-snapshot` browser loop for the agent, **hybrid
and phased**:

- **Phase 1 (this ADR) — embedded engine.** Drive the existing embedded webview
  via injected JS. This preserves the shared, human-visible co-driven pane (the
  differentiator), ships at 0 MB, and works on all three desktop OSes. Public-site
  automation is best-effort only.
- **Phase 2 — guidance to the Playwright MCP.** Reuse the existing
  `playwright-mcp` preset (the `plugins/playwright-mcp` preset already exists) for
  robust arbitrary-public-site automation. This is **guidance-based, not a second
  engine**: a renderer plugin can only invoke its _own_ registered tools
  (`invokePluginTool` enforces `tool.pluginId === pluginId`); the external MCP's
  `mcp__playwright__*` tools live in the sidecar and are reachable only by the
  model's own tool-call loop, so transparent in-process delegation is infeasible.
  Instead the trust-tier router flags public origins `untrusted`, and both the
  `browser_navigate` result `hint` and the `browser-tools:availability` context
  steer the model to call `mcp__playwright__*` directly when that server is
  attached. Zero extra footprint over the preset.

Shared-view fidelity and full CDP power are mutually exclusive on macOS/Linux:
driving our own embedded webview caps us at injected-JS capability but keeps the
human in the loop; a separate headless Chromium gives full CDP but is invisible.
Phase 1 takes the embedded path; Phase 2 hands public-site work to the Playwright
MCP where it pays.

## Architecture

```
agent tool call ──► plugins/browser-tools (registerTool ×N)
                        │  validates args, builds the call
                        ▼
                 lib/browser/agent-engine.ts ── routeEngine(urlTrustTier)
                    └─ EmbeddedEngine → browserClient → src-tauri/src/browser  [injected JS]
                         │
       (public origin) ──┴─► untrusted flag + hint ──► model calls mcp__playwright__*
                                                       (sidecar MCP, Phase 2 guidance)
```

- **Trust tier** (`resolveTrustTier`): `localhost` / `127.0.0.1` / `::1` =
  **trusted → embedded pane**; any other `http(s)` = **public**. The embedded
  engine is the only in-process backend; for public origins it runs best-effort
  with an explicit `untrusted` flag and the model is steered (via the navigate
  `hint` + availability context) to the `mcp__playwright__*` tools instead.
- **Canonical snapshot schema** (`lib/browser/protocol.ts`: `BrowserSnapshot`,
  `SnapshotNode`, `BrowserActionResult`, `ConsoleEntry`, `NetworkEntry`) is emitted
  by the embedded engine; the Playwright MCP keeps its own native snapshot shape,
  so the two surfaces are distinct tool families the model picks between by tier.

### Page → Rust channel

The previewed page is a remote context with no IPC bridge. The key enabler is
Tauri 2.11.1's **`Webview::eval_with_callback`**, which serializes the JS result to
JSON and hands it to a Rust callback on all three engines (WKWebView / WebView2 /
WebKitGTK). `eval_embed_with_result` bridges that callback to an async command via
a oneshot channel with a 10 s timeout — so the old `cognia.invalid/__cognia_select`
sentinel-navigation hack is no longer the only page→Rust path (it is kept only for
the human click-to-select UX). On Windows `eval_with_callback` swallows exceptions,
so every injected function wraps its body in `try/catch` and returns an
error-as-value.

### Components (Phase 1)

- `lib/browser/overlay.injected.js` — `__cogniaSnapshot()` (a11y tree with stable
  `data-cognia-ref`), `__cogniaAct(ref, action, args)` (click/type/fill/select/hover
  via the native value setter for React-controlled inputs), and `console.*` / `fetch`
  hooks drained by `__cogniaDrainConsole` / `__cogniaDrainNetwork`.
- `src-tauri/src/browser/embedded.rs` — `browser_embed_{snapshot,act,drain_console,
  drain_network,back,forward,stop,get_url,get_title}`.
- `lib/browser/client.ts` + `protocol.ts` — pass-throughs + canonical types.
- `lib/browser/agent-engine.ts` — `BrowserEngine`, `EmbeddedEngine`, `routeEngine`.
- `plugins/browser-tools` — `browser_navigate` (+ `browser_back / forward / reload /
  stop`), `browser_snapshot`, `browser_click / type / fill_form / select / hover`,
  `browser_wait_for` (text appear/disappear, backed by the injected `__cogniaHasText`
  + `browser_embed_has_text` command and the engine's poll loop), `browser_screenshot`
  (PNG vision fallback — reuses the verified region-based `browser_embed_capture` with
  the pane rect published via the `lib/browser/pane-rect` singleton), `browser_read_console
  / read_network`, `browser_get_page`, discovered via
  `lib/plugin/core/browser-builtin-registry.ts`.
- `lib/claude/build-options.ts` — `browserAllowedForChat` gate, opt-in per character
  (`Character.enableBrowserTools`), never on IM-bound sessions.
- `components/browser/browser-agent-indicator.tsx` + `lib/browser/agent-activity.ts`
  — an "Agent driving / You're driving" badge fed by a renderer-side activity bus.

## Discipline & security

- `snapshot → act → re-snapshot`: every mutating tool returns a fresh snapshot
  inline; refs carry a `generation` id.
- Scheme allowlist stays http(s)-only; the `public` tier is flagged `untrusted`
  (prompt-injection caution); the agent never auto-fills secrets.
- `browser_evaluate` (raw JS, RCE-class) is intentionally **not registered** in
  Phase 1 — it will be a separately gated, off-by-default tool in a follow-up.
- `browser_screenshot` reuses the already-unit-tested region-based
  `browser_embed_capture` (the `compute_embed_capture_region` geometry the human
  selection→chat flow already relies on) rather than re-deriving capture bounds: the
  pane publishes its reserved-region rect to the `lib/browser/pane-rect` singleton, and
  the engine captures that rect. It is a vision fallback — the model works off the
  structured snapshot by design.

## Honest Phase-1 limits (injected-JS ceiling)

1. Cross-origin iframes are invisible to snapshot / console / network / acts.
2. Synthetic events are `isTrusted:false` → clipboard / file pickers / some
   anti-bot flows reject them.
3. Network response **bodies** are unavailable (status/timing only).
4. Closed shadow DOM is unreachable; open shadow DOM needs explicit piercing.

These are strong enough for the primary localhost use case and are exactly what the
Playwright MCP fixes — which is why public origins steer there. They are surfaced to
the model as explicit limitations, not silent gaps.

## Consequences

- The agent can now self-verify and drive local dev previews in the same pane the
  human watches — closing the biggest gap in the prior browser feature.
- Public-site automation reuses the existing Playwright MCP preset at zero extra
  footprint; the model switches tool families by trust tier rather than the host
  transparently swapping an engine (which a renderer plugin cannot do).
- The live webview eval bridge (`eval_with_callback`) cannot be covered by jest or
  cargo unit tests; a `pnpm tauri dev` smoke of one snapshot→click→snapshot loop is
  the manual gate.

## Addendum (2026-06-27) — DOM tool coverage round

Surgical additions to close real gaps in the Phase-1 tool surface (all behind
the same embedded-engine / trust-tier router):

- **`browser_press_key`** — named keys (Enter/Tab/Escape/Arrow*/Backspace/Delete/
  Home/End/PageUp/PageDown/F1–F24) and chords (`ctrl+a`, `shift+Tab`) via a JS
  chord parser mirroring the Rust `keymap` vocabulary. Optional `ref` target;
  defaults to the focused element. Text entry still uses `browser_type`.
- **`browser_click` modifiers** — optional `modifiers: ["ctrl","shift",…]` for
  modifier-clicks.
- **`browser_scroll`** — by `ref` (scroll-into-view) or page `direction`
  (up/down/left/right/top/bottom) + optional `amount`.
- **`browser_evaluate`** — evaluate a JS *expression*, returning a JSON
  `{ok,value}` envelope (new `browser_embed_evaluate` Tauri command wrapping the
  existing `eval_embed_with_result`, 200 KB result cap). **Trust-gated**: refused
  on public origins (the plugin tool checks `resolveTrustTier`), steering to the
  Playwright MCP.
- **`browser_wait_for` variants** — now also waits for a CSS `selector`
  (appear/disappear) or `networkIdle` (in-flight + completion counters, fed by a
  new fetch/XHR pending tracker), in addition to text.
- **Snapshot richness** — `buildSnapshot` now descends open shadow DOM and
  same-origin iframes (frame-origin nodes carry `frame:true`), and an opt-in
  `includeText` surfaces salient non-interactive text (headings/list items/…).
  Bounded by depth + node caps.

New read-only Tauri commands: `browser_embed_has_selector`,
`browser_embed_network_state`. Still deferred (Phase-next): multi-tab/popup
orchestration, drag-and-drop, file upload, cookie/storage/header access, and the
closed-shadow-DOM / cross-origin-iframe limits (unchanged — Playwright MCP).

## Addendum (2026-06-27) — surface guidance

The computer-use plugin now registers a `computer-use:surface-guidance` context
provider so the model picks the right family: `computer_use`/`click_text` for
native apps & arbitrary screens, `browser_*` for the localhost preview,
`mcp__playwright__*` for public sites, `web_fetch`/`web_search` for read-only
content.

## Addendum (2026-07-08) — navigation & trust hardening round

Fixes for real-world public-site browsing and automation correctness:

- **Scheme escape closed.** `on_navigation` used to allow any non-http(s)
  scheme to proceed (only sentinels and http(s) were classified). A remote page
  redirecting to `file://` / custom protocols now gets **blocked**; `about:`
  documents stay allowed. Pure `classify_navigation` disposition is unit-tested.
- **Native navigate/reload.** `browser_embed_navigate`, the re-navigate path of
  `browser_embed_create`, and `browser_embed_reload` use `Webview::navigate` /
  `Webview::reload` instead of eval'd `location.assign` — navigation works even
  when the current page's JS context is broken, blank, or blocked.
- **Popups land in-view.** The overlay overrides `window.open` (returning a
  navigating window stub for the deferred-popup pattern) and rewrites
  `target="_blank"` anchor clicks (bubble phase, respects `defaultPrevented`)
  to same-view navigations — links on public sites are no longer dead ends.
- **SPA URL tracking.** pushState/replaceState/popstate/hashchange report the
  new URL through a second sentinel (`/__cognia_nav`, debounced 150 ms), which
  Rust re-emits as `browser://navigated` — the pane's address bar and the
  `paneId` payload stay accurate on client-routed apps.
- **Live-URL trust gating.** `browser_evaluate` (and the `untrusted` flag on
  `browser_navigate`) now resolve the trust tier from the page's **live** URL
  (`getPage()`), not the last URL the model asked for — a localhost page that
  redirects to a public origin loses `trusted` immediately. Fail-closed to the
  last known URL when the live one is unreadable.
- **Load-settled snapshots.** New `EmbeddedEngine.waitForLoad` (URL +
  `readyState` poll, tolerant of mid-swap eval failures). `browser_navigate`
  waits for the target document; every mutating tool settles (3 s cap) before
  its inline snapshot so click-triggered navigations return the page they
  produced; back/forward/reload add a 250 ms initial delay so the old
  document's `complete` can't satisfy the check.
- **Address-bar https default.** `normalizePreviewUrl` defaults bare public
  hosts to `https://` (local/private hosts — loopback, RFC-1918, `.local` —
  keep `http://`), via the new `isLocalHostname` helper.
