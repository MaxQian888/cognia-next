---
title: 0015 — Mobile V2 Completion
description: Closing out ADR-0014's deferred mobile items (QR / TLS / mDNS / OAuth) plus a 14-plugin native expansion and three-wave subsystem mobilization roadmap.
---

## Status

Accepted — 2026-05-08

## Context

ADR-0014 ("Capacitor Mobile Shell", 2026-04-XX) shipped a V1 mobile
foundation: Capacitor 7 workspace, JWT pairing, `/api/v1/*` axum companion
server, push notifications, incremental sync, secure storage, and an M3.4
manual-textbox pairing onboarding flow. ADR-0014 explicitly deferred:

- **M2.8** — TLS for the LAN companion server, Cloudflared tunnel
  launcher, OAuth deep-link callback handling
- **M2.9** — mDNS broadcast + LAN discovery
- **M4.5** — QR scanning to replace the manual textbox
- All non-Inbox subsystem mobile UX (Connector / Workflow / Twin / Backup)
- 10+ Capacitor plugins that the product would benefit from but weren't
  yet integrated

Wave 1 of this ADR closes every deferred security/connectivity item, lays
down a uniform native-plugin wrapper layer, and prepares the data shape
for Wave 2/3.

## Decision

Three-wave delivery:

### Wave 1 (this commit) — Pairing, security, native scaffolding

1. **`lib/capacitor/<plugin>.ts` — 16 native wrappers**

   `_shared.ts` provides `withPlugin(loader, action)` + `makeDefaultLoader`
   so every wrapper file follows the same template: discriminated union
   outcome, dynamic-import loader (web bundles never resolve native code),
   web/Tauri fallback. Plugins covered:

   `haptics`, `toast`, `dialog`, `status-bar`, `splash-screen`, `network`,
   `screen-orientation`, `filesystem`, `camera`, `share`, `browser`,
   `deeplink` (over `@capacitor/app`), `local-notifications`, `geolocation`,
   `biometric` (`capacitor-native-biometric`), `barcode` (`@capacitor-mlkit/
barcode-scanning`).

2. **TLS self-signed certs + public-key pinning**

   `src-tauri/src/companion_api/tls.rs` generates a 10-year self-signed
   cert via `rcgen`, persists at `<app_data>/cognia/companion/tls.{pem,key}`,
   computes the SHA-256 SubjectPublicKeyInfo fingerprint. The fingerprint is
   embedded into the QR pair payload so the mobile client pins it across
   future calls. Re-issuance with the same key keeps the pin valid.

3. **Pair payload v2 (`lib/qr/pair-payload.ts`)**

   Header-prefixed (`cgnp2|...`) base64url JSON carrying `baseUrl`,
   `pairJwt`, `version`, and `fingerprint`. Backwards-compatible with M3.4
   bare-JSON payloads (auto-detected). The new `lib/capacitor/barcode.ts`
   wrapper feeds raw QR strings into the decoder.

4. **mDNS broadcast + scan**

   `src-tauri/src/companion_api/mdns.rs` advertises `_cognia._tcp.local.`
   with TXT records for `ver`, `fp`, and `path`. `lib/connectivity/
mdns-discovery.ts` wraps the Capacitor mDNS plugin (mobile side) and
   exposes Tauri commands `companion_mdns_start` / `companion_mdns_stop` for
   the desktop UI. The connection-strategy module rejects mDNS-discovered
   peers whose advertised fingerprint does not match the pinned value.

5. **Cloudflared tunnel launcher**

   `src-tauri/src/companion_api/tunnel.rs` spawns `cloudflared tunnel
--url <local>` as a tracked child process and parses the trycloudflare
   URL out of stderr. `lib/connectivity/tunnel-resolver.ts` exposes start /
   stop / current to the UI. Tunnel default OFF — opt-in only via Settings.

6. **Connection strategy (`lib/connectivity/connection-strategy.ts`)**

   Builds a prioritized candidate list: mDNS-discovered (fingerprint match)
   → tunnel → cached. `pickReachable` walks the list calling a probe
   function and returns the first responder. Single source of truth for
   the transport's "where to connect" decision.

7. **OAuth in-app browser + deep-link**

   `lib/capacitor/browser.ts` opens the authorize URL in `@capacitor/
browser`. `lib/capacitor/deeplink.ts` parses `cognia://` URLs into a
   typed `DeeplinkRoute` union and subscribes via `@capacitor/app`'s
   `appUrlOpen` event. `lib/oauth/mobile-flow.ts` orchestrates: open →
   await deeplink with timeout → resolve `{ code, state }`. Manual-paste
   mode is supported as a fallback for providers (e.g. Anthropic Claude)
   that don't allow custom redirect URI schemes.

8. **Biometric guard (`hooks/use-biometric-guard.ts`)**

   Wraps sensitive actions (delete pairing, export backup, decrypt secure
   data) behind `verify()`. Default fallthrough on devices without
   biometrics enrolled so the UX degrades gracefully. The "我 → 应用安全"
   toggle (Wave 2) flips fallthrough to false for users who want strict
   gating.

