# Remaining Capacitor integrations: API and device compatibility audit

Date: 2026-10-02. Scope: installed dependencies, native implementations, current upstream documentation, application wrappers and reachable callers. Camera, barcode and biometric repairs are covered separately in the preceding audit. The baseline findings below are retained as evidence; the repair status describes the subsequent implementation. Neither phase operated real credentials, recording, notifications or device settings.

## Repair status — 2026-10-02

| Findings  | Implemented repair                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1–S3     | Patched SecureStorage 0.13.0 to remove the reversible Base64 fallback and reject Keystore, encryption and persistence failures. Callers distinguish the exact missing-item error from storage failure. Existing aliases and ciphertext format are preserved; a missing key with existing entries fails without replacement. Excluded `cap_sec.xml` from legacy backup, cloud backup and device transfer.                   |
| N1–N2     | Use the native ZeroConf watch callback and fully qualified service type. Shared scan leases prevent consumers from stopping one another. Patched Android/iOS stop, restart, callback retirement and resource cleanup, including partial initialization failure.                                                                                                                                                            |
| N3–N6     | Ordinary local notifications explicitly use non-exact scheduling. Accept coarse location and explicitly enable Android system-location fallback. Restore reminder state from native pending notifications and serialize changes/cancellation. LAN-only Wi-Fi reconnects and WebDAV discovery no longer depend solely on Internet validation; the offline banner respects an online Host.                                   |
| N7, F2–F3 | Added the location usage declaration, Files visibility flags and Filesystem privacy reason C617.1. Registered the privacy manifest and localized permission descriptions in the iOS target. This does not request background location or disable iPad multitasking.                                                                                                                                                        |
| F1, F4    | Backup export uses the shared native save path and reports cancellation/failure accurately. Clipboard text reads reject non-text MIME data.                                                                                                                                                                                                                                                                                |
| H1–H2     | Shared request serialization preserves binary buffers, sliced views, Blob, FormData and URLSearchParams with the native decoding metadata. Binary downloads and JSON responses are decoded appropriately. Pre-aborted requests do not dispatch; cancellation/timeout releases the JS wait and discards late results, including security attestation. Stock Capacitor still cannot cancel already-issued native I/O.        |
| H3        | Removed ineffective self-signed options from stock HTTP calls. Mobile WebDAV rejects the unsupported certificate override before sending credentials and explains the restriction in both locales. Existing native certificate-pin capability checks still fail closed. Native pinning/invalid-certificate acceptance has not been implemented.                                                                            |
| U1        | Removed placeholder and incorrect distribution links. Catalog-provided external URLs support non-Play distribution after GMS detection. Fixed cancellation code 1, downloaded status 11 and Android version-code handling. Readiness events/resume refresh Update Center; installation requires explicit consent and respects Play flow availability. The optional native AppUpdate plugin remains absent from this build. |

The shell follow-up also corrected seven API/lifecycle issues:

1. Status Bar enum semantics: `DARK` selects light text for a dark background.
2. iOS status-bar background synchronization and observable background-setting failure.
3. OAuth browser launch failure, dismissal, timeout and cancellation, including late registration/open cleanup and manual-paste flows.
4. One-shot haptics now call `impact("light")`.
5. Partial keyboard listener registration cleans up successful listeners and ignores late callbacks.
6. Native Settings `{status:false}` is reported as failure.
7. Orientation checks account for Android 16/API 36 large-screen restrictions and iPad multitasking; the editor reports actual pending/unavailable results and serializes lock transitions.

### Repair verification

