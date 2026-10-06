# iOS Platform Bootstrap

## Status

The Capacitor 8 iOS project is committed under `mobile/ios/`. It targets iOS
16.0 and uses CocoaPods. Native builds require macOS with Xcode 26+.
Installing on a physical device or distributing an IPA also requires Apple
signing credentials; simulator builds do not.

## Daily workflow

```bash
# From the repository root
pnpm install
pnpm mobile:sync:ios
pnpm mobile:open:ios
```

`mobile:sync:ios` prepares browser resources, builds a fresh mobile static
export, and runs the deterministic native configurator before Capacitor sync.
It forces offline mode even when the shell previously used a live development
server. Desktop sidecars are not part of this build. The configurator maintains:

- iOS 16.0 deployment targets in the Podfile and Xcode project
- camera, photo library, microphone, Face ID, location, and local-network
  usage descriptions, including `en` and `zh-Hans` localization
- `_cognia._tcp` Bonjour discovery
- the `cognia://` URL scheme
- local-network-only App Transport Security access
- `remote-notification` and `fetch` background modes
- the Cognia app icon and deep-navy launch screen assets

Run `pnpm -F mobile patch:ios` to reapply only those native settings without
building or syncing the web application.

On a disk-constrained Mac, use
`COGNIA_DISABLE_WEBPACK_CACHE=1 pnpm mobile:sync:ios` to avoid writing the large
persistent webpack cache. This changes build caching only, not the app bundle.

## Regenerating the project

Only regenerate when `mobile/ios/` is missing:

```bash
pnpm -F mobile add:ios
```

The command deliberately selects CocoaPods instead of Swift Package Manager:
`@capacitor-mlkit/barcode-scanning`, `capacitor-voice-recorder`, and
`capacitor-zeroconf` currently need CocoaPods integration. It then applies the
native configuration and synchronizes all Capacitor plugins.

## Apple Developer (one-time)

Required to ship to TestFlight / App Store:

1. Enroll an Apple Developer account ($99/year)
2. Create an App ID `com.cognia.mobile` with capabilities:
   - Push Notifications
   - Associated Domains (for Universal Links if added later)
   - Keychain Sharing (for SecureStorage)
3. Generate an APNs Auth Key (`.p8`) and store securely (referenced by the
   companion server when sending pushes via `lib/push/push-notifications.ts`)
4. Provisioning Profile: Development + Distribution
5. Code-signing: configure in Xcode under "Signing & Capabilities"

## Native verification

On Apple Silicon, install the **universal** iOS simulator runtime: ML Kit's
current binary requires an `x86_64` simulator app, but the simulator OS and
WebKit should boot as `arm64`. These are separate architecture choices.
For Xcode 26.6 / iOS 26.5, booting the entire simulator with `--arch=x86_64`
can crash `com.apple.WebKit.GPU` in Rosetta with `load commands too large`.
The same app runs in an `arm64`-booted universal simulator.

```bash
xcodebuild -downloadPlatform iOS -buildVersion 26.5 -architectureVariant universal
xcrun simctl list devices available
# Use the desired device UUID from the list. Shut it down first if it was
# previously booted in x86_64 mode; this preserves its installed apps/data.
xcrun simctl shutdown <device-uuid>
xcrun simctl boot <device-uuid> --arch=arm64
xcrun simctl bootstatus <device-uuid> -b
```

Keep that simulator running when launching Cognia. Do not exclude `arm64`
from device builds or disable WebKit GPU rendering to work around this
simulator-only loader failure.

Simulator builds need local ad-hoc signing even though they do not need an
Apple Developer certificate. Do **not** pass `CODE_SIGNING_ALLOWED=NO` when
building an app to run: that removes the application identity required by
Keychain, so pairing can register on the desktop and then fail to save its
private key with `errSecMissingEntitlement` (`-34018`). Keep signing enabled:

```bash
xcodebuild -workspace mobile/ios/App/App.xcworkspace -scheme App \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  ARCHS=x86_64 ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build
```

After building, verify the simulator `App.app` with
`codesign --verify --deep --strict <path-to-App.app>`. Xcode also emits
`App.app-Simulated.xcent` under the app target's build intermediates; verify
that it includes `application-identifier` (the simulator can use
`FAKETEAMID.com.cognia.mobile`). These simulated entitlements are embedded
separately from the ad-hoc signature. Then install without uninstalling the
previous app, preserving local data. An unsigned device
archive is useful for compile verification only; it cannot validate Keychain
or end-to-end pairing.

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
pnpm mobile:sync:ios
pnpm mobile:open:ios
# In Xcode, select an iOS Simulator and run the App scheme.

# Manual:
#   - QR scan pair flow exits cleanly when camera permission denied
#   - cognia://oauth/claude?code=x is captured by appUrlOpen listener
#   - Face ID prompt appears for app unlock if Settings → Me → Biometric
#     unlock toggled on
```

## Notes

- The **Android** equivalent of these manifest changes already lives in
  `mobile/android/app/src/main/AndroidManifest.xml` (Wave 1.3 commit).
- `mobile/ios/App/Pods`, the copied `public/` bundle, build products, and local
  Xcode state are generated and intentionally gitignored.
- The Push Notifications capability is applied by `pnpm mobile:sync:ios`:
  `configure-ios-project.mjs` writes `App/App.entitlements` with
  `aps-environment` and points both build configurations at it via
  `CODE_SIGN_ENTITLEMENTS`. The entitlement always says `development` — Xcode
  derives the shipped value from the provisioning profile at signing time, so a
  distribution profile promotes it to `production` on its own. What still needs
  a human is the Apple side: the App ID must have the Push Notifications
  capability enabled (step 2 above) and a matching profile selected under
  Signing & Capabilities.
