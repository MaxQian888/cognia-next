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

### Wave 2 — Mobile shell + bidirectional Inbox + Connector approval (shipped)

1. **Outbound queue (Dexie v25, `mobileOutboundQueue`)**

   `lib/db/mobile-outbound-types.ts` defines the 11-command surface
   (`connector_send`, `connector_approve_draft`, `workflow_trigger_manual`,
   `twin_ingest_source`, `backup_export`, …). `lib/db/mobile-outbound-queue.ts`
   is the Dexie helper layer (`enqueue`, `claimNext`, `markSent`,
   `recordFailure`, `vacuumSent`, `retryDeadletter`).
   `lib/queue/retry-policy.ts` provides exponential backoff (1 → 60 s, 25%
   jitter, max 5 attempts) plus 4xx-class non-retryable detection.
   `lib/queue/outbound-queue.ts` is the runner — subscribes to
   `@capacitor/network` change events, drains on `kick()`, and respects
   `nextAttemptAt` so failed rows get the right cooldown.

2. **Mobile Shell wrapper + 4-Tab Bar**

   `components/mobile/shell/mobile-shell-wrapper.tsx` mounts unconditionally
   in `app/layout.tsx` and renders `<MobileTabBar />` only when
   `usePlatform() === "mobile"`. `mobile-tab-bar.tsx` exposes the WeChat-
   style 4 tabs (聊天 / 工作流 / 发现 / 我) with longest-prefix-wins
   route matching and haptic selection feedback. Hidden on `/pair` and
   `/oauth/*` so onboarding flows have full canvas.

3. **Generic interaction primitives (`components/mobile/interactions/`)**

   `pull-to-refresh.tsx` (rubber-band drag with refresh callback),
   `swipe-row.tsx` (commit-threshold horizontal swipe revealing left /
   right action panels), `long-press.tsx` (hold + tolerance + auto-cancel
   on movement). All three drive haptics through `lib/capacitor/haptics.ts`
   so feedback is consistent. A `test-pointer-polyfill.ts` shim works
   around jsdom 26 not exposing `PointerEvent`.

4. **Discover + Me pages**

   `app/discover/page.tsx` is a 4-tab Tabs surface listing characters,
   teams, skills, and twin drafts via Dexie `useLiveQuery`.
   `components/mobile/discover/{character,team,skill,twin-draft}-card.tsx`
   are the row primitives.
   `app/me/page.tsx` is the settings overview — pairing status card +
   linked sections (Account / Data / Appearance / Advanced) that route
   into the existing `/settings?section=...` paths.

5. **Connector draft approval panel**

   `components/mobile/connector/draft-approval-panel.tsx` lists every
   pending `ConnectorDraftRow` newest-first; each row uses `<SwipeRow>`
   left=reject / right=approve plus inline buttons. Accepted drafts hit
   both `lib/db/connector-drafts.approveDraft` AND enqueue a
   `connector_approve_draft` outbound job so the desktop fires the actual
   platform send. `<PullToRefresh>` runs `sweepExpired()` on pull.

6. **Composer Plus menu (camera / album / file / voice)**

   `components/mobile/chat/composer-plus-menu.tsx` is the attachment
   launcher. Camera + album go through `lib/capacitor/camera.ts`; file
   uses an `<input type="file">` (works on both Capacitor and web);
   voice uses `@capacitor-community/voice-recorder` lazily. Permission
   denial / cancellation / unsupported all surface through `onError`
   without throwing.

7. **i18n**

   New `mobile` top-level namespace (en + zh-CN) with sub-keys for
   `tabs`, `tabBar`, `pair`, `discover`, `me`, `companion.{tunnel,mdns,
revoke}`, `twinDraft`, `draftApproval`, `composerPlus`. Wave 1's
   hardcoded Chinese strings (TunnelCard / MdnsCard / pair page) are
   refactored to use these keys via `next-intl::useTranslations`.

Verification:

- `pnpm typecheck` → EXIT=0
- 288 / 288 jest tests across 35 suites
- Coverage `lib/capacitor`, `lib/queue`, `components/mobile/interactions`,
  `components/mobile/shell`, `components/mobile/connector`,
  `components/mobile/chat` all ≥ 90% statements + branches

### Wave 3 — Workflow / Twin / Backup mobilization + offline finishing (shipped)

1. **Mobile Workflow surface** (`components/mobile/workflow/`)

   `workflow-list.tsx` — Dexie liveQuery over `workflows` + `workflowRuns`
   (running) so each list row gets an "Active" pill when a run is in
   flight. `trigger-button.tsx` enqueues `workflow_trigger_manual` +
   light haptic + i18n toast. `run-vertical-gantt.tsx` stacks runs
   vertically with timeline dots + status badge + duration formatting
   (`<1s` → ms, `<60s` → fractional s, otherwise `Xm Ys`).
   `run-status-badge.tsx` covers all 7 RunStatus variants with theme-
   aware colours.

2. **Twin sources + drafts panels** (`components/mobile/discover/`)

   `twin-sources-panel.tsx` lists every TwinSource newest-first with a
   FAB "+" that opens 3 picker shortcuts: paste (native dialog prompt),
   camera (`lib/capacitor/camera.pickPhoto`), file (web file input).
   Each path enqueues a `twin_ingest_source` outbound job.
   `twin-drafts-panel.tsx` wraps each `<TwinDraftCard>` in a `<SwipeRow>`
   with left=reject / right=accept; accept persists a real
   `Character` / `Skill` row + stamps the draft accepted; reject marks
   rejected. Both mirror to the outbound queue.

3. **Mobile Backup section** (`components/mobile/backup/`)

   `mobile-backup-section.tsx` exposes encrypted-only export
   (`buildBackupPackage` → `encryptBackupPackage` → `lib/capacitor/
filesystem.writeFile` to `Documents/cognia/backups/<ts>.cog.bak`),
   import (web file input → `migrateEnvelope` → `applyBackupPackage`
   with merge strategy picker), auto-backup toggle (LocalNotifications
   reminder), and a history list (top 8 from `listBackupHistory`).
   Mounted at the top of the Data section in `/me`. Web-mode export
   falls back to a Blob-URL download.

4. **Share-target receiver** (`app/share-target/page.tsx`)

   Renders received text/url + a session picker; tapping a session
   enqueues a `connector_send` outbound job. Reached via:
   - Android `ACTION_SEND` intent filter (Wave 1.3)
   - iOS Share Extension (HITL — see `mobile/IOS_BOOTSTRAP.md`)
   - Web `?text=...&url=...` query params (Web Share Target API)
     The boot provider's `appUrlOpen` deeplink router routes
     `cognia://share?...` here automatically.

5. **Offline finishing**

   `hooks/use-network-status.ts` is the React adapter over
   `lib/capacitor/network.subscribe`. `components/mobile/offline-banner.tsx`
   sticks at the top of every mobile route via `MobileShellWrapper` and
   shows two states:
   - **Offline** (red) — "Offline — sends will queue and retry."
   - **Pending queue** (amber) — "{count} queued" with a spinning
     loader.
     Polls `getQueueSummary()` every 15 s. Hidden on desktop / web and
     while the initial network read is loading.

6. **i18n**

   New sub-namespaces: `mobile.{workflow,twinSources,twinDraftActions,
backup,shareTarget,offline}` (en + zh-CN). Injected idempotently via
   `scripts/add-wave3-i18n.mjs`.

Wave 3 verification:

- `pnpm typecheck` → EXIT=0
- 304 / 304 jest tests across 39 suites
- Coverage milestones: Wave 1 → 161 tests, Wave 2 → +127, Wave 3 → +16

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