- Combined regression: **63 suites, 903 tests passed**, including all 34 Capacitor wrapper suites and affected callers. Result: `/tmp/cognia-capacitor-repair-final-jest.json`.
- Additional companion binary/media/relay regression: **13 tests passed**, 191 outside the selected cases skipped. An earlier full companion suite encountered the existing socket-acknowledgement timeout test (`does not answer from the acknowledgement of a socket that has since dropped`); the full companion suite is not reported as passing.
- Native configuration/policy checks: **23 tests passed** across iOS plist/resource linkage, secure storage, mDNS and orientation. These are source/configuration regressions, not device instrumentation.
- Scoped TypeScript (including affected tests), ESLint, locale build freshness and i18n parity/reference checks passed. TypeScript required a larger Node heap after the default 4 GiB limit was exhausted. The repository-wide TypeScript run has unrelated existing failures; it is not reported as passing.
- Offline frozen installation of the patched mobile dependencies and `cap update android` passed. Android `:app:compileDebugJavaWithJavac --offline` passed with the actual patched SecureStorage and ZeroConf modules compiled: 369 tasks, 39 executed. Log: `/tmp/cognia-native-services-app-compile.log`. This is compilation, not APK installation or device acceptance.
- iOS plist, privacy manifest and project syntax checks passed; patched ZeroConf Swift passed syntax parsing. `cap update ios` reached `pod install` but failed because only Command Line Tools are selected: `xcode-select: error: tool 'xcodebuild' requires Xcode`. Podfile and lockfile local-source paths were refreshed without changing pod versions; generated Pods projects still require `pod install` under full Xcode. No iOS build is claimed.

### Remaining acceptance and capability limits

Real no-GMS Android and iOS devices still need secure-storage restart/failure, repeated LAN discovery, approximate-location, notification/reminder, export cancellation, binary transfer, OAuth dismissal and orientation checks. No vendor push channels were added: Android background remote push remains FCM-dependent. Non-Play updates require a valid signed-catalog distribution URL. Historical insecure fallback data is not automatically guessed or migrated, and existing secrets were not deleted.

