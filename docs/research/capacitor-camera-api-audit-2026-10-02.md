# Capacitor camera and scanner audit

Audit date: 2026-10-02. Scope: current working tree, including uncommitted changes. The initial audit was read-only; the findings below preserve that baseline. The subsequent authorized repair changes production code and native dependency configuration as described here.

## Repair status (2026-10-02)

- F1/F3/F4: the canonical scanner wrapper skips application camera authorization for Android's Google scan UI, preserves iOS authorization, recognizes native and module-install cancellation, and bounds module installation at 60 seconds with availability polling and listener/timer cleanup. The historical facade delegates to it.
- F2: `cap update ios` regenerated native paths. `pod install --repo-update` installed current native dependencies, and a subsequent `pod install --deployment` passed with 28 dependencies / 43 pods. The manual KSCrash pin now sits outside the CLI-generated block. Android also declares recommended `barcode_ui` prefetch and legacy save-to-gallery permission capped at SDK 29.
- F5: an app-lifetime `appRestoredResult` listener starts above AccountGate. Before opening native camera/gallery, the wrapper records the destination and originating account/host database. Recoverable camera calls request a file URI and convert it to the caller's requested representation during normal completion. Only file URIs and routing metadata enter the local recovery inbox; photo bytes remain in the native cache. Chat consumes after draft hydration through the existing attachment gate; Twin consumes through its existing outbound queue. The receipt is retained for up to 24 hours until its destination is available. Workflow captures retain their existing interrupted-step receipt semantics.
- F6/F7: FileReader failures return an error outcome. Native and web results enforce the requested album count (default nine, non-positive unlimited); the web path caps before allocating object URLs.

Recovery review also added checks after asynchronous image preparation, retention when the attachment gate refuses every image, remount handoff while an older consumer is loading, and rejection of failed URI responses. Restored native failures produce the localized photo error at the originating destination; cancellations are acknowledged silently. Camera/album errors use translated UI copy in both language catalogs. Partial album acceptance uses the existing attachment gate's warning and acknowledges the batch, avoiding replay of already-staged files.

Native compilation and physical camera acceptance remain outstanding: this machine has Command Line Tools but no Xcode. A full TypeScript check was attempted with an 8 GB heap and terminated with `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`; it is not a passing type gate. Focused repair validation is recorded below separately from the initial audit tests.

### Final repair validation

- Combined Jest run: **16 suites / 310 tests passed**, 23.819 seconds. Includes camera, recovery inbox, App listener, native registration/shared loader, scanner, legacy facade, remote workflow steps, recovery hook, early initializer, chat composer/intake, attachment conversion, menu, Twin intake, and pairing.
- Jest indexing was bounded with `--roots lib/capacitor lib/qr lib/companion hooks components/providers/initializers components/mobile components/connectivity/pair components/chat`; the original whole-repository crawl was terminated only for this task's processes. No test configuration or coverage setting was changed. Individual UI runs still emit existing React `act` warnings; the final combined run used `--silent`.
- Scoped ESLint and `git diff --check` passed. New recovery files and edited camera/UI paths were formatted; unrelated pre-existing formatting in the large shared Composer files was preserved.
- `pnpm i18n:build`, `pnpm i18n:build:check`, and `pnpm lint:i18n` passed. The new `mobile.composerPlus.photoFailed` key exists in both split language catalogs.
- `pod install --deployment` passed (28 dependencies / 43 pods), with unchanged Podfile/lock hashes during verification. All 27 referenced Podfile paths and 26 lockfile local paths exist. Android manifest XML, scanner prefetch, and legacy save permission checks passed. No tracked native Web assets changed.
- No browser E2E, physical camera, or native compilation result is claimed. The real-device acceptance matrix below remains applicable. No coverage run was requested or performed.

The current literal API arguments and result fields are valid, but permission policy, cancellation, recovery, fallback behavior, and iOS native dependency freshness have defects. Existing mocked tests do not establish native camera acceptance.

Official documentation and exact installed-version details are recorded in [the source research](/Users/bytedance/Project/cognia-next/docs/research/capacitor-camera-api-docs-2026-10-02.md).

## Version and runtime inventory

