---
title: "0012 — Transport Abstraction for Multi-Client Future"
description: "lib/tauri.ts gains a unified Transport interface so the same wrapper code paths can route through Tauri IPC on desktop, HTTP+WS to a remote desktop on Capacitor mobile, or a no-op stub in plain web — single seam for the upcoming server-client architecture."
---

# ADR 0012 — Transport Abstraction for Multi-Client Future

**Status:** Accepted
**Date:** 2026-05-08
**Branch:** `feat/mobile-m1-foundation`
**Related issues:** #26 #27 #28 #29 #30 #31 #32 (M1 foundation chain) · [Tracker #56](https://github.com/MaxQian888/cognia-next/issues/56)

---

## Context

cognia-next is moving from a single-client (Tauri desktop) app to a server-client
system where the same backend serves both the desktop UI and a future mobile
client (M3+). A 2026-state codebase audit confirmed two facts that pin the design:

1. **Five subsystems can never run on iOS/Android** — the Claude Agent SDK Node
   sidecar, the MCP server sidecar, the `sqlite-vec` native vector extension,
   the Rust `keyring` crate (which doesn't cover iOS Keychain / Android
   Keystore), and the connector webhook server (a phone behind NAT can't host
   a public URL). This is platform truth, not framework truth.
2. **`lib/tauri.ts` was _supposed_ to be the sole `invoke()` chokepoint** — but
   five non-`lib/tauri/` modules (`lib/claude/ipc.ts`,
   `lib/external-bridge/tauri-control.ts`, `lib/connectors/tauri/commands.ts`,
   `lib/native/system-scheduler.ts`,
   `lib/anthropic-subscription/credential-store.ts`) were calling `invoke`
   directly, plus 30+ stragglers across `lib/plugin/*`, `lib/ai/*`, etc.

Together these mean: we need an abstraction that decouples _what command to run_
from _how to dispatch it_. The desktop continues to use Tauri IPC for speed; the
future mobile shell (Capacitor — see ADR for that selection) talks to the
desktop's axum HTTP/WS server through the same named-export surface.

## Decision

Introduce a `Transport` interface and route every named export in
`@/lib/tauri` and its high-touch downstream wrappers through a single
module-scope `transport` const.

```ts
// lib/tauri/transport-types.ts
export interface Transport {
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>
  subscribe<T = unknown>(event: string, handler: (payload: T) => void): () => void
}
```

Three implementations ship with M1:

| Impl                     | When                               | `call`                                                          | `subscribe`                                                             |
| ------------------------ | ---------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `TauriTransport`         | `isTauri()`                        | delegates to `@tauri-apps/api/core` `invoke`                    | bridges async `listen` to a sync unsubscribe with cancel-before-resolve |
| `WebStubTransport`       | plain web (no Tauri, no Capacitor) | rejects with `tauri-only command from web mode: <name>`         | no-op                                                                   |
| `CompanionTransportStub` | Capacitor mobile                   | rejects with `companion transport not implemented yet — see M2` | no-op                                                                   |

Selection happens once at module load in `lib/tauri/transport-instance.ts`
(separate from `lib/tauri.ts` to stay out of the
`lib/tauri.ts → lib/tauri/index.ts → lib/tauri/<wrapper>.ts → lib/tauri.ts`
circular import chain). The resolved `transport` const is re-exported from
`@/lib/tauri` for consumers.

`isCapacitor()` joins `isTauri()` as a public detection helper for UI gating
that needs to differentiate the three runtime contexts.

## Migration scope and deferrals

M1 ships migrations for the load-bearing call sites only — the goal is the
abstraction, not exhaustive migration:

**Migrated (M1.1 → M1.6):**

- All three transport classes + the selector
- `lib/tauri.ts:greet` (M1.2 pilot)
- `lib/tauri/canvas.ts` and `lib/tauri/remote-control.ts` (M1.3 — the only
  direct-`invoke` callers among the plugin wrappers)
- `lib/claude/ipc.ts`, `lib/external-bridge/tauri-control.ts`,
  `lib/native/system-scheduler.ts`,
  `lib/anthropic-subscription/credential-store.ts` (M1.4)
- `lib/tauri/events.ts:onTauriEvent` and `lib/claude/ipc.ts:onClaudeMessage`
  (M1.5 — the canonical event-listening helpers)

**Explicitly deferred to follow-up PRs:**

- `lib/connectors/tauri/commands.ts` and the 10 connector adapter modules
  (slack/discord/telegram/lark/onebot transports). Their tests assert via
  `mockInvoke.mock.calls.filter(...)` and migrating them is a focused effort.
