# Phase B — Push delivery setup

Status: **Code complete. Settings UI + keyring/file persistence shipped. External services (real FCM project + Apple Developer account) needed for end-to-end validation.**

After Phase B the desktop ships real `FcmDispatcher` and `ApnsDispatcher` implementations and a process-wide `DispatcherSet` that the event-bus trigger consults. The remaining work is the credentials UX and persistent secret storage.

## What landed in Phase B

- **B1 — persistent push-token registry**
  `src-tauri/src/companion_api/push.rs::PushTokenRegistry::with_persistence` reads `<app_data>/cognia/companion/push-tokens.json` on construction and writes after every register/revoke. Wired into `CompanionServerState::with_data_dir` (used from `lib.rs::run`).

- **B3 — real dispatchers**
  `src-tauri/src/companion_api/dispatchers.rs`:
  - `FcmDispatcher` — POSTs to FCM HTTP v1 with an OAuth2 bearer fetched from the service-account JWT exchange and cached for one hour.
  - `ApnsDispatcher` — POSTs to APNs over HTTP/2 with an ES256-signed provider JWT. Picks sandbox vs production based on the `production` flag.

- **B2 — Tauri credential commands** (`commands.rs`)
  - `companion_push_configure_fcm({ serviceAccountJson })`
  - `companion_push_configure_apns({ keyId, teamId, bundleId, privateKeyPem, production })`
  - `companion_push_clear_fcm()`
  - `companion_push_clear_apns()`

- **B4 — trigger wiring**
  `register_default_event_channels` installs a `register_push_trigger` for `claude://message-added`. On emit, the listener:
  1. Reads the live `PushTokenRegistry` from Tauri state.
  2. Consults the process-wide `DispatcherSet`.
  3. Calls `broadcast_to_offline` for each provider — which iterates registered devices and skips any with an open WebSocket (suppression already lives in `push.rs:178`).

## Newly landed (this iteration)

- **Settings UI card** — `PushCredentialsCard` in `components/settings/companion/companion-section.tsx` renders an FCM textarea (paste service-account JSON) and an APNs form (key id / team id / bundle id / `.p8` paste / production toggle). Each block shows a "configured" badge when persistent state reports the provider is set, plus a Clear button.

- **Persistent secret storage** — new `companion_api/push_creds.rs` exposes a `PushCredStore` trait with two backends:
  - `KeyringPushCredStore` (service `com.cognia.companion-push/v1`, accounts `fcm` and `apns`) — installed in `lib.rs::run` via the Tauri setup hook.
  - `FilePushCredStore` writing `<COGNIA_DATA_DIR>/push-credentials.{fcm,apns}.json` with 0600 perms on Unix — installed by `cognia-server::run_serve` for headless deployments.
  - `reinstall_persisted_dispatchers()` runs at boot from both entry points so the user's last upload survives a restart.
- **Status command** — `companion_push_status` Tauri command exposes `{ fcmConfigured, apnsConfigured }` for the UI badges.

## What still needs human / native work

3. **External cred validation**
   - FCM project requires Cloud Messaging enabled and a Service Account with the `roles/cloudmessaging.serviceAgent` role. Without a real project, the dispatcher can construct but every send returns `Failed`.
   - APNs requires an active Apple Developer membership ($99/year) and an APNs key issued from the Keys section. Without it, JWT signing fails.

4. **Mobile-side deep-link routing**
   `lib/push/push-notifications.ts` already wires `pushNotificationActionPerformed`. Verify that the `data.sessionId` payload routes to the existing chat route when tapped (the desktop's `register_push_trigger` doesn't yet attach `sessionId` to the payload data — needs the event payload to carry session metadata; trivial follow-up).

5. **Tests with real services**
   - FCM: use the Firebase emulator suite + service-account stub.
   - APNs: Apple ships an APNs sandbox at `api.sandbox.push.apple.com` that accepts the production credential format for development tokens.

## Verification today (without device hardware)

- `cargo check --tests` clean for the new modules.
- `push.rs` tests cover persistence roundtrip, corrupt-file fallback, dispatcher-set state changes, and `broadcast_to_offline` suppression semantics.
- `dispatchers.rs` tests cover constructor wiring + endpoint selection (no real HTTP calls — those need credentials).
- `pnpm typecheck` clean.

The actual delivery path (cred upload → FCM/APNs server roundtrip → device receives notification) needs at minimum:

- A real FCM project and `.json` service-account key.
- An Apple Developer account, an APNs key (`.p8`), and a real iOS/Android device build of the mobile app to receive on.
