# Phase B — Push delivery setup

Status: **Code complete. Settings UI + keyring/file persistence shipped. External services (real FCM project + Apple Developer account) needed for end-to-end validation.**

After Phase B the desktop ships real `FcmDispatcher` and `ApnsDispatcher` implementations and a process-wide `DispatcherSet` that the event-bus trigger consults. The remaining work is the credentials UX and persistent secret storage.

## What landed in Phase B

- **B1 — persistent push-token registry**
  `crates/cognia-companion-bus/src/push.rs::PushTokenRegistry::with_persistence` reads `<app_data>/cognia/companion/push-tokens.json` on construction and writes after every register/revoke. Wired into `CompanionServerState::with_data_dir` (used from `lib.rs::run`).

- **B3 — real dispatchers**
  `crates/cognia-companion-bus/src/dispatchers.rs`:
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

- **Persistent secret storage** — new `cognia-companion-bus/src/push_creds.rs` exposes a `PushCredStore` trait with two backends:
  - `KeyringPushCredStore` (service `com.cognia.companion-push/v1`, accounts `fcm` and `apns`) — installed in `lib.rs::run` via the Tauri setup hook.
  - `FilePushCredStore` writing `<COGNIA_DATA_DIR>/push-credentials.{fcm,apns}.json` with 0600 perms on Unix — installed by `cognia-server::run_serve` for headless deployments.
  - `reinstall_persisted_dispatchers()` runs at boot from both entry points so the user's last upload survives a restart.
- **Status command** — `companion_push_status` Tauri command exposes `{ fcmConfigured, apnsConfigured }` for the UI badges.

## Huawei Push Kit for Android (2026-10-04)

The host also supports `HmsDispatcher` for an Android APK using Huawei Mobile
Services. This is an HMS Android integration, not a native HarmonyOS HAP.
See [Huawei Android build and device setup](../HUAWEI_PUSH.md) for AppGallery
Connect registration, signing certificates, build configuration, and device checks.

In **Settings → Companion → Push notifications**, configure the Huawei block
with the AppGallery Connect OAuth client ID (shown as App ID in the form) and
Client Secret. Keep the Client Secret on the desktop/headless host; never place it
in client JavaScript or the APK. The host command surface is:

- `companion_push_configure_hms({ appId, clientSecret })`
- `companion_push_clear_hms()`
- `companion_push_status()` returns `hmsConfigured` alongside the existing
  `fcmConfigured` and `apnsConfigured` fields. Configured means credentials were
  saved, not that Huawei has accepted them or a device has received a push.

The same configure/clear commands are available on the owner-authorized
`host.admin` RPC plane for headless deployments. RPC arguments accept both
`appId` / `clientSecret` and `app_id` / `client_secret`. Mobile registration uses
`register_push_token` with `provider: "hms"` and the HMS device token.

Desktop credentials use the existing OS secret store service
`com.cognia.companion-push/v1`, account `hms`. Headless credentials use
`<COGNIA_DATA_DIR>/push-credentials.hms.json` with Unix mode `0600`.
`reinstall_persisted_dispatchers()` restores HMS at boot; a malformed credential
for one provider is reported after the other providers have been restored.

The dispatcher exchanges client credentials at Huawei OAuth v3 and sends Android
notification messages through Push Kit HTTP v1. It caches the bearer until shortly
before expiry, refreshes once after an explicit authentication rejection, and
checks the Huawei application result code even when HTTP returns 200. Transport
failures are not retried automatically because delivery may already have happened.
Invalid device tokens are removed without deleting a newly rotated registration.

HMS participates in both notification-center broadcasts and the shared event
fanout used by the desktop and headless server. Existing audience restrictions
and ready WebSocket/WebRTC stream suppression apply. Native tray notifications
carry the `com.cognia.mobile.HUAWEI_PUSH` click action and routing data; foreground
notifications are delivered to the app callback instead of showing a second tray
notification (`foreground_show: false`).

Backend verification on 2026-10-04:

- `cargo test -p cognia-companion-bus --lib`: **139 passed**, including a local
  HTTP exchange that verifies form encoding, expired-bearer refresh, bearer reuse,
  Huawei service errors, and invalid-token handling. Registry/persistence tests
  also cover token rotation and restoring FCM despite corrupt HMS credentials.
- `cargo test -p cognia-companion-rpc command_services::tests --lib`:
  **6 passed**, including HMS configure, status, persistence, reinstall, and clear.
- `TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test -p cognia-next --lib hms_`:
  **3 passed** for desktop command registration, shared event fanout, and
  registration/revocation through a headless host. The test-only environment
  override skips copying bundled runtime resources; it does not validate packaging.
- `cargo clippy -p cognia-companion-bus --all-targets -- -D warnings`: **passed**.
- `node scripts/build/gen-companion-api.mjs --check`: **passed**, 741 remote
  commands and 107 classified routes. Generator tests: **56 passed**.

The broader command-grammar gate still reports four unrelated existing failures:
three undeclared `agent.host_gateway_task` resources and `ssh_list_host_keys`
pagination. These local checks do not establish real Huawei delivery: a correctly
signed HMS-enabled APK, an enabled AppGallery Connect Push Kit service, valid
host credentials, and a physical device are still required for that acceptance.

Sources: [Huawei OAuth app credentials](https://developer.huawei.com/consumer/en/doc/harmonyos-references/account-api-obtain-app-token),
[Push Kit HTTP v1](https://developer.huawei.com/consumer/en/doc/hmscore-references/https-send-api-0000001050986197).

## What still needs human / native work

3. **External cred validation**
   - FCM project requires Cloud Messaging enabled and a Service Account with the `roles/cloudmessaging.serviceAgent` role. Without a real project, the dispatcher can construct but every send returns `Failed`.
   - APNs requires an active Apple Developer membership ($99/year) and an APNs key issued from the Keys section. Without it, JWT signing fails.

4. **Mobile-side deep-link routing**
   `lib/push/push-notifications.ts` wires `pushNotificationActionPerformed`, and the host preserves routing metadata such as `sessionId` from the source event. Verify actual warm/cold notification taps on the target device; source events still need to supply the relevant routing identifiers.

5. **Tests with real services**
   - FCM: use the Firebase emulator suite + service-account stub.
   - APNs: Apple ships an APNs sandbox at `api.sandbox.push.apple.com` that accepts the production credential format for development tokens.

## Historical Phase B verification (without device hardware)

The following records the earlier Phase B checks, not the HMS change's current
validation. For the 2026-10-05 frontend/native results and TypeScript heap
limitation, see [Huawei verification](../HUAWEI_PUSH.md#verification); backend HMS
results are recorded above.

- `cargo check --tests` clean for the new modules.
- `push.rs` tests cover persistence roundtrip, corrupt-file fallback, dispatcher-set state changes, and `broadcast_to_offline` suppression semantics.
- `dispatchers.rs` tests cover constructor wiring + endpoint selection (no real HTTP calls — those need credentials).
- `pnpm typecheck` clean.

The actual delivery path (cred upload → FCM/APNs server roundtrip → device receives notification) needs at minimum:

- A real FCM project and `.json` service-account key.
- An Apple Developer account, an APNs key (`.p8`), and a real iOS/Android device build of the mobile app to receive on.
