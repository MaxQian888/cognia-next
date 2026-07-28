# iOS Platform Bootstrap

## Status

The Capacitor 8 iOS project is committed under `mobile/ios/`. It targets iOS
16.0 and uses CocoaPods. A full native build still requires macOS with Xcode
26+ and Apple signing credentials.

## Daily workflow

```bash
# From the repository root
pnpm install
pnpm mobile:sync:ios
pnpm mobile:open:ios
```

`mobile:sync:ios` runs the deterministic native configurator before Capacitor
sync. The configurator maintains:

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
- The Push Notifications capability and `aps-environment` entitlement must
  still be enabled in Xcode with the selected Apple Developer team.
