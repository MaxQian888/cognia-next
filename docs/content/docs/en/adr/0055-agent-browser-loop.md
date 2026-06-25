---
title: ADR-0055 — Agent browser loop
description: "Give the product agent a snapshot→act-by-ref→re-snapshot browser loop over the existing embedded /browser webview (navigate, accessibility-tree snapshot with stable refs, click/type/fill/select/hover, console + network inspection, screenshot), exposed as gated plugin tools. Phase 1 drives the in-app embedded webview via injected JS for a shared human+agent pane; Phase 2 adds an external playwright-mcp engine for robust public-site automation behind a URL trust-tier router with one canonical snapshot schema."
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
- **Phase 2 — MCP engine.** Wire an external `playwright-mcp` (the
  `plugins/playwright-mcp` preset already exists) as a second engine for robust
  arbitrary-public-site automation, behind the same router and one canonical
  snapshot schema, via the product's existing stdio-MCP spawn path.

Shared-view fidelity and full CDP power are mutually exclusive on macOS/Linux:
driving our own embedded webview caps us at injected-JS capability but keeps the
human in the loop; a separate headless Chromium gives full CDP but is invisible.
Phase 1 takes the embedded path; Phase 2 adds the headless engine where it pays.

## Architecture

```
agent tool call ──► plugins/browser-tools (registerTool ×N)
                        │  validates args, builds the call
                        ▼
                 lib/browser/agent-engine.ts ── routeEngine(urlTrustTier)
                    ├─ EmbeddedEngine  (Phase 1) → browserClient → src-tauri/src/browser  [injected JS]
                    └─ McpEngine       (Phase 2) → external playwright-mcp
```

- **Trust tier** (`resolveTrustTier`): `localhost` / `127.0.0.1` / `::1` =
  **trusted → embedded pane**; any other `http(s)` = **public**. Phase 2 routes
  public to the MCP engine; Phase 1 falls back to the embedded pane best-effort
  with an explicit `untrusted` flag.
- **Canonical snapshot schema** (`lib/browser/protocol.ts`: `BrowserSnapshot`,
  `SnapshotNode`, `BrowserActionResult`, `ConsoleEntry`, `NetworkEntry`) is emitted
  by both engines, so the model's tool surface is identical regardless of which
  engine ran.

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
  + `browser_embed_has_text` command and the engine's poll loop), `browser_read_console
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
- `browser_screenshot` (agent-facing capture) is **deferred**: capturing the embed at
  its own bounds needs physical/logical coordinate math that cannot be verified
  without the live desktop shell, and the model works off the structured snapshot by
  design (screenshot is only a vision fallback). The human still gets screenshots via
  the existing selection→chat flow. Tracked as a follow-up.

## Honest Phase-1 limits (injected-JS ceiling)

1. Cross-origin iframes are invisible to snapshot / console / network / acts.
2. Synthetic events are `isTrusted:false` → clipboard / file pickers / some
   anti-bot flows reject them.
3. Network response **bodies** are unavailable (status/timing only).
4. Closed shadow DOM is unreachable; open shadow DOM needs explicit piercing.

These are strong enough for the primary localhost use case and are exactly what the
Phase-2 MCP engine fixes. They are surfaced to the model as explicit limitations,
not silent gaps.

## Consequences

- The agent can now self-verify and drive local dev previews in the same pane the
  human watches — closing the biggest gap in the prior browser feature.
- One canonical snapshot schema keeps the Phase-2 engine swap invisible to the
  model; the only real Phase-2 unknown is the playwright-`ref` → canonical adapter.
- The live webview eval bridge (`eval_with_callback`) cannot be covered by jest or
  cargo unit tests; a `pnpm tauri dev` smoke of one snapshot→click→snapshot loop is
  the manual gate.
