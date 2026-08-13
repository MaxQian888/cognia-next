---
title: ADR-0027 — Mobile offline tolerance & server discovery (Wave 4.0)
description: Persistent sync cursors, Dexie-first reads, vendored Capacitor mDNS, Serwist PWA, and a ConnectionStateBadge dropdown for reconnect/scan/switch.
---

# ADR-0027 — Mobile offline tolerance & server discovery

**Status**: Accepted (2026-05-19, Wave 4.0)
**Supersedes**: extends ADR-0014 (Capacitor shell), ADR-0015 (Wave 1.x mobile completion), ADR-0021 (WebRTC tier)
**Authors**: Max Qian + Claude Opus 4.7

## Context

The Capacitor 7 mobile shell ships JWT pairing, the WebRTC tier, and an
outbound write queue. But the mobile UX still felt broken whenever the
desktop server was unreachable, for three reasons:

1. **No read-path cache.** Every screen called `transport.call()`
   directly. The shipped sync orchestrator (`lib/sync/companion-sync.ts`)
   pulled four tables (sessions / messages / characters / skills) on
   `visibilitychange` + `sync://invalidate`, but its cursors lived only
   in memory and five more sync-capable tables were not wired.

2. **No "scan / reconnect" affordance.** `ConnectionStateBadge` was
   display-only. When the paired desktop went silent the user could not
   trigger discovery, re-pair, or switch to another paired desktop
   without manually walking to `/pair`. Mobile mDNS was a
   `defaultMobileLoader` no-op.

3. **Pair-flow paper cuts.** The QR scanner returned silently on
   permission denial — Apple does not expose a programmatic re-prompt
   once a user has denied camera access, leaving the user stuck.

## Decisions

### Sync orchestrator extension (Section B of the plan)

- **Persistent cursors** in a new Dexie `syncCursors` table (`schema.ts`
  v44). `lib/sync/cursor-store.ts` provides read-through Dexie cache;
  `companion-sync.ts` hydrates the in-memory `stateMap` once on first
  `runSyncDown` and fire-and-forgets `saveCursor` after each handler.
  Cold-started phones now resume from the last successful cursor
  instead of pulling every snapshot from `since: 0`.

- **Five new handlers**: `workflows`, `twinProfile`, `plugins`,
  `adapterInstances`, `settings`. The Rust dispatcher
  (`src-tauri/src/companion_api/sync_registry.rs::default_tables()`)
  already advertised these — no Rust changes needed.

- **Two new triggers**: `installNetworkSync()` (network up) and
  `installResumeSync()` (`@capacitor/app:resume`), both wired in
  `CompanionBootProvider`. The outbound queue still owns its own
  network subscription — Capacitor plugin listeners are multi-subscriber.

- **`useDexieFirstQuery` hook** (`hooks/data/use-dexie-first-query.ts`)
  composes `useClientLiveQuery` + a per-mount sync kick + an SWR
  indicator. Two read-paths migrated as proof of pattern:
  `mobile-channel-list.tsx` (characters) and `workflow-list.tsx`
  (workflows).

### Server discovery (Section C of the plan)

- **mDNS plugin**: install `capacitor-zeroconf@4.0.0` from npm
  (`mobile/package.json`). Vendoring into `plugins/capacitor-zeroconf/`
  was deferred — the 2025-05-09 upstream commit explicitly targets
  Capacitor 7, has TXT-record support, and matches our `_cognia._tcp`
  spec. We reserve the right to vendor when the Android 14+
  `NsdManager.resolveService()` deprecation becomes blocking; until
  then `npm install` keeps the dependency graph clean.

- **iOS Local Network compliance**:
  `mobile/scripts/patch-ios-info-plist.mjs` runs after `cap add ios` to
  insert `NSBonjourServices = ["_cognia._tcp"]` plus the bilingual
  `NSLocalNetworkUsageDescription` string into Info.plist. Skipping
  these makes iOS 14+ silently return zero discovery results.

- **Android multicast**: `CHANGE_WIFI_MULTICAST_STATE` is already in
  `AndroidManifest.xml`.

- **Permission helper**: `lib/connectivity/mdns-permission.ts` wraps
  the iOS one-time Local Network prompt. Denials surface
  `kind: "denied"` so the scan sheet can show the `openAppSettings()`
  deep link (`lib/capacitor/app-settings.ts`) — Apple does not allow
  programmatic re-prompts.

### PWA layer (Section A of the plan)

- **Serwist 9** (`@serwist/next`) wraps `next.config.ts`. SW disabled
  when `NEXT_PUBLIC_PLATFORM === "mobile"` because the iOS WKWebView
  serves content from the `capacitor://localhost` custom scheme, which
  standard SW registration rejects. The mobile shell relies on the
  Dexie-first sync orchestrator instead.

- `app/sw.ts` runtime caching: `NetworkFirst` (4 s timeout, 1 h max)
  for `/api/v1/_rpc/sync_pull`; `StaleWhileRevalidate` for images;
  `defaultCache` for everything else.

- `app/manifest.ts` ships `cognia` + standalone display + 192/512 SVG
  icons. PNG production icons are a follow-up.

### QR scanner UX (Section D of the plan)

- The "M3.4 stub" note in the plan was stale — `pair-step.tsx` already
  wires `lib/capacitor/barcode.ts`. The real gap was permission-denied
  recovery + a missing "scanning…" indeterminate state.

