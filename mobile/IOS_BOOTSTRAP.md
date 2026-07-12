# iOS Platform Bootstrap (Wave 1.3)

## Status

**Pending HITL on macOS.** Capacitor's `cap add ios` requires Xcode 15+,
CocoaPods, and the iOS toolchain — all macOS-only. The Windows host that
generated the rest of Wave 1 cannot run this command.

## Steps (run on macOS)

```bash
# From repo root, after pulling main
pnpm install

# Add iOS platform — generates mobile/ios/App/...
pnpm --filter mobile exec cap add ios

# Pull plugin native code into the iOS Xcode project
pnpm --filter mobile exec cap sync ios

# Open in Xcode for signing + first build
pnpm --filter mobile exec cap open ios
```

## Required Info.plist additions

**Automated:** `node scripts/patch-ios-info-plist.mjs` (chained by
`pnpm -F mobile add:ios`, rerunnable via `pnpm -F mobile patch:ios`) injects
`NSBonjourServices` (`_cognia._tcp`) plus every `NS*UsageDescription` key the
shipped plugins need — camera, photo library (read + add), microphone,
Face ID, location-when-in-use, local network — with bilingual strings in
`en.lproj` / `zh-Hans.lproj` `InfoPlist.strings`. iOS kills the app at
permission-request time when one of these keys is missing, so run the
patcher after every `cap add ios`.

**Manual (paste into the top-level `<dict>`):** the remaining keys below are
not yet automated:

```xml
<!-- Cleartext loopback for LAN dev (release uses TLS — Wave 1.4) -->
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key>
  <true/>
</dict>

<!-- URL scheme for OAuth deeplink, pair payload, open-session -->
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>com.cognia.mobile</string>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>cognia</string>
    </array>
  </dict>
</array>

<!-- Background modes — push notifications + outbound queue flush on resume -->
<key>UIBackgroundModes</key>
<array>
  <string>remote-notification</string>
  <string>fetch</string>
</array>
```

## Required LaunchScreen dark variant

The Android side ships a fixed deep-navy splash via the Android 12+
SplashScreen API: `AppTheme.NoActionBarLaunch` sets
`windowSplashScreenBackground` (`@color/splash_background`, identical in
light + night) and `windowSplashScreenAnimatedIcon` (`@drawable/splash_icon`).
iOS requires a sibling change inside the storyboard so the launch surface
honors `userInterfaceStyle = .dark` instead of flashing white.

After `cap add ios` generates `mobile/ios/App/App/Base.lproj/LaunchScreen.storyboard`:

1. Open the storyboard in Xcode → select the root view.
2. In the **Attributes inspector** → **Background** field, click the
   color swatch → **Other…** → switch to the **+** menu → **Add Color**
   to add a **Trait Variation**:
   - **Any** → `#FFFFFF` (current behavior)
   - **Dark** → `#0A0A0A` (matches cognia's `--background` dark token)
3. Repeat for any subviews that have an explicit background color.
4. In `Info.plist`, ensure `UIUserInterfaceStyle` is **not** set to
   `Light` or `Dark` — leave it absent so iOS picks the system value.
5. If launch images are configured in `Assets.xcassets/Splash.imageset/`,
   add a separate `Dark` slot (Inspector → Appearances → **Any, Dark**)
   pointing at a darkmode-tinted PNG.

Verification (Simulator):

```bash
pnpm --filter mobile exec cap run ios
# In the Simulator: Settings → Developer → Dark Appearance → ON
# Then re-launch cognia — splash should appear with the dark background.
```

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

## Verification (after macOS bootstrap)

```bash
pnpm build                       # Fresh static export at out/
pnpm --filter mobile exec cap sync ios
pnpm --filter mobile exec cap run ios   # iOS Simulator boot
# Manual:
#   - QR scan pair flow exits cleanly when camera permission denied
#   - cognia://oauth/claude?code=x is captured by appUrlOpen listener
#   - Face ID prompt appears for app unlock if Settings → Me → Biometric
#     unlock toggled on
```

## Notes

- The **Android** equivalent of these manifest changes already lives in
  `mobile/android/app/src/main/AndroidManifest.xml` (Wave 1.3 commit).
- Once iOS is generated, future `cap sync` runs are non-destructive — the
  Info.plist additions stay in place across plugin upgrades.
