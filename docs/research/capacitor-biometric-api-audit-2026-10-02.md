# Capacitor biometric API and China-device audit

Date: 2026-10-02. The original audit below records the pre-repair state. The repair update records the subsequently authorized implementation. No real authentication, enrollment, credential access, sign-out or device setting changes were performed.

## Repair update — 2026-10-02

- Upgraded `@capgo/capacitor-native-biometric` from installed **8.6.11** to **8.7.0** and refreshed Android/iOS native dependency references.
- F1–F3: preserve native availability reasons; lockout, bridge failures and hardware errors block protected actions. Recognize cancellation code 11 and localized object errors. Android prompts allow five recognition attempts while retaining OS lockout.
- F4–F9: share backup export policy enforcement across both settings surfaces; authenticate stored-secret copying before retrieving or copying the value; block required secret reveal when mobile enrollment is absent; honor Host removal policy; authenticate policy weakening on native mobile; show localized test outcomes. Backup export retains the explicitly chosen no-enrollment recovery behavior.
- F10: the user selected a separate native biometric account-unlock method. Mobile no longer offers the unintegrated WebAuthn Passkey flow. Browser Passkey behavior remains available on supported browsers.
- Native account enrollment generates a random 256-bit secret and stores it with `BIOMETRY_CURRENT_SET`, per-operation authentication, and device-local OS protection. An authenticated `getSecureData` must return that secret before enrollment is committed. The account registry stores its key identifier, while the existing encrypted vault holds the wrapped master key. Password recovery remains available.
- Android account unlock requires **Class 3** biometrics; ordinary sensitive-operation confirmation can use the plugin's supported strong/weak biometrics. Neither native path requires GMS, a Google credential provider, a network connection, or downloaded Google modules. A device with only weak or lock-screen-only face unlock cannot enroll the protected account key.
- A focused pnpm patch repairs two additional upstream problems: both Android key-generation paths previously retried without enrollment invalidation on a provider exception; they now fail safely. `getSecureData` now forwards five attempts instead of inheriting the one-attempt default. OEMs unable to enforce CurrentSet must use the account password, rather than receiving weaker protection silently.
- Cancelled or failed setup removes the candidate key and preserves the previous enrollment. Vault replacement and registry persistence are coordinated with transaction rollback and compare-and-swap compensation across their separate databases. Account-change/lock checks discard stale native results; password fallback remains visible even when all enrolled methods are unsupported on the current platform.

### Repair verification

- Combined targeted regression run: **27 suites, 635 tests passed**. Includes the real IndexedDB vault tests, account store, native facade/helper, policy editors, sensitive-action callers and lock-screen/settings components. React `act(...)` warnings were emitted by several asynchronous UI tests; no test failed. Results: `/tmp/cognia-biometric-final-jest.json`.
- Subsequent focused checks passed for compare-and-swap protection during unlock, exact-session revocation and immediate invalidation when Lock is requested. The final account-store run passed **139 tests** with bounded roots and `--no-cache`; an earlier retry failed before tests because Jest could not persist its cache (`ENOSPC`). These are overlapping focused reruns, not additional counts to add to the 635-test run. Final log: `/tmp/cognia-biometric-lock-bounded.log`.
- Native patch contracts: **2 passed**, after both failed against unpatched 8.7.0 for the expected unsafe defaults. These inspect installed source and are not sensor tests.
- Android patched native compilation: `:app:compileDebugJavaWithJavac` passed; 369 tasks, including recompilation of the biometric plugin. This is a compilation check, not APK/device acceptance.
- iOS dependency resolution: `pod install --deployment` passed with 28 dependencies / 43 pods. Full iOS build was unavailable because the machine lacks full Xcode; Capacitor's iOS update reported that limitation after regenerating dependency references.
- Scoped ESLint/Prettier checks and TypeScript compilation for the biometric facade/native helper/Passkey/types passed. No full-repository TypeScript or production web build result is claimed.
- Generated both translation catalogs; freshness, ICU validation and i18n lint passed. All new biometric keys were checked in both source locales.
- An isolated browser harness exercised the actual quick-unlock UI with synthetic native boundaries: mobile method selection, cancelled setup, successful setup/password clearing, cancelled unlock and password recovery. No real account secret or native authentication was used.