- The 9 plugin-SDK wrappers (`autostart.ts`, `cli.ts`, `clipboard.ts`,
  `deep-link.ts`, `notification.ts`, `opener.ts`, `os.ts`, `store.ts`,
  `webview-zoom.ts`) — these wrap Tauri plugin SDKs that internally use
  `invoke` with channel names like `plugin:foo|bar`. Migrating requires
  defining parallel Rust commands wrapping each plugin function (M2 server
  API surface work).
- ~30 other production modules (`lib/plugin/*`, `lib/ai/providers/*`,
  `lib/ccswitch/*`, `lib/files/*`, `lib/scheduler/*`, etc.) that import
  `invoke` directly. These migrate per-domain as their corresponding
  `/api/v1/*` route handlers land in M2.
- The `no-restricted-imports` ESLint rule that forbids
  `@tauri-apps/api/core` outside `lib/tauri/transport-tauri.ts`. Lands when
  the production-code migration is complete (otherwise it forces
  per-file `eslint-disable` comments across 30+ modules).

## Consequences

**Win:**

- Single seam (`transport`) intercepts the IPC boundary.
  `jest.spyOn(transport, "call")` is the new universal mock pattern.
- `isCapacitor()` is in place for M4's `usePlatform()` hook.
- M2's `CompanionTransport` (the real HTTP/WS impl) is a single-file swap
  in `transport-instance.ts` — every consumer downstream stays unchanged.
- Web-mode error messages are now consistent (`tauri-only command from web
mode: <name>`) instead of per-wrapper-specific strings.

**Cost:**

- Module-load eager evaluation of `transport` had to be moved to a
  separate file to avoid breaking `jest.requireActual("@/lib/tauri")`
  patterns (one test in `lib/db/twin-runtime-settings.test.ts`).
- Tests that previously asserted via `mockedInvoke.mock.calls` had to
  switch to `jest.spyOn(transport, "call")`. ~6 test files updated; ~10
  more deferred along with their wrappers.
- Local `isTauri()` / `ensureTauri()` guards in migrated wrappers were
  removed in favor of letting WebStubTransport produce the rejection.
  Error-message strings change but semantics are equivalent and the
  Capacitor path is now reachable.

## Verification

- `pnpm test` — 9314 passing, 24 skipped, 0 failing.
- `pnpm test:coverage` — every new file (`transport-types.ts`,
  `transport-tauri.ts`, `transport-web.ts`, `transport-companion-stub.ts`,
  `transport-instance.ts`) exceeds 90% line coverage.
  `transport-types.ts` is excluded from the gate (pure interface, V8
  reports 0 stmt) following the same pattern as the nine other type-only
  modules already exempted in `jest.config.ts`.
- `pnpm typecheck` and `pnpm lint` — no regression from M1's six commits.
- Manual smoke `pnpm tauri dev` — chat / settings / twin admin all
  exercise the migrated paths with no observable behavior change.

## What's next

M2 builds on top of this seam: define `/api/v1/*` axum routes mirroring the
Tauri command list (per ADR 0013 — command manifest), JWT pair/auth
(`pairedDevices` Dexie schema v21), the real `CompanionTransport`, and
mDNS/cloudflared LAN+tunnel exposure. Mobile shell (M3 onwards) wraps the
existing Next.js export in Capacitor 7 and connects the phone to the
desktop's axum server through the same `transport` seam shipped here.

## References

- M1 issue chain: [#26](https://github.com/MaxQian888/cognia-next/issues/26)
  → [#27](https://github.com/MaxQian888/cognia-next/issues/27)
  → ([#28](https://github.com/MaxQian888/cognia-next/issues/28)
  ‖ [#29](https://github.com/MaxQian888/cognia-next/issues/29)
  ‖ [#30](https://github.com/MaxQian888/cognia-next/issues/30)
  ‖ [#31](https://github.com/MaxQian888/cognia-next/issues/31))
  → [#32](https://github.com/MaxQian888/cognia-next/issues/32)
- Mobile client tracker: [#56](https://github.com/MaxQian888/cognia-next/issues/56)
- Plan file (private): `~/.claude/plans/react-tauri-react-native-snug-hennessy.md`
- Tauri Mobile sidecar discussion: [tauri-apps/tauri#11454](https://github.com/tauri-apps/tauri/discussions/11454) (motivation for Capacitor over Tauri Mobile)
