# Huawei Push Kit for the Android companion

The Android APK has an app-local Capacitor plugin, `CogniaHuaweiPush`, using
Huawei Push Kit `6.13.0.301` and AG Connect Gradle plugin `1.9.6.300` (official
Maven versions checked on 2026-10-04). It supports Huawei Android/EMUI devices
with an available HMS Core service. This is not a native HarmonyOS HAP build,
and it does not establish APK compatibility inside a HarmonyOS compatibility
container.

## Build configuration

1. Create an Android app in AppGallery Connect with package `com.cognia.mobile`.
2. Configure the SHA-256 certificate fingerprint of the signing key used by the
   installed APK. Debug and release keys have different fingerprints.
3. Enable Push Kit and complete Huawei's applicable app review/distribution
   prerequisites for notification delivery.
4. Download the app's `agconnect-services.json` and place it at
   `mobile/android/app/agconnect-services.json`. This file is gitignored.
5. Build the Android app using the existing mobile build workflow. The Gradle
   plugin is applied only when that file exists. Ordinary builds without the
   file still compile and report `configured: false` to the web client.
6. Configure the relay's HMS app ID and server client secret separately. Never
   place the server OAuth client secret in JavaScript, Android resources, or a
   `NEXT_PUBLIC_*` variable. See the [relay push configuration documentation](docs/phase-b-push-setup.md).

The client probes GMS/HMS availability without launching installation or update
dialogs. A configured, available HMS provider takes precedence, including on
devices that also have GMS; otherwise the client can use FCM when GMS is available.
Android 13+ notification permission is requested when push is enabled.
System-disabled notifications remain denied on older Android versions too.

## Native bridge and notification contract

The plugin implements `getStatus`, `checkPermissions`, `requestPermissions`,
`register`, and `unregister`. Its four events match Capacitor PushNotifications:
`registration`, `registrationError`, `pushNotificationReceived`, and
`pushNotificationActionPerformed`. `getStatus` returns `{ configured, available,
status }`; `available` requires both build configuration and working HMS.

Both the direct token return and `HmsMessageService.onNewToken` are handled.
The latest token is retained for bridge initialization and excluded from cloud
backup and device transfer. Unregister disables SDK auto-initialization and
deletes the HMS token.

The sender uses notification messages so HMS can display the notification when
the app process is absent. Set `android.notification.click_action` to
`{ "type": 1, "action": "com.cognia.mobile.HUAWEI_PUSH" }` and send a JSON string
in `message.data` containing routing fields plus `title` and `body`. For
foreground delivery to the app, set `android.notification.foreground_show` to
`false`. The plugin normalizes either flattened extras or a JSON `data` extra.
Cold-start and warm-start taps emit the same event with `actionId: "tap"`;
Capacitor retains events until JavaScript attaches its listener. Background
data-only messages that reach the service receive a local native notification
without duplicating HMS-rendered notification messages.

## Verification

Local implementation checks completed on 2026-10-05:

- Frontend push, boot lifecycle, settings, GMS detection, and inbound routing:
  **6 suites / 128 tests passed**.
- Android main and instrumentation Java sources compile; JVM tests:
  **8 passed**. Native wiring policy checks: **5 passed**.
- Targeted frontend ESLint/Prettier and translation generation/parity checks
  passed. Backend and protocol checks are recorded in the
  [relay guide](docs/phase-b-push-setup.md).
- Full frontend TypeScript checking exhausted the Node heap, including a
  higher-heap retry, and is not verified. The local Next.js settings-page
  compilation also exhausted its heap, so browser visual verification remains
  incomplete. No Huawei cloud or device delivery test has been run. Android
  instrumentation tests were compiled, not executed.

Reproduce the native checks and complete device acceptance with:

- Native wiring checks: `rtk node --test mobile/scripts/huawei-push-native-policy.test.mjs`.
- Build and JVM tests: from `mobile/android`, use the repository Android
  toolchain environment and run `rtk ./gradlew :app:compileDebugJavaWithJavac
  :app:compileDebugAndroidTestJavaWithJavac :app:testDebugUnitTest`.
- Android instrumentation tests cover routing payloads, malformed data,
  unrelated intents, consumed tap replay, and unconfigured registration.
- Before claiming delivery support, test on a configured Huawei device:
  permission denial/grant, initial registration, token refresh, foreground
  receive, background tray display, warm/cold tap routing, process termination,
  unregister and re-register. Compiling these tests is not device validation.

## Sources

- [Huawei Android SDK integration](https://developer.huawei.com/consumer/en/doc/HMSCore-Guides/android-integrating-sdk-0000001050040084)
- [Obtaining and deleting a push token](https://developer.huawei.com/consumer/en/doc/HMSCore-Guides/android-client-dev-0000001050042041)
- [Huawei message HTTP API](https://developer.huawei.com/consumer/en/doc/hmscore-references/https-send-api-0000001050986197)
- [Official Push Kit Maven metadata](https://developer.huawei.com/repo/com/huawei/hms/push/maven-metadata.xml)
- [Official AG Connect Maven metadata](https://developer.huawei.com/repo/com/huawei/agconnect/agcp/maven-metadata.xml)