### Device acceptance procedure

Use a disposable account on the rebuilt native app. Browser simulation and unit tests do not validate the physical sensor or an OEM Keystore.

1. On an Android phone without GMS, enroll a strong fingerprint in system settings. In account security settings, enter the account password and enable Biometric quick unlock. Lock the account and verify that successful fingerprint recognition unlocks the same account. Repeat offline.
2. Cancel setup and unlock prompts; the account must remain locked and no enrollment may be committed. Try an incorrect account password during setup; existing enrollment must keep working.
3. Misplace the finger once, then use the correct finger. The first mismatch must not immediately close the prompt. Trigger system lockout using a disposable test device; sensitive actions must remain blocked, with account password recovery still available.
4. On Android, add a new system fingerprint, or remove all enrolled biometrics. The old protected key must no longer unlock the account. Android's documented invalidation contract does not promise invalidation when only one of several fingerprints is removed. Use the account password, then re-enroll. On devices rejecting CurrentSet key creation, setup must report failure rather than silently weakening protection.
5. Switch accounts, lock the app, or leave the enrollment surface while a prompt is pending. A late result must not enroll or unlock the previous account. Repeat with setup replacement and deletion.
6. Check a face-only phone: Class 2 face recognition may confirm sensitive actions, but must not enroll account quick unlock. Class 1 or lock-screen-only recognition must be reported unavailable. Check iOS Face ID/Touch ID cancellation, lockout, enrollment changes and password recovery separately.
7. Enable protection for backup export, secret reveal and pairing removal. Exercise both backup settings entry points, stored-secret Show and Copy, Host removal, and switching protection off. Cancellation must prevent the protected action; disabled optional policies must not prompt.