Sources: [Capacitor HTTP](https://capacitorjs.com/docs/apis/http), [Geolocation](https://capacitorjs.com/docs/apis/geolocation), [Local Notifications](https://capacitorjs.com/docs/apis/local-notifications), [Filesystem](https://capacitorjs.com/docs/apis/filesystem), [Status Bar](https://capacitorjs.com/docs/apis/status-bar), [Screen Orientation](https://capacitorjs.com/docs/apis/screen-orientation), [Capawesome App Update](https://capawesome.io/docs/sdks/capacitor/app-update/).

## Original audit findings (before repairs)

## Assessment

There are concrete defects in secure storage, LAN discovery, notification scheduling, permission handling, exports and native HTTP. Several tests only verify our assumed plugin shape, so passing them does not establish agreement with the native contract. GMS is not a universal dependency: installed Geolocation already has an Android system-location fallback, while background Android push remains FCM-dependent.

Prioritize secure-storage failure behavior, then discovery, binary uploads and notification behavior. Do not fix compatibility by silently weakening protection or by adding permissions indiscriminately.

## Verification

- Verified installed versions, not just manifest ranges: Capacitor core/Android/iOS/CLI **8.5.2**; individual plugin versions appear in the inventory below.
- Ran `node node_modules/jest/bin/jest.js lib/capacitor --roots lib/capacitor --runInBand --no-cache`: **33 suites, 385 tests passed**. This baseline includes the previously repaired wrappers. Result file: `/tmp/cognia-capacitor-other-wrapper-tests.json`.
- A temporary harness bundles the actual HTTP and app-update wrappers, replacing only native/platform boundaries with synthetic functions. `/tmp/cognia-capacitor-other-audit.cjs` reproduced missing binary decoding metadata, dispatch of an already-aborted request, and incorrect update-cancellation classification. No network request was made.
- Separate synthetic wrapper checks reproduced approximate-location rejection, missing mDNS callback delivery and omission of the local-notification exactness option.
- Native implementation inspection confirms storage error/fallback branches and plugin contracts. These are code-path findings; no OEM-specific Keystore failure, physical location, LAN scan, notification delivery or download was exercised on a real phone.
- No new APK/IPA build, full repository typecheck, coverage run or store submission was performed in this audit.

## Secure storage

### S1 — P1: Keystore initialization failure silently selects reversible storage

Installed `capacitor-secure-storage-plugin@0.13.0`, `android/src/main/java/com/whitestein/securestorage/PasswordStorageHelper.java:65` selects `PasswordStorageHelper_SDK16` when modern Keystore initialization fails. Its write path at line 117 stores Base64 in `cap_sec` SharedPreferences. This fallback is not restricted to legacy Android versions.

Reachable callers include `lib/companion/credential-book/stores.ts:261` (pairing private JWK), `lib/credentials/keyring-store.ts:102` and `lib/credentials/turn-credentials.ts:129`. No failure indication tells those callers that encryption was lost. A JS read-back cannot distinguish this downgrade. The native implementation must reject unsupported secure storage rather than silently encoding secrets.

Source: [upstream storage implementation](https://github.com/martinkasa/capacitor-secure-storage-plugin/blob/master/android/src/main/java/com/whitestein/securestorage/PasswordStorageHelper.java).

### S2 — P1: Native storage can acknowledge a write that did not persist

In the same native helper, line 252 returns without writing when a certificate is absent, lines 266–269 swallow failures, and line 265 ignores the SharedPreferences `commit()` result. `SecureStoragePluginPlugin.java:88–92` nevertheless returns `{value:true}`. The callers above await `set` and then treat their key as durable. Pairing or saved credentials can consequently disappear after restart when these failure branches occur.

Repair the native success/error contract, then verify persistence using synthetic failure injection. This is not evidence that ordinary successful writes fail on every phone.

Source: [native implementation](https://github.com/martinkasa/capacitor-secure-storage-plugin/blob/master/android/src/main/java/com/whitestein/securestorage/PasswordStorageHelper.java), [plugin API](https://github.com/martinkasa/capacitor-secure-storage-plugin).

### S3 — P2: Android backup includes device-bound secure-storage data

`mobile/android/app/src/main/AndroidManifest.xml:6` enables backup. `res/xml/backup_rules.xml:2` and `data_extraction_rules.xml:3,8` exclude diagnostic files but not `sharedpref/cap_sec.xml`. A restored ciphertext file does not recreate its original Android Keystore key. Reads may then appear to be missing credentials; S1 would make the backed-up value only Base64-encoded in the fallback case.

Exclude device-bound secret storage from legacy backup, cloud backup and device transfer, and explicitly require re-pairing after restoration. Source: [Android backup rules](https://developer.android.com/identity/data/autobackup).

## Discovery, connectivity, permissions and notifications

### N1 — P1: Native mDNS results use a different callback contract

`lib/connectivity/mdns-discovery.ts:101` calls `watch(options)` and subscribes separately to `discover`. Installed ZeroConf 4.0.0 Android/iOS sends results through the persistent `watch(options, callback)` callback; it does not emit that native event. Additionally, Android concatenates our `_cognia._tcp` type with `local.`, producing `_cognia._tcplocal.` instead of `_cognia._tcp.local.`.

The synthetic wrapper check observed no callback argument and zero discoveries. The nearby-device flow therefore has to rely on other probes. The package README's event-style example conflicts with its installed native implementation, so matching the README alone is insufficient.

Sources: [native plugin callback](https://raw.githubusercontent.com/trik/capacitor-zeroconf/main/android/src/main/java/io/trik/capacitor/zeroconf/ZeroConfPlugin.java), [native service-type construction](https://raw.githubusercontent.com/trik/capacitor-zeroconf/main/android/src/main/java/io/trik/capacitor/zeroconf/ZeroConf.java).

### N2 — P2: ZeroConf stop/restart does not reset native discovery resources

`lib/connectivity/mdns-discovery.ts:104` stops via `unwatch`. The installed Android implementation creates/registers `browserManager` only when it is null, but unwatch does not clear it. A later watch does not recreate the subscription. Its multicast lock is released by `close()`, not ordinary unwatch. Fixing N1 alone therefore leaves rescanning and cleanup defective. This combines an upstream native lifecycle defect with insufficient adaptation in our caller.

Source: [ZeroConf native lifecycle](https://raw.githubusercontent.com/trik/capacitor-zeroconf/main/android/src/main/java/io/trik/capacitor/zeroconf/ZeroConf.java).

### N3 — P2: Ordinary notifications can open exact-alarm settings

`lib/capacitor/local-notifications.ts:155` omits `isExactNotification` and does not expose the option. Installed Local Notifications 8.3.1 defaults it to true. Its Android scheduling path checks the flag even for notifications without a schedule and can open the system Alarms & reminders screen when access is absent.

Reachable immediate-notification callers include `lib/notifications/runtime.ts:86` and `lib/companion/remote-step-server.ts:107`. Set ordinary notifications explicitly to non-exact; handle genuinely exact reminders separately. The synthetic check confirms the missing option, not an actual device settings launch.

Source: [current Local Notifications API](https://capacitorjs.com/docs/apis/local-notifications).

### N4 — P2: Android approximate-location permission is rejected

`lib/capacitor/geolocation.ts:76` checks `location` but ignores `coarseLocation`, even when high accuracy is not requested. `{location:"denied",coarseLocation:"granted"}` prompts again and returns `permission_denied` without attempting location. This reaches the remote workflow location step at `lib/companion/remote-step-server.ts:86`. Synthetic result: one permission request, zero position calls.

Source: [Geolocation permission aliases](https://capacitorjs.com/docs/apis/geolocation).

### N5 — P2: Disabling automatic backup leaves its native reminder scheduled

`components/mobile/backup/mobile-backup-section.tsx:137` schedules repeating notification 91001 when enabled. Disabling only returns from the effect; it never calls cancel. The enabled flag is page-local and initially false, so a reopened page can display off while the OS retains a daily reminder. `every:"day",count:1` is a repeating interval, not a one-shot notification.

Cancel explicitly on disable, persist the preference and handle a schedule request completing after disable. Source: [notification cancel API](https://capacitorjs.com/docs/apis/local-notifications#cancel).

### N6 — P2: Internet validation is used as a proxy for LAN reachability

Installed Network 8.0.1 Android `Network.java:80–82` sets `connected` only when both `NET_CAPABILITY_VALIDATED` and `INTERNET` are present. `lib/signaling/mobile-controller.ts:452` gates LAN re-discovery on that value; `components/providers/webdav-mobile-autosync-provider.tsx:59` similarly skips synchronization. A foreground transition to an isolated Wi-Fi network that reaches the desktop/NAS can therefore miss reconnect/sync until another event, such as resume, occurs.

Use network changes to trigger target-specific reachability checks; Internet validation does not establish local reachability. Source: [Android network capability semantics](https://developer.android.com/develop/connectivity/network-ops/reading-network-state).

### N7 — P2, release configuration: Missing documented iOS location usage key

`mobile/ios/App/App/Info.plist:62` has `NSLocationWhenInUseUsageDescription` but lacks `NSLocationAlwaysAndWhenInUseUsageDescription`. Current Geolocation v8 documentation requires both because of the linked iOS location library. Adding the documented description does not mean requesting background location. This audit does not claim that current foreground location necessarily crashes.

Source: [Geolocation iOS configuration](https://capacitorjs.com/docs/apis/geolocation#ios).

## Files, clipboard and exports

### F1 — P2: General backup export bypasses the native save path

`hooks/data/use-full-backup.ts:91–100` sends every non-Tauri runtime through a `blob:` anchor download, including Capacitor, then records success at line 102. It is reachable through `components/settings/data/data-section.tsx:62` and `tabs/backup-restore-tab.tsx:88`. It bypasses the project's existing native-aware `lib/files/download.ts` / `save-export.ts` handling of WebView download limitations.

The dedicated mobile backup surface already uses `saveExport` at `mobile-backup-section.tsx:111`. Reuse that delivery boundary and propagate cancellation/failure. Source tracing confirms the bypass and premature success bookkeeping; no real-phone download was attempted.

### F2 — P2: iOS Documents exports are not exposed through Files

`lib/files/save-export.ts:114` defaults to Documents. The app Info.plist lacks both `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace`. Consequently, the promised saved export lacks the documented Files-app access path after the immediate toast/share action disappears. This does not mean the file was never written; immediate sharing can still work.

Source: [Filesystem iOS configuration](https://capacitorjs.com/docs/apis/filesystem).

### F3 — P2, release configuration: Filesystem privacy manifest is missing

No app `PrivacyInfo.xcprivacy` or Xcode resource reference exists. Installed Filesystem 8.1.3 uses file timestamps, for which current documentation requires `NSPrivacyAccessedAPICategoryFileTimestamp`, recommending `C617.1`. The Capacitor core manifest's empty categories do not supply this declaration. This is a release declaration gap, not a runtime permission prompt.

Do not add an old Device disk-capacity declaration without evidence: installed Device 8.0.3 no longer calls those APIs. Sources: [Filesystem privacy requirement](https://capacitorjs.com/docs/apis/filesystem), [privacy manifest setup](https://capacitorjs.com/docs/ios/privacy-manifest), [current Device API](https://capacitorjs.com/docs/apis/device).

### F4 — P3: Native readText returns image data as text

`lib/capacitor/clipboard.ts:45–46` ignores `res.type`. Installed iOS Clipboard returns image data URLs with `type:"image/png"`; the global bridge at lines 98–100 exposes that as `navigator.clipboard.readText()`. Pairing and workflow paste can receive a whole image data URL instead of textual clipboard content. Filter text-compatible types or use a distinct image API.

Source: [Clipboard result contract](https://capacitorjs.com/docs/apis/clipboard).

## Native HTTP and updates

### H1 — P1: Binary uploads are transmitted as Base64 text

`lib/network/platform-fetch.ts:138–154` encodes bytes but omits `dataType:"file"`. Both installed Android `CapacitorHttpUrlConnection.java:211–240` and iOS `CapacitorUrlRequest.swift:174–188` decode Base64 only with the appropriate data type; otherwise a string is sent as text.

Actual-wrapper synthetic input `00 01 02 fd` produced `data:"AAEC/Q=="` with no `dataType`; the native default string branch emits hexadecimal `414145432f513d3d`. This affects `DiagnosticServiceClient.uploadPart` at `lib/diagnostic-service/client.ts:263`, used by mobile incident submission and support reports. The service verifies original-byte hashes (`services/diagnostic-server/src/api.rs:455`), so corrupted parts fail with `part_checksum_mismatch`. The current unit test checks the Base64 string but not decoding metadata, explaining its pass.

Source: [Capacitor HTTP request data contract](https://capacitorjs.com/docs/apis/http).

### H2 — P2: Fetch cancellation is dropped on the native branch

`lib/network/platform-fetch.ts:123–154` creates a Request but neither checks its signal nor implements cancellation around native dispatch. The synthetic harness passed an already-aborted signal: one native request was still issued and the promise resolved. `lib/updates/catalog-client.ts:117–124` relies on AbortController cancellation; native read/connect timeouts are not equivalent to that contract. `pinnedFetch` likewise accepts RequestInit but ignores its signal on native requests.

At minimum reject before dispatch and discard late responses after cancellation. A Promise race alone does not stop an already-issued native request; document that boundary or add an actual native cancel operation. Source: [supported Capacitor HTTP options](https://capacitorjs.com/docs/apis/http).

### H3 — P2: Self-signed trust is configured through unsupported HTTP options

`lib/webdav/transport.ts:75`, `lib/connectivity/capacitor-http.ts:104` and LAN/health probes pass `serverTrustMode:"self-signed"`. Stock installed Capacitor HTTP 8.5.2 has no such option or native handler. No custom native implementation or patch implements it. The WebDAV allow-invalid-certificates setting therefore cannot make an otherwise untrusted endpoint work on mobile. Network-security-config comments claiming that this flag accepts arbitrary LAN certificates are inaccurate.

`pinnedFetch` correctly checks a custom security-capability attestation and fails closed when unavailable. Keep that protection: missing self-signed support is not a reason to remove pinning. This finding concerns reachability and misleading capability assumptions, not a demonstrated TLS bypass. Source: [official HTTP options](https://capacitorjs.com/docs/apis/http).

### U1 — P2: Update fallback links do not identify the shipped application

`lib/updates/adapters/mobile-adapter.ts:48–51` defaults to an iOS `id0000000000` placeholder and Android package `cn.cognia.app`; the actual Capacitor app ID is `com.cognia.mobile`. `lib/updates/runtime.ts:55–70` supplies no corrected store URLs. When a catalog candidate does not provide its own external URL, fallback opens the wrong or placeholder listing.

The referenced `@capawesome/capacitor-app-update` package is absent from the mobile manifest, lockfile and native plugin list, so this build cannot perform the wrapped Play in-app update. Unsupported-to-store fallback is intentional, but does not make the default links correct. A Play-only path also does not provide a no-GMS update channel.

An additional latent API mismatch exists at `lib/capacitor/app-update.ts:88`: documented cancellation code is **1**, but the wrapper expects **-1**. An injected result `{code:1}` is classified as `failed`. Repair this before enabling the plugin; it is not a reachable native cancellation bug in the current missing-plugin build.

Source: [Capawesome App Update installation and result codes](https://capawesome.io/docs/sdks/capacitor/app-update/).

## China / no-GMS capability boundaries

| Feature                                                          | Evidence-backed assessment                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Geolocation 8.2.2                                                | Native `enableLocationFallback` defaults true and can use Android LocationManager without GMS. Approximate permission still hits N4. GPS signal, location settings and OEM behavior need device validation.                    |
| Background Android remote push                                   | FCM path only; no HMS/Xiaomi/OPPO/vivo transport found. No-GMS background delivery is not established. The existing Firebase-configuration patch and successful-token gate are useful protections, not a vendor-push fallback. |
| Local notifications, network state, mDNS                         | Do not require GMS; the API/lifecycle issues above affect ordinary Android devices too.                                                                                                                                        |
| Filesystem, sharing, clipboard, native recording, secure storage | Use native system APIs without GMS. Correctness and security still depend on the identified implementation gaps.                                                                                                               |
| Web Speech dictation                                             | Has separate browser/service dependencies; native recorder availability does not guarantee it works without GMS.                                                                                                               |
| Play in-app update                                               | Plugin is not bundled; Play distribution would still require a suitable Play environment. Correct signed-update/store routing needs a separate no-GMS strategy.                                                                |

Sources: [Geolocation fallback](https://capacitorjs.com/docs/apis/geolocation), [Firebase Play Services dependencies](https://firebase.google.com/docs/android/android-play-services), [App Update distribution requirements](https://capawesome.io/docs/sdks/capacitor/app-update/).

## Checked boundaries without a new confirmed blocker

- Native plugin registration consumes actual PluginHeaders, and shared loaders avoid treating Capacitor proxies as promises. Custom crash plugins are registered on Android and iOS. No new cross-cutting registration defect was found.
- Android FileProvider exposes the cache/Documents paths used by current native sharing; no evidence requires adding broader file-provider paths.
- VoiceRecorder 7.0.6 permission/result shapes and microphone declarations match. A record-start/close cleanup weakness exists in the plus-menu recorder, but its production caller sets `showVoice={false}`. Treat it as a dormant risk before enabling that surface, not proof of ongoing recording in current chat.
- iOS APNs entitlement and token forwarding, foreground notification presentation, Android location/notification/network/multicast declarations, and iOS Bonjour/local-network entries are present.
- An optional ML Kit OCR provider references a package not bundled in mobile and explicitly reports unsupported. This is an unavailable optional capability, not evidence that installed native OCR succeeded.

## Dependency inventory

| Area                           | Installed packages / versions                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Bridge                         | core, Android, iOS, CLI 8.5.2                                                                                                    |
| Shell                          | App 8.1.1; Browser 8.0.4; Keyboard 8.0.5; Status Bar 8.0.3; Navigation Bar 8.2.10; Splash Screen 8.0.2; Screen Orientation 8.0.1 |
| Basic interaction              | Device 8.0.3; Dialog 8.0.1; Toast 8.0.1; Haptics 8.0.2; Native Settings 8.2.0                                                    |
| Connectivity and notifications | Network 8.0.1; Geolocation 8.2.2; ZeroConf 4.0.0; Local Notifications 8.3.1; Push Notifications 8.1.2 with existing patch        |
| Files and secrets              | Filesystem 8.1.3; Share 8.0.2; Clipboard 8.0.1; VoiceRecorder 7.0.6; SecureStorage 0.13.0                                        |
| Previously reviewed            | Camera 8.2.4; barcode scanning 8.2.1; Native Biometric 8.7.0 with existing patch                                                 |
| Referenced but absent          | AppUpdate; optional ML Kit text-recognition plugin                                                                               |

## Suggested repair order

1. Remove insecure storage fallback and propagate native write failures; exclude device-bound secrets from Android backups. Preserve existing credentials through a tested migration rather than deleting storage.
2. Correct native mDNS callbacks/type formatting and stop/restart cleanup, binary HTTP encoding, and the exact-notification default.
3. Repair approximate-location permission handling, LAN-only network transitions, and reminder cancellation.
4. Unify export delivery and success reporting; complete iOS Files visibility and required declarations.
5. Align native HTTP cancellation/TLS capabilities and update-distribution links with what the installed bridge actually supports.
6. Run an Android no-GMS and iOS acceptance matrix after changes: real secure persistence across restart, LAN-only Wi-Fi, approximate location, first-time notification permissions, cancelled exports, and system permission/settings changes. Do not equate wrapper unit tests with these device outcomes.
