# Phase B — Push delivery setup

Status: **Code complete, credentials wiring in-memory only, UI pending.**

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

## What still needs human / native work

1. **Settings UI card** — `components/settings/companion/companion-section.tsx` should grow a "Push notifications" card with two forms:
   - **FCM**: textarea for `service-account.json` paste → invokes `companion_push_configure_fcm`.
   - **APNs**: inputs for `key_id`, `team_id`, `bundle_id`, `.p8` content, plus production toggle → invokes `companion_push_configure_apns`.

   Both forms should show a "Configured" badge after success and a Clear button per provider.

2. **Persistent secret storage**
   Today the dispatcher state is in-memory only — `DispatcherSet` re-initializes on every desktop boot, so the user has to re-paste credentials. Two viable paths:
   - **Keyring** (matches the project's `keyring = "3"` dep): per-credential entries under `com.cognia.companion-push/v1`.
   - **Encrypted file** under `<app_data>/cognia/companion/`.

   Recommendation: keyring for the secret material; a small JSON metadata file for non-secret bits (project id, bundle id, expiry stamp).

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