Installed and registry-latest versions on the audit date: Capacitor core/platforms 8.5.2, Camera 8.2.4, ML Kit Barcode Scanning 8.2.1. App is installed at 8.1.1. The historical ADR still describes Capacitor 7; installed metadata and versioned source were used for current contracts.

| User path                                  | Active implementation                                                                                                             | Native/API boundary                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Pairing QR scan, including automatic entry | `components/connectivity/pair/pair-step.tsx:344` → `lib/capacitor/barcode.ts`                                                     | `BarcodeScanner.scan({ formats: ['QR_CODE'] })`                                                       |
| Chat camera attachment                     | `components/chat/composer/composer-box.tsx:522` → `components/mobile/chat/composer-plus-menu.tsx:314` → `lib/capacitor/camera.ts` | `getPhoto`, Camera source, base64 result                                                              |
| Chat album attachment                      | Same menu, `onAlbum` → `pickMultiplePhotos`                                                                                       | `pickImages({ quality, limit: 9 })`                                                                   |
| Twin document photo ingestion              | `discover-mobile-body.tsx:413` → `twin-sources-panel.tsx:178`                                                                     | Camera base64 → queued `twin_source_create`                                                           |
| Mobile workflow camera/barcode step        | `lib/companion/remote-step-server.ts:60` and `:70`                                                                                | Same camera/scanner wrappers; remote receipt recovery exists                                          |
| Native-plugin setup                        | Early initializer and `CompanionBootProvider` → `registerNativePlugins`                                                           | `@capacitor/core.registerPlugin` for native PluginHeaders; shared loader suppresses proxy thenability |
| Browser/PWA camera fallback                | `lib/capacitor/camera.ts:92`                                                                                                      | HTML file input, `capture="environment"` for camera                                                   |
| Historical QR facade                       | `lib/qr/barcode-scanner.ts`                                                                                                       | No current production caller found; remaining callers are tests                                       |

The first-party frontend media-stream calls found use microphone audio or screen capture, not live camera video. No separate Camera Preview, Document Scanner, ImageCapture, or video-recording integration was found in the searched production paths. Generic image/file uploads were checked for explicit capture attributes; the actual camera fallback is centralized in `camera.ts`.

## Findings

### F1 — P1: Android scanner incorrectly requires app camera permission

**Location:** [barcode.ts:139](/Users/bytedance/Project/cognia-next/lib/capacitor/barcode.ts:139).