9. **Schema additions**

   `pairedDevices.serverFingerprint` (optional) — the pinned TLS
   fingerprint set at pair time. `setServerFingerprint` updates it on
   key rotation. `CompanionConfig.serverFingerprint` mirrors it on the
   mobile side so the transport layer can pin without a Dexie read on
   the hot path.

10. **Android Manifest** — adds `cognia://` intent filter, `ACTION_SEND`
    intent filters for share-target (Wave 3 prep), and the permissions
    needed by the new plugins (RECORD_AUDIO, ACCESS_NETWORK_STATE,
    USE_BIOMETRIC, ACCESS_FINE_LOCATION, READ_MEDIA_IMAGES, etc.).

11. **iOS bootstrap doc** (`mobile/IOS_BOOTSTRAP.md`)

    `cap add ios` is macOS-only. The doc captures the `Info.plist`
    additions, URL scheme, Bonjour service registration, App Transport
    Security exception for LAN, and the Apple Developer / APNs steps
    needed to ship.

### Wave 2 — Mobile shell + bidirectional Inbox + Connector approval

`app/(mobile)/` route group with a 4-tab WeChat-style shell (聊天/工作流/
发现/我), Inbox bidirectional composer (text + camera + file + voice
recorder), Connector draft swipe-approval, generic interaction primitives
(`pull-to-refresh`, `swipe-row`, `long-press`), biometric unlock at boot.
Outbound queue `lib/queue/outbound-queue.ts` (Dexie v23 new table) drains
on network-online and on `@capacitor/app:resume`.

### Wave 3 — Workflow / Twin / Backup mobilization + offline finishing

Workflow read-only viewer + manual trigger + run history; Twin source
ingestion via camera/file/paste; Backup local export/import via
`@capacitor/filesystem` + Documents directory; share-target receive
(Android `ACTION_SEND`, iOS Share Extension); offline LocalNotifications
backstop when outbound queue items stale > 30 minutes.

## Consequences

### Positive

- Production-grade pairing (QR scan + TLS + fingerprint pin)
- Native UX matching mature IM/productivity apps (haptic, share sheet,
  in-app browser, biometric, system status bar theming)
- Single dispatch surface for all native operations — no scattered
  dynamic-import calls in feature code
- Connection layer aware of mDNS/tunnel/cached so transport doesn't
  blindly retry the wrong endpoint when LAN moves
- Bidirectional subsystems unlock real "use phone as a remote" workflows
  (Wave 2/3)

### Negative / risks

- iOS platform bootstrap is macOS-HITL — Wave-1 commit can't include
  generated Xcode project; the bootstrap doc captures everything that has
  to happen on macOS
- Apple Developer account + APNs key + Provisioning Profile are out-of-
  band requirements
- Cloudflared depends on the user installing the binary; we don't ship it
- TLS self-signed + public-key pinning may surprise corporate proxies that
  expect chain validation; the doc surfaces a fallback to Cloudflared with
  real TLS
- 14 new native plugins translate to ~3-4 MB of additional native code
  in the .apk / .ipa; acceptable for a productivity app

### Neutral

- No public API changes for desktop-only flows
- Web bundle untouched (dynamic import keeps native code out)

## Verification

Wave 1 acceptance:

```powershell
# TS
rtk pnpm install
rtk pnpm typecheck
rtk pnpm test --coverage         # ≥90% on lib/capacitor/*, lib/connectivity/*,
                                 # lib/qr/pair-payload, lib/oauth/mobile-flow,
                                 # hooks/use-biometric-guard
rtk pnpm lint

# Rust
rtk cargo --manifest-path src-tauri/Cargo.toml test --lib companion_api::tls
rtk cargo --manifest-path src-tauri/Cargo.toml test --lib companion_api::mdns
rtk cargo --manifest-path src-tauri/Cargo.toml test --lib companion_api::tunnel
rtk cargo --manifest-path src-tauri/Cargo.toml build

# Android
rtk pnpm build
rtk pnpm --filter mobile sync
rtk pnpm --filter mobile open:android   # Build + install on emulator/device

# iOS (macOS only — see mobile/IOS_BOOTSTRAP.md)
# pnpm --filter mobile add:ios
# pnpm --filter mobile sync
# pnpm --filter mobile open:ios
```

Manual smoke (Android first):

1. Generate QR on desktop Settings → Connections → "配对新设备"
2. Scan from mobile pair page → paired in <2 s, fingerprint stored
3. Probe `_rpc/claude_sidecar_status` → succeeds
4. Toggle Cloudflared in Settings → tunnel URL appears → re-pair → still
   works on mobile data (off LAN)
5. Trigger Claude OAuth from Tab 4 → in-app browser opens → callback
   captured (manual-paste path)
6. Settings → Me → 应用安全 → "启用生物识别"; restart app → Face ID prompt;
   skip → app stays locked
7. Run `pnpm test` and confirm ≥90% coverage on the new directories

## References

- ADR-0014 — Capacitor Mobile Shell (V1 baseline)
- Plan file — `~/.claude/plans/capacitorjs-spicy-cook.md`
- Issue tracker — M2.8 / M2.9 / M4.5 (now closed)