- `pair-step.tsx` Phase machine now includes `scanning` (renders a
  spinner on the Scan QR button while the native modal launches) and
  the `error` variant carries an optional `action` (label +
  `onAction`). On `permission_denied` the action deep-links to
  `openAppSettings()`.

### Reconnect / scan / switch entry point (Section E of the plan)

- `ConnectionStateBadge` (already in the top bar) becomes a dropdown
  trigger. Menu: **Reconnect now** (re-runs WebRTC handshake + kicks
  the sync orchestrator), **Scan LAN** (opens
  `MobileServerScanSheet`), **Switch paired server** (opens
  `MobilePairedServersSheet`), **Pair new device** (routes to
  `/pair`). A "Last sync" footer reads `snapshotSyncStates()` so users
  can spot which tables are stale.

- `MobileServerScanSheet` drives `scanLan()` + `requestMdnsPermission()`,
  rendering discovered desktops grouped by `mdns`/`probe`/`history`. On
  iOS Local Network denial it shows the `openAppSettings()` CTA via
  the shared `EmptyState`.

- `MobilePairedServersSheet` lists every non-revoked `pairedDevices` row
  from Dexie; tapping routes to `/pair?switchTo=<deviceId>` so the pair
  page can run the device-JWT validation against the target server.

### Workflow list gestures (Section I of the plan)

- `workflow-list.tsx` now wraps each row in `<SwipeRow>` (Run /
  Favorite quick actions) and the list in `<PullToRefresh>`. Long-press
  opens `WorkflowRowActionsSheet` — six actions: Run / Pause / Pin /
  Graph / Delete. `WorkflowDeleteConfirm` deletes the local Dexie row
  only; a server-side mirror RPC is tracked as Wave 5 (would need new
  entries in `MOBILE_OUTBOUND_COMMANDS` + Rust dispatcher).

## Non-goals (Wave 4.0)

- **Vendor mDNS plugin source.** Will revisit when the Android 14+
  deprecation surfaces in production.
- **Inbox mobile variant** (Plan section F) — deferred to Wave 4.1;
  desktop `/inbox` reflows responsively today, but a segmented mobile
  surface (Drafts / Messages / All) with swipe-approve/reject lands
  separately.
- **Backup full flow on mobile** (Plan section G) —
  `mobile-backup-section.tsx` ships passphrase export + history list;
  share-sheet integration + schedule CRUD + import preview deferred to
  Wave 4.1.
- **Twin Source editor** (Plan section H) — read-only mobile panel
  remains; long-press editor + redact preview + camera-OCR add path
  deferred to Wave 4.1.
- **Capacitor scheme migration** to `https://localhost` for iOS to
  enable Service Workers there — high blast radius (CapacitorHttp
  pinning, auth, WebRTC) vs the value of mobile PWA (already covered
  by the Dexie-first sync model).

## Consequences

- **Cold-start UX** on mobile: previously the first launch on every
  device blocked on a full snapshot pull; now it serves from Dexie
  immediately and refreshes in the background.
- **Server outage UX**: chat / workflow / discover screens still
  render real data when the desktop is unreachable; the
  `ConnectionStateBadge` dropdown surfaces the recovery actions
  (reconnect / scan / switch) the user previously had to navigate to
  `/pair` to find.
- **iOS Local Network friction**: first-run prompt appears at the
  first `Scan LAN` tap (not at boot). Denials are recoverable via
  Settings deep link but cannot be programmatically re-prompted.
- **Schema bump**: Dexie v44 — additive, no upgrade hook. Pre-v44
  installs start with an empty cursor table and the orchestrator
  resumes from `since: 0` (idempotent).
- **Bundle size**: web/Tauri builds add ~30 KB for the Serwist SW
  source; mobile bundle is unchanged (Serwist disabled there).

## Verification

- `pnpm lint:i18n` — parity gate (both en + zh-CN).
- `pnpm typecheck` — Serwist + cursor-store types resolve.
- `pnpm test:coverage` — orchestrator + new handlers + cursor-store
  - permission helper + app-settings ≥90%.
- `pnpm build` — confirm `out/sw.js` + `out/manifest.webmanifest`
  exist for web.
- `cross-env NEXT_PUBLIC_PLATFORM=mobile pnpm build` — confirm SW
  bundle is **not** generated (Serwist disabled).
- `pnpm mobile:sync` — `capacitor-zeroconf` registers in the cap
  plugin list; `mobile/scripts/patch-ios-info-plist.mjs` is wired
  into `mobile/package.json` `add:ios`.

## Open follow-ups

1. PNG icons for `app/manifest.ts` (currently SVG placeholders).
2. Inbox / Backup / Twin Source editor — Plan sections F / G / H.
3. `workflow_delete` and `workflow_schedule_pause` RPC mirrors in
   `MOBILE_OUTBOUND_COMMANDS` + `src-tauri/src/companion_api/rpc.rs`
   so mobile-side workflow CRUD round-trips back to the desktop.
4. Tauri SW registration verification on macOS / Win / Linux — the
   `tauri://localhost` scheme is not formally documented as
   SW-compatible; if registration fails silently the app degrades to
   no-PWA on desktop with zero user-visible impact.

## Current-state amendment (2026-08-13)

PNG manifest assets, mobile Inbox, backup/import/reminders, Twin long-press/redaction/camera flows, and workflow delete/pause RPC mirrors are now present. The remaining open item is real Tauri service-worker smoke coverage across macOS, Windows, and Linux; the historical feature checklist must not be treated as current missing functionality.