The wrapper requires `checkPermissions`/`requestPermissions` to produce a usable app camera grant before calling `scan`. On Android this particular API uses Google's scanning UI and does not need the application's camera permission. Its installed Android implementation checks module availability and launches ScanActivity without that permission gate. iOS and custom `startScan` have different requirements. [Capawesome scan API](https://capawesome.io/docs/sdks/capacitor/mlkit/barcode-scanning/#scan), [Google scanner](https://developers.google.com/ml-kit/vision/barcode-scanning/code-scanner).

**Reproduction:** Android platform + denied camera permission returns `permission_denied`; native `scan` is called zero times even when it would return a valid QR payload. Pairing sends the user to Settings unnecessarily. This also affects remote barcode steps.

**Repair:** Branch permission policy by platform and actual method: preserve iOS camera authorization; do not block Android Google `scan` on the application's camera permission. Keep module readiness checks.

### F2 — P1: Checked-in iOS native dependency paths do not resolve

**Location:** [Podfile:1](/Users/bytedance/Project/cognia-next/mobile/ios/App/Podfile:1), `:15`, `:19`, and Podfile.lock.

The Podfile's helper/core references still point to Capacitor 8.4.2, camera to 8.2.0, and scanner to 8.1.0. Current pnpm-installed packages are 8.5.2, 8.2.4, and 8.2.1 respectively. Resolving these referenced paths from the Podfile directory returned `exists=False`, including the first Ruby `require_relative`. Direct pod resolution cannot load that helper in this checkout. Android's generated Gradle plugin paths already point at the current versions.

**Boundary:** This proves configuration drift and missing paths; no iOS compilation or already-installed binary was tested. The normal `cap sync ios` workflow is intended to regenerate dependencies, so this is a stale native project rather than evidence that the documented sync workflow itself fails. [Camera installation workflow](https://capacitorjs.com/docs/apis/camera#install).

**Repair:** Use the existing iOS sync workflow to regenerate native dependency references, verify CocoaPods resolution and build, and keep native and JavaScript versions aligned. Do not hand-edit every pnpm store path as the lasting solution.

### F3 — P2: Native scan cancellation is treated as failure

**Location:** [barcode.ts:157](/Users/bytedance/Project/cognia-next/lib/capacitor/barcode.ts:157); same issue in historical `lib/qr/barcode-scanner.ts`.

Both native platforms reject canceled scanning with `scan canceled.`. The facade returns `cancelled` only for an empty successful barcode array, while every rejection becomes `error`. The active PairStep therefore shows scan failure instead of returning to idle; workflow cancellation becomes a generic error. [Native Android implementation](https://github.com/capawesome-team/capacitor-mlkit/blob/main/packages/barcode-scanning/android/src/main/java/io/capawesome/capacitorjs/plugins/mlkit/barcodescanning/BarcodeScannerPlugin.java).

**Reproduction:** Injecting the exact native cancellation message returns `{ kind: 'error', message: 'scan canceled.' }`.

**Repair:** Normalize documented/native cancellation separately from errors. Module-install cancellation should also retain cancellation semantics. Do not use successful empty arrays as the sole cancellation case.

### F4 — P2: Module-install rejection leaks its listener; waiting is unbounded

**Location:** [barcode.ts:96](/Users/bytedance/Project/cognia-next/lib/capacitor/barcode.ts:96), especially `:121`.

The wrapper correctly waits for installation progress rather than assuming installation acceptance means readiness. However, `cleanup` only runs on terminal events. When `installGoogleBarcodeScannerModule` rejects directly, `.catch(reject)` leaves the native listener installed. There is no deadline or caller cancellation if a terminal event never arrives. The branch without listener support also treats request acceptance as completion, contrary to the API contract. [Installation contract](https://capawesome.io/docs/sdks/capacitor/mlkit/barcode-scanning/#installgooglebarcodescannermodule).

**Reproduction:** Install rejection returns an error with listener removal count zero. A resolving install request without terminal progress remains pending after a bounded 50 ms observation; source inspection establishes there is no subsequent timer or availability recheck. The harness does not establish that a particular physical device drops events.

**Additional race:** Installed native code reports an error if the module becomes installed between availability check and install request. Rechecking availability can distinguish that race from genuine failure.

**Repair:** Guarantee cleanup on all settled paths; bound or cancel the wait; recheck availability as appropriate; never equate acceptance with availability. Avoid launching duplicate installs/scans from competing UI and workflow requests.

### F5 — P2: Android restored camera results have no consumer

**Location:** [app.ts:17](/Users/bytedance/Project/cognia-next/lib/capacitor/app.ts:17), camera call sites, and mobile boot registration.

The frontend has no `appRestoredResult` occurrence across `app`, `components`, `hooks`, `lib`, or `stores`. The App facade exposes resume/back-button events but no restored-result integration. Android may destroy the WebView while a separate camera Activity is open. The old JavaScript promise then cannot route the captured image back to its composer/session or Twin. [Official restoration contract](https://capacitorjs.com/docs/apis/app#addlistenerapprestoredresult).

**Evidence boundary:** A documented lifecycle gap established by source inventory, not a reproduced physical process-death event. Remote workflow receipts already mark interrupted work after restart; that does not recover a chat or Twin photo, and should not be mislabeled absent recovery everywhere.

**Repair:** Persist capture destination context before launch, subscribe early to restored results, validate plugin/method/success, and route recovered data once. Preserve the existing workflow receipt semantics and account/session boundaries.

### F6 — P2: Browser photo read failures escape the declared outcome contract

**Location:** [camera.ts:247](/Users/bytedance/Project/cognia-next/lib/capacitor/camera.ts:247).

The fallback catches picker errors but performs `readFileAsDataUrl(file)` outside that catch. FileReader failure rejects `pickPhoto` instead of returning `{ kind: 'error', message }`. Chat and Twin handlers directly await `pickPhoto` without catching its rejection, so they bypass their normal user-facing error branch.

**Reproduction:** A synthetic FileReader error produced a rejected Promise with `synthetic file read failed` rather than an outcome.

**Repair:** Keep file reading/conversion within the outcome boundary and cover an actual read failure, not just picker cancellation.

### F7 — P2: Album fallback paths do not enforce the requested selection limit

**Location:** [camera.ts:274](/Users/bytedance/Project/cognia-next/lib/capacitor/camera.ts:274), `:302`.

`limit` is passed to native `pickImages` but discarded when selecting the web fallback. The fallback returns every file. The menu explicitly requests nine photos; twelve selected files produce twelve photo results. Android also documents that its `ACTION_OPEN_DOCUMENT` fallback ignores the selection maximum, and the wrapper returns all native photos without a post-selection cap. The browser case was reproduced; the older Android case is supported by official contract and source inspection. Other downstream attachment constraints can mitigate a particular host, but this wrapper does not fulfill its own requested limit.

**Repair:** Preserve and enforce selection-limit semantics for fallback results and account for native system-picker fallbacks that may not enforce a UI selection cap. [Android Photo Picker fallback behavior](https://developer.android.com/training/data-storage/shared/photo-picker).

## Maintenance and conditional issues

- **Deprecated Camera methods:** `getPhoto` and `pickImages` remain implemented in 8.2.4, so their use is not itself a functional break. Migrate deliberately to `takePhoto`/`chooseFromGallery`; the new media result, metadata, URI, and thumbnail semantics require adapting upload/ingest, not merely renaming methods. [Versioned definitions](https://github.com/ionic-team/capacitor-camera/blob/v8.2.4/src/definitions.ts).
- **Historical QR facade:** Its ignored bare import bypasses the global/native loader and thenability protection, and it omits Android module installation. No active production imports were found. Do not claim current pairing uses that broken path; consolidate or retire it when authorized.
- **No Google Play Services (implemented in follow-up below):** Android `scan` inherently depends on GMS. `isSupported()` checks camera hardware and does not certify GMS/module availability. The authorized follow-up adds automatic native detection and a separate bundled-model path.
- **Module prefetch metadata:** The app manifest lacks `com.google.mlkit.vision.DEPENDENCIES=barcode_ui`. Capawesome recommends it; Google's docs describe it as installation-time prefetch. Current explicit module installation is a valid readiness path, so missing prefetch is not independently proof that all scanning fails.
- **Unused save-to-gallery option:** `pickPhoto` exposes `saveToGallery`, but no production caller sets it true. The Android manifest lacks `WRITE_EXTERNAL_STORAGE` for the older Android versions where saving requires it. This is a conditional option/configuration gap, not failure of current false-default photo capture.
- **Web option/resource semantics:** The fallback does not apply native quality/resize/save options and creates blob URLs with no camera-result-specific ownership/revocation path in its consumers. Treat supported options and blob lifetime explicitly, especially for repeated large-image capture.
- **iOS limited access:** No confirmed defect. Apple's old photo authorization overloads report `.authorized` for limited access for compatibility. The wrapper can make a redundant limited-photo request, but the legacy Swift comparison alone does not prove failure. [Apple explanation](https://developer.apple.com/videos/play/wwdc2020/10641/?time=516).
- **Correct setup found:** All three iOS Camera privacy keys and camera/microphone usage strings exist; Android CAMERA and audio permissions exist; installed native platforms already implement WebView capture permission delegates. Current minimum OS targets satisfy the scanner requirements. Ready-made `scan` does not require the CSS transparency/`stopScan` cleanup pattern used by custom preview `startScan`.

## Validation

Existing regression run:

```text
rtk pnpm exec jest --runInBand --runTestsByPath \
  lib/capacitor/camera.test.ts lib/capacitor/barcode.test.ts \
  lib/qr/barcode-scanner.test.ts lib/capacitor/register-plugins.test.ts \
  lib/capacitor/_shared.test.ts lib/capacitor/app.test.ts \
  components/connectivity/pair/pair-step.test.tsx \
  components/mobile/chat/composer-plus-menu.test.tsx \
  components/mobile/discover/twin-sources-panel.test.tsx \
  lib/companion/remote-step-server.test.ts

Test Suites: 10 passed, 10 total
Tests:       174 passed, 174 total
Time:        3.787 s
```

Separate harness: `/tmp/cognia-camera-api-audit-2026-10-02.mjs`, run with `rtk node`. It uses esbuild to load the actual unchanged wrappers into temporary bundles and supplies synthetic plugin/file-reader boundaries. Temporary bundles are removed after execution. Six cases produced the observations recorded in F1, F3, F4, F6, and F7.

Existing browser E2E injection always grants camera permissions, supplies an empty successful result for scan cancellation, and omits module installation methods. Its named permissions-UX test sets `cameraResult: null` while permissions remain granted. Those scenarios do not establish actual permission denial, native cancellation, module download, or process-restored capture. No browser E2E, native build, or physical camera was exercised in this audit; no coverage run was requested or performed.

## Follow-up acceptance matrix

After fixing the findings, exercise real Android/iOS builds separately from mocked tests:

| Scenario                                             | Required result                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Android app CAMERA denied, Google module installed   | Google ready-made scanner opens and returns QR                                         |
| Fresh Android install, module absent                 | Bounded installation feedback, success/retry/cancel, listeners cleaned                 |
| Android without GMS                                  | Explicit supported-product behavior, no indefinite scan wait                           |
| Scanner back/dismiss on Android and iOS              | Cancellation; no failure screen or generic workflow error                              |
| Camera privacy denied / then granted in Settings     | Accurate permission outcome and retry                                                  |
| iOS limited photo library                            | Selected authorized photos attach correctly                                            |
| Android app killed during external camera Activity   | Photo restored to the intended account/session/destination or explicit recovery result |
| Chat camera, album, Twin ingest, remote workflow     | Real native data reaches its existing destination                                      |
| Browser chooser cancel/read failure/over-limit files | Settled outcome, actionable read error, enforced limit                                 |
| Synced iOS project                                   | Native package paths resolve, build uses audited versions                              |

## Implemented follow-up: automatic support without GMS

The canonical `lib/capacitor/barcode.ts` wrapper now checks the app-local Android `CogniaDeviceServices` plugin before every scan. The plugin calls `GoogleApiAvailability.isGooglePlayServicesAvailable`; only `SUCCESS` selects the Google scanner. Missing, disabled, outdated, invalid, failed or timed-out detection selects the existing plugin's bundled ML Kit model through `startScan`. The check is silent and does not request GMS installation. A failure to prepare or open the Google scanner also falls back; explicit user cancellation remains cancellation.

The bundled route requests the application's camera permission and uses one shared, bilingual scan screen above the account gate. It supports the torch when available, closes on back/Escape, page hiding, caller cancellation or workflow deadline, and removes its listeners and stops the camera. Startup is bounded, late CameraX startup is stopped after cancellation, and concurrent scans are excluded. Pairing, the legacy QR facade and remote workflow barcode capture use the same routing. The native barcode model is already included in the installed scanner dependency; this route does not download a GMS scanner module.

Implementation checks include native Java and Android instrumentation-source compilation, focused regression tests, and a browser harness exercising the actual overlay/session at 390 × 844. The harness verifies transparency, background hiding, scroll locking, torch UI, cancellation and focus/background restoration. Core scanner TypeScript is checked with a scoped configuration. These checks do not establish physical-camera decoding: instrumentation was compiled but not run, and no updated APK was installed on a phone. A new Android build containing the local native plugin and updated web assets is required for deployment.

Final follow-up regression: 10 suites / 160 tests passed, including missing/disabled/outdated/invalid/unknown GMS, module failure fallback, permission denial, cancellation, late initialization, and torch taps during startup. Focused ESLint, core TypeScript and i18n freshness checks passed. Android `:app:compileDebugJavaWithJavac` and `:app:compileDebugAndroidTestJavaWithJavac` passed. Coverage was not requested or run.

Sources:

- [Google Play Services availability API](https://developers.google.com/android/reference/com/google/android/gms/common/GoogleApiAvailability)
- [Capawesome barcode scanning API](https://capawesome.io/docs/sdks/capacitor/mlkit/barcode-scanning/)
- [ML Kit bundled Android barcode model](https://developers.google.com/ml-kit/vision/barcode-scanning/android)
- [Google code scanner and its Play Services dependency](https://developers.google.com/ml-kit/vision/barcode-scanning/code-scanner)
