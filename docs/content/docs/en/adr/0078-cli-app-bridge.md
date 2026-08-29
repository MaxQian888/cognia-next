---
title: ADR-0078 — CLI ↔ App bridge
description: Keep a dedicated authenticated loopback bridge for both local CLIs, use renderer round-trips only for WebView-owned state, and preserve forked stores with explicit projection and transcript handoff.
---

# ADR-0078 — CLI ↔ App bridge

**Status**: Accepted (2026-07-16)

## Current state amendment (2026-08-13)

The local CLI bridge listener, endpoint writer, and initializer are compile-gated to desktop non-mobile targets, and the Tauri setup hook cannot start them on Android or iOS. Mobile continues to use the Companion transports and never writes `cli-endpoint.json`.

## Context

Cognia has two local command-line products with different responsibilities: the TypeScript
`cognia-agent` chat TUI and the Rust `cognia` plugin-author CLI. Both need selected capabilities
from a running desktop, while the agent CLI must also remain independently usable. The desktop's
Companion API serves a different audience and threat model: paired devices over HTTPS, WebSocket,
and WebRTC with device JWTs.

Some authoritative desktop data lives in the WebView rather than Rust. Agent teams use renderer
stores; twin context spans Dexie and vector-backed runtime state. Configuration and conversation
stores also differ between the standalone process and browser renderer.

## Decision

1. Run a dedicated Axum `cli_bridge` listener on `127.0.0.1:0`. Publish its base URL and a random
   per-launch token in `<config_dir>/cognia/cli-endpoint.json`; require loopback origin and
   `X-Cognia-Dev-Token` on every route. The current catalog has 18 routes, including plugin Dev
   Session events and verified reload.
2. Keep route ownership explicit. `cognia` owns plugin lifecycle and ACP brokerage;
   `cognia-agent` owns session handoff, twin context, and team operations. Health is shared.
3. Use Tauri renderer request/response whenever the authoritative state is in the WebView. For
   plugin development, Rust owns authentication, path validation, installation, manifest parity,
   and the installed artifact SHA-256. The renderer owns WebView runtime quiescence, activation,
   and lifecycle generation verification. Reload succeeds only when both sides succeed.
4. Keep the CLI bridge separate from `companion_api`; do not reuse device pairing, LAN exposure,
   TLS configuration, or the device-JWT route catalog for same-user local tooling.
5. Preserve forked stores and shared implementation. The GUI retains browser IndexedDB and
   keyring state; the CLI reuses shared schemas and agent code through fake IndexedDB, JSON files,
   and its own JSONL transcript store.
6. Make cross-shell state movement explicit. Desktop-to-CLI config/credential/history/MCP sync is
   direct file projection. Both transcript handoff directions create continuation copies and do
   not transfer a live sidecar or SDK session id.

## Consequences

- Either CLI can discover a running desktop without a fixed port or a network-visible service.
- The two products cannot accidentally consume each other's routes merely because they share an
  endpoint file.
- Twin/team operations require a live WebView and have bounded client/server timeouts.
- A plugin bundle being installed or discovered is not evidence that its runtime changed. The
  reload response is successful only with a new active lifecycle generation and the revision of
  the artifact Rust actually installed.
- Endpoint-file confidentiality is a same-user local control, not protection from a malicious
  process already running as that user.
- Store divergence is expected. New synchronization surfaces must be deliberate projections or
  imports, not ad-hoc shared-file mutation.
- The current Tauri startup path has no explicit mobile compile-time exclusion around
  `cli_bridge::init`; renderer listeners and sync controls are desktop-gated. A future platform
  invariant must be enforced in code before documentation claims the native listener is
  desktop-only.

## Alternatives considered

- **Fold routes into Companion API**: rejected because local CLIs and paired devices have different
  discovery, exposure, and authentication requirements.
- **Make the GUI and CLI share one database**: rejected because browser IndexedDB/keyring and a
  standalone Node process have different persistence and lifecycle boundaries.
- **Proxy every agent action through the desktop**: rejected because `cognia-agent` must run with
  the desktop closed.
- **Duplicate renderer-owned state in Rust**: rejected because teams and twin context would drift
  from their authoritative WebView stores.
