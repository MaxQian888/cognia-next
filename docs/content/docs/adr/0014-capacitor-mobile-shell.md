---
title: ADR-0014 — Capacitor mobile shell
description: Mobile client v1 wraps the existing Tauri-shared Next.js static export in a Capacitor 7 shell. Same JS bundle on three platforms, three-way Transport selection, OS keystore for the device JWT.
---

# Capacitor mobile shell

| Status   | Accepted                                                                  |
| -------- | ------------------------------------------------------------------------- |
| Date     | 2026-05-08                                                                |
| Affects  | mobile/, lib/tauri/, app/(mobile-onboard), app/, src-tauri/companion_api/ |
| Issues   | #41 (M3.1) · #42 (M3.2) · #43 (M3.3) · #44 (M3.4)                         |
| Tracking | #56                                                                       |

## Context

cognia-next runs on the desktop as a Tauri 2 app (Rust shell + WebView).
The Mobile Client v1 plan (issue #56) adds a phone client that talks to
the desktop over LAN. Three native-shell options were on the table:

1. **Tauri 2 Mobile** — would let us reuse the same Rust crates. Rejected:
   sidecar support is missing on mobile (Tauri issues #11454 / #9774) and
   our Claude Agent SDK sidecar is the keystone of the desktop runtime.
2. **React Native** — would let us share Zustand stores and lib/ helpers.
   Rejected: rewriting all 57 shadcn/ui components in RN primitives is
   weeks of work for no functional gain. The desktop UI is already the
   thing the mobile user wants.
3. **Capacitor 7** — wraps the existing Next.js static export in a native
   WebView. Selected.

Pairing the choice with an HTTP-based companion server (M2) means: the
phone calls into the desktop the same way an external script would,
through `/api/v1/*`. The server-client architecture documented in #56
makes the mobile client and the future headless `cognia-server` symmetric
clients of the same API.

## Decision

### Workspace layout

A new pnpm workspace `mobile/` joins the existing `docs/`:

```
pnpm-workspace.yaml
├── docs        # Fumadocs site (full Next server, port 3001)
└── mobile      # Capacitor shell (no Next server — feeds off ../out)
```

Capacitor's `webDir: "../out"` points at the same directory Tauri loads
from (`src-tauri/tauri.conf.json` `frontendDist: "../out"`). One
`pnpm build` produces one static export, two native shells consume it.

### Pinned versions

| Package                                                            | Range     | Why                                                                                          |
| ------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------- |
| `@capacitor/core`, `@capacitor/cli`                                | `^7.0.0`  | Capacitor 7 is the floor for Node 20.                                                        |
| `@capacitor/android`                                               | `^7.6.3`  | Pinned to align with `^7` core.                                                              |
| `@capacitor/{app,keyboard,network,preferences,push-notifications}` | `^7.0.x`  | Official plugins.                                                                            |
| `capacitor-secure-storage-plugin`                                  | `^0.13.0` | Active community plugin; bridges Keychain / Keystore.                                        |
| `@capacitor-mlkit/barcode-scanning`                                | `^7.5.0`  | The currently maintained QR scanner. The older `@capacitor/barcode-scanner` is unmaintained. |

`bundledWebRuntime` is **not set** — the field was removed in Capacitor
5+. Issue #41's original wording predates that change.

### Transport selection

Three concrete `Transport` implementations, picked once at module load
in `lib/tauri/transport-instance.ts`:

```
window.__TAURI_INTERNALS__ exists                  → TauriTransport
window.Capacitor?.isNativePlatform() === true      → CompanionTransport
otherwise                                          → WebStubTransport
```

`CompanionTransport` (M2.7, `lib/tauri/transport-companion.ts`) talks to
the desktop over `POST /api/v1/_rpc/<command>` and `GET /ws/v1/events`.
On the phone its base URL points to the desktop's LAN IP. On the web
build it would aim at a future `cognia-server` deployment — the same
code path serves both.

### Storage of the device JWT

`lib/tauri/companion-storage.ts` adds a backend-agnostic
`CompanionConfigStorage` interface with two implementations:

- **`LocalStorageCompanionStorage`** — wraps `window.localStorage`. Used
  in the web build and in jsdom unit tests.
- **`SecureStorageCompanionStorage`** — dynamically imports
  `capacitor-secure-storage-plugin` (so the web bundle never resolves
  it). Stores the JSON-serialized `CompanionConfig` under
  `cognia.companion.config.v1` in iOS Keychain / Android Keystore.

Selection happens via `pickCompanionStorage()`, mirroring the transport
pick. A module-level cache fronts both backends so the hot path
(`transport.call()` reading the JWT) stays synchronous; the cache is
primed by `hydrateCompanionConfig()` at app boot or by any successful
`saveCompanionConfig()`.

### Mobile onboarding stub

`app/(mobile-onboard)/pair/page.tsx` + `components/mobile/
pair-onboarding-client.tsx` ship the M3.4 stub:

1. Manual textboxes for `baseUrl` + `pair JWT` (real QR scan ships in
   M4.5 / #49).
2. `POST {baseUrl}/api/v1/auth/pair` with the pair JWT, device label,
   platform, and an optional public key.
3. Persist the returned `CompanionConfig` into the secure storage path.
4. Smoke RPC: `transport.call("claude_sidecar_status")` — the read-only
   command is already registered server-side in
   `src-tauri/src/companion_api/rpc.rs`. (Issue #44's example used
   `list_characters`, but characters live in Dexie and are not exposed
   on the Rust side; `claude_sidecar_status` is the equivalent
   read-only smoke that exists today.)
5. Smoke WS: `transport.subscribe("claude://session-event", …)` — opens
   the WebSocket, replays from the seq cursor.

The page sits behind a route group `(mobile-onboard)`, so the URL is
`/pair`. Static export is preserved (`dynamicParams = false`, no
`generateStaticParams` needed since the route is concrete).

### Platform manifests

iOS (`mobile/ios/App/App/Info.plist`, M3.2 — HITL on a Mac):

- `NSCameraUsageDescription` — QR pairing
- `NSLocalNetworkUsageDescription` — discover desktop on LAN
- `NSAppTransportSecurity / NSAllowsLocalNetworking = true` — needed
  while M2.8's TLS work is deferred to M2.9. Once the self-signed cert
  lands the policy tightens to a trust anchor.
- iOS Deployment Target = 16.0

Android (`mobile/android/`, M3.3 — built and verified on Windows with
JDK 21 + Android SDK 35):

- `INTERNET`, `CAMERA`, `POST_NOTIFICATIONS` declared in
  `app/src/main/AndroidManifest.xml`.
- Debug-only `usesCleartextTraffic="true"` lives in
  `app/src/debug/AndroidManifest.xml` so release builds inherit
  the secure default.
- `compileSdk` / `targetSdk` = 35 (Capacitor 7 default), `minSdk` = 24.
- `gradlew assembleDebug` succeeded; the resulting
  `app-debug.apk` (≈22 MB) is the smoke evidence.

## Consequences

### Good

- One Next.js codebase, three shells. No UI rewrite, no parallel
  component libraries.
- `out/` regeneration cost is paid once, consumed twice.
- Adding a future fourth client (Electron, Wails, …) needs only a new
  `Transport` implementation and a wrapper that loads `out/`.
- The phone is a _client_, not a peer. Twin embeddings, sidecar token
  budgets, MCP servers, OAuth bearers — all stay desktop-side. The
  phone never touches `~/.claude/.credentials.json`.

### Acceptable cost

- WebView constraints: no `<canvas>` heavy rendering paths, no native
  filesystem access. cognia-next happens to not need either on mobile
  (no sidebar 3D scene yet).
- Pairing flow needs a UX (QR or sideband). M4.5 ships the QR scan;
  the M3.4 stub uses textboxes.
- Capacitor's WebView is shared with the system, not a Chromium fork.
  Older Android devices (API < 24) get poor JS perf — `minSdk = 24`
  is the line we hold.

### Open

- **TLS for LAN** — M2.8 deferred self-signed cert + cloudflared to
  M2.9. Until M2.9 lands the M3.4 smoke runs over plain HTTP, gated by
  the `NSAllowsLocalNetworking` / `usesCleartextTraffic` debug-only
  exceptions above. M2.9 will tighten both manifests.
- **mDNS broadcast** — also deferred to M2.9. The M3.4 stub uses
  manual `baseUrl` entry; M4.4 will pull it from the QR payload.
- **iOS smoke build** — #42 is HITL on a Mac. Plan-level decision
  recorded; physical verification + Xcode log excerpt land when an
  owner runs the build.

## Verification

End-to-end (manual, requires running M2 desktop server + a phone or
emulator on the same LAN):

1. Desktop: `pnpm tauri dev`, Settings → Companion → enable LAN bind +
   start server, generate a 5-minute pair JWT.
2. Build the static export: `pnpm build`.
3. Sync into the platform: `pnpm mobile:sync` (chains
   `pnpm build && pnpm -F mobile sync`).
4. Open the platform: `pnpm mobile:open:android` (or `:ios` on a Mac).
5. From the on-device app, navigate to `/pair`, enter the desktop's
   LAN IP + pair JWT, tap **Pair**.
6. Tap **Smoke RPC** — expect a `claude_sidecar_status` payload.
7. Tap **Smoke WS** — expect an "OK" or a captured frame within 5s.
8. Confirm the JWT is in OS keystore: on Android, `adb shell run-as
com.cognia.mobile cat shared_prefs/SecureStorage.xml` shows an
   encrypted value; on iOS, `security find-generic-password -a default
-s "com.cognia.mobile.companion" -w` returns the JWT.

Automated:

- `pnpm test --testPathPatterns="(companion-storage|transport-companion|pair-onboarding)"`
  — 58 tests cover the storage backends, the transport refactor, and
  the onboarding component (happy + error paths).
- `pnpm typecheck` — clean.
- `gradlew assembleDebug` (in `mobile/android/`) — `BUILD SUCCESSFUL`,
  produces `app/build/outputs/apk/debug/app-debug.apk`.