Sources: [Capgo 8.7.0 release](https://github.com/Cap-go/capacitor-native-biometric/releases/tag/8.7.0), [8.7.0 API definitions](https://github.com/Cap-go/capacitor-native-biometric/blob/8.7.0/src/definitions.ts), [Android biometric authentication](https://developer.android.com/identity/sign-in/biometric-auth), [AOSP biometric classes](https://source.android.com/docs/security/features/biometric), [Android Keystore enrollment invalidation](<https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder#setInvalidatedByBiometricEnrollment(boolean)>).

## Original audit conclusion

The native biometric dependency is wired and its Android authentication implementation does not depend on GMS. The application cannot yet be described as consistently enforcing biometric authentication: availability errors can bypass guards, several sensitive-action entry points do not apply the same policy, and Android's default one-attempt behavior can look like a broken fingerprint prompt.

Account quick unlock is a separate WebAuthn PRF implementation; native biometric compatibility does not establish passkey compatibility on a particular Android WebView or credential provider.

## Version and documented contract

- Installed: `@capgo/capacitor-native-biometric` **8.6.11**, verified from the installed package, not merely the `^8.6.11` manifest range.
- npm latest at audit time: **8.7.0**, independently confirmed by the upstream release page. Its release notes describe an iOS `getSecureData` fallback-title addition and example updates; upgrading alone cannot repair the application's guard/caller logic.
- Native Android uses AndroidX `BiometricManager` / `BiometricPrompt`. iOS uses `LAContext`.
- Android `USE_BIOMETRIC` / `USE_FINGERPRINT`, iOS `NSFaceIDUsageDescription`, and native plugin registration are present.
- The iOS Pod lock's `7.1.13` is the installed package's hard-coded podspec version. Its source path points to the 8.6.11 package; the lock's label alone is not evidence of stale native code.
- AvailableResult includes `errorCode`, `authenticationStrength`, `strongBiometryIsAvailable` and `deviceIsSecure`. Our facade preserves only `isAvailable` and `biometryType`.
- Installed 8.6.11 definitions/native code are more precise than the website's `IsAvailableOptions.useFallback` text: Android availability can count secure device credentials, while Android verification requires the relevant `allowedBiometryTypes` configuration. Adding `useFallback: true` alone is not an Android PIN fallback implementation.

Sources: [Capgo API](https://capgo.app/docs/plugins/native-biometric/getting-started/), [8.6.11 definitions](https://github.com/Cap-go/capacitor-native-biometric/blob/8.6.11/src/definitions.ts), [8.7.0 release](https://github.com/Cap-go/capacitor-native-biometric/releases/tag/8.7.0), [Android authentication guidance](https://developer.android.com/identity/sign-in/biometric-auth).

## Confirmed findings

### F1 — P1: Availability failures become authentication bypasses

Locations: `lib/capacitor/biometric.ts:74-83,114-115,128`; `hooks/use-biometric-guard.ts:59-85`; `hooks/companion/use-companion-sign-out.ts:57-72`.

The wrapper drops the native availability error, and `verify` maps every `isAvailable:false` to `unavailable`. The default guard interprets false availability as no enrollment and immediately executes the protected action. The direct sign-out flow also accepts `unavailable`.

A concrete native source is the installed iOS plugin: `ios/Sources/NativeBiometricPlugin/NativeBiometricPlugin.swift:103-106` returns false availability and `errorCode:2` for biometric lockout. This is an enrolled authenticator being temporarily blocked, not a device without enrollment. Android hardware-unavailable conditions are likewise not proof of no enrollment. A native authentication rejection with code 1 is also converted to `unavailable` and can fall through after verification has already begun.

The actual TypeScript wrapper and guard were bundled unchanged into a temporary harness. For `{isAvailable:false,biometryType:2,errorCode:2}`, the observed result was `verify => unavailable`, guard `=> ok`, native prompt calls **0**, synthetic protected-action calls **1**. A code-1 verification rejection also executed the synthetic action. Loader failure is similarly indistinguishable from an unsupported platform.

Repair: retain typed availability reasons; distinguish unsupported platform/no enrollment from lockout, temporary hardware failure and bridge failure; fail closed for authentication failures and for mandatory gates. Preserve an explicitly chosen no-enrollment recovery policy rather than deleting it incidentally.

### F2 — P2: Android ends authentication after one unsuccessful recognition

Locations: installed `android/src/main/java/ee/forgr/biometric/AuthActivity.java:89-90,190-196`; `lib/capacitor/biometric.ts:89-95,127`.

The plugin defaults `maxAttempts` to 1. Its first `onAuthenticationFailed` increments the counter, cancels authentication, and returns code 4, which our facade presents as lockout. The facade does not expose or set `maxAttempts`. A poorly positioned finger or a failed face match can therefore immediately close the prompt and report temporary lockout, even without OS-enforced lockout.

This is a verified upstream default plus our configuration/UX gap; it was not reproduced with a physical sensor. Repair: deliberately choose an allowed attempt count, preserve genuine OS lockout behavior, and avoid describing every plugin attempt-limit failure as a proven system lockout.

### F3 — P2: Cancellation code mapping is incomplete

Location: `lib/capacitor/biometric.ts:119-131`.

The facade handles codes 15/16/17 but omits `APP_CANCEL=11`; its comment incorrectly calls 15 app cancellation, although that is system cancellation. A localized message without English `cancel` becomes a generic error. Plain-object rejection messages also become `[object Object]` because the message extractor only accepts `Error` instances.

Reproduction: `{code:"11",message:"认证已中止"}` produces `{kind:"error",message:"[object Object]"}`. It remains blocked, but cancellation/error presentation is wrong. Repair against the installed/public enum, retain object messages, and test localized rejections.

### F4 — P1: General backup export does not apply the biometric export policy

Locations: `components/settings/data/tabs/backup-restore-tab.tsx:94,172`; `hooks/data/use-full-backup.ts:40`; `lib/biometric/prompt.ts:46`.

The `/me/backup` surface applies `biometricRequiredFor.exportBackup`; the general Settings → Data → Backup export and share-preparation handlers do not. The general section is not platform-restricted and is rendered by SettingsShell. Encrypted export has no biometric check. Plaintext export invokes the older `requireBiometric` helper, which uses `window.confirm` on Capacitor and reports `bioVerified:false`.

A confirmation dialog does not satisfy a configured biometric requirement. Repair at the shared export/preparation boundary, then verify both mobile and general settings entry points with required-policy plus cancellation tests. The report does not claim a real backup was exported.

### F5 — P2: Copying a stored secret bypasses its reveal guard

Locations: `components/settings/external-bridge/panels/server-panel.tsx:340-345,393`; `components/settings/gateway/gateway-keys-card.tsx:327-334`.

The external-bridge token Show button uses `useSecretReveal`, but Copy copies the same credential directly. Gateway key Copy calls `gatewayRevealKey` and copies the returned key without the guard. A required reveal check therefore does not cover equivalent disclosure through the clipboard.

Repair: reuse the same policy for stored-secret reveal and copy, without adding prompts to user-entered new password fields. Tests must assert no retrieval/copy when verification is cancelled or fails.

### F6 — P2: Turning off a biometric requirement needs no reauthentication

Locations: `components/settings/security/security-section.tsx:46-49`; `app/me/preferences/page.tsx:84-85`; `app/me/agent/page.tsx:153`.

These settings write the weakened policy directly. On an already unlocked app, a person can switch off a mandatory gate and then use an action that normally requires biometrics. This limits the secondary protection supplied by those controls. Repair: authenticate policy weakening using the existing policy, with a deliberate recovery route for a genuinely unavailable authenticator.

### F7 — P2: No-enrollment reveal behavior contradicts the product description

Locations: `hooks/use-secret-reveal.ts:52`; `i18n/messages/en/settings/security.json:27`.

The description promises that devices without enrolled biometrics block secret reveal. The hook omits `fallthroughWhenUnavailable:false` and deliberately inherits the default pass-through. This is separate from F1's lost error information: even a correctly classified no-enrollment state disagrees with the stated policy. Decide the intended policy and align implementation, platform exceptions and both locales.

### F8 — P2: A Host removal entry point ignores the disabled policy

Location: `components/mobile/connection-state-sheets/mobile-paired-servers-sheet.tsx:136`.

This removal handler always invokes the biometric guard and does not read `deletePairing`, while comparable device-revoke handlers do. Disabling the preference still leaves this entry point prompting. Repair by routing equivalent actions through the same policy-aware boundary.

### F9 — P2: The biometric test button discards its result

Location: `components/settings/security/security-section.tsx:52-61`.

The test requests a strict guard but ignores the returned outcome. If authentication is unavailable or fails before opening a prompt, the button produces no visible explanation; successful verification also has no result feedback. This directly contributes to a perceived unresponsive feature. Surface availability/lockout/cancellation/failure through localized UI rather than treating a settled promise as sufficient feedback.

### F10 — P2: Android account Passkey unlock lacks native WebView integration

Locations: `mobile/android/app/src/main/java/com/cognia/mobile/MainActivity.java:13`; `mobile/capacitor.config.ts:45`; `lib/accounts/quick-unlock/passkey.ts:33,70`.

The account lock screen uses QuickUnlockPanel and WebAuthn PRF, not NativeBiometric. Neither the application nor installed Capacitor 8.5.2 Android code enables `WebSettingsCompat.setWebAuthenticationSupport`; the official API defaults to `WEB_AUTHENTICATION_SUPPORT_NONE`. The required Credential Manager/Digital Asset Links integration is also absent. The current Capacitor host defaults to `localhost`, and the PRF code derives that as its RP ID, rather than establishing an app-owned domain/signing association for the documented FOR_APP flow.

This is a concrete missing integration, not proof that every no-GMS phone lacks passkeys. The JavaScript capability probe does not establish native enablement, provider availability or PRF support. Its later refusal to enroll without proven PRF output is correct. Repair the mobile authentication architecture deliberately; do not substitute an ordinary biometric success boolean for the stable secret required to unwrap the account vault.

Sources: [WebView integration](https://developer.android.com/identity/sign-in/credential-manager-webview), [WebSettingsCompat default](https://developer.android.com/reference/androidx/webkit/WebSettingsCompat#WEB_AUTHENTICATION_SUPPORT_NONE), [credential providers](https://developer.android.com/identity/sign-in/credential-provider).

## China / no-GMS compatibility

| Device capability                                       | Expected native biometric behavior                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| No GMS, enrolled biometric exposed through AndroidX     | Authentication can work locally; no Google module download is involved                                                                      |
| Class 2 face authentication exposed to apps             | Current plugin defaults allow it; weak-only availability is not automatically rejected                                                      |
| Class 3 fingerprint/face exposed to apps                | Supported by the default native prompt                                                                                                      |
| Face unlock available only to the lock screen / Class 1 | Cannot assume third-party BiometricPrompt access; show a truthful unavailable state                                                         |
| PIN/pattern only, no enrolled biometric                 | Current facade does not offer native device-credential fallback                                                                             |
| Hardware temporarily unavailable / authenticator locked | Must block or use an explicitly authorized recovery route, not silently execute                                                             |
| Account Passkey quick unlock                            | Current Android WebView native integration is incomplete (F10); after repair, provider and PRF capability still need independent validation |

These are API capability conditions, not a promise that every model from a particular Chinese brand behaves identically. Android's Class 1 lock-screen support does not imply app API support. Current default strong/weak availability and verification checks agree; no strength mismatch was found. Sensitive operations may need a stronger policy than ordinary confirmation, but that is a product decision rather than an observed API-call defect.

Sources: [AOSP biometric classes](https://source.android.com/docs/security/features/biometric), [AndroidX authenticators](https://developer.android.com/reference/androidx/biometric/BiometricManager.Authenticators), [Android WebView passkey integration](https://developer.android.com/identity/sign-in/credential-manager-webview).

## Validation and boundaries

Root focused run: 5 suites, **40 passed / 1 failed** tests. Four suites passed in full (`biometric`, `use-biometric-guard`, `use-companion-sign-out`, `security-section`). The remaining failure is the existing stored-secret inventory assertion in `hooks/use-secret-reveal.test.tsx:137`.

That assertion flags `components/browser/vault/browser-credential-form-dialog.tsx`, but inspection establishes a false positive: password state starts empty, the edit metadata contains no password, and only newly typed text is submitted. It should be classified as live user input, not gated as a stored-secret reveal. No test or implementation was edited to hide the failure.

The temporary harness `/tmp/cognia-biometric-audit-2026-10-02.cjs` bundles the real wrapper/guard, replaces only React's hook callback boundary, and injects synthetic plugin responses. Its JSON observations are in `/tmp/cognia-biometric-audit-results-2026-10-02.json`. These establish TypeScript classification/control-flow behavior, not a native sensor result.

No physical-device biometric authentication, account unlock, credential retrieval, backup export, or logout was performed. No full build or coverage run was performed. Native enrollment, localized prompt behavior, background cancellation and actual fingerprint/face recognition remain device acceptance work.

## Repair and acceptance order

1. Preserve availability reasons and close F1's failure bypass; tests must assert protected-action count zero on lockout, hardware and bridge failures.
2. Correct Android attempts, complete cancellation mapping, and add result feedback to the test action.
3. Unify policy application across export, secret copy, Host deletion and policy weakening.
4. Decide device-credential fallback and strong/weak requirements explicitly, including recovery when enrollment changes.
5. Verify an actual no-GMS Android device with enrolled fingerprint, face-only capability where available, rejected recognition, user cancellation, backgrounding and enrollment changes. Verify iOS lockout separately.
6. Test Passkey/WebAuthn account unlock independently from native sensitive-action prompts.
