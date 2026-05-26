import type { CapacitorConfig } from "@capacitor/cli"

/**
 * Capacitor 8 mobile shell configuration.
 *
 * - `webDir: "../out"` shares the Next.js static export with the Tauri build.
 * - URL scheme `cognia://` is registered for OAuth deep-link callbacks
 *   (Wave 1.8). Both Android and iOS native targets must mirror it in their
 *   own manifests / Info.plist (handled by `cap sync`).
 * - Per-plugin entries below set defaults that match the in-app product
 *   experience: WeChat-style splash, keyboard resize behavior, status-bar
 *   theming, and quiet local-notification channels.
 */
const config: CapacitorConfig = {
  appId: "com.cognia.mobile",
  appName: "cognia",
  webDir: "../out",
  server: {
    androidScheme: "https",
    // DEV-ONLY live reload.
    //
    // The Next.js dev server is reached at http://localhost:3000 from inside
    // the emulator by way of `adb reverse tcp:3000 tcp:3000` (run once per
    // emulator session). Using the same hostname the desktop tauri dev uses
    // means `next.config.ts`'s assetPrefix (`http://localhost:3000`) resolves
    // correctly for both targets off a single dev server.
    //
    // Comment out (or unset COGNIA_MOBILE_DEV) and re-run `cap sync` before
    // building a release / pushing this file.
    ...(process.env.COGNIA_MOBILE_DEV
      ? {
          url: "http://localhost:3000",
          cleartext: true,
        }
      : {}),
  },
  plugins: {
    SplashScreen: {
      // Always auto-hide as a failsafe. If the boot path ever fails to call
      // hideSplash() (e.g. the native SplashScreen plugin didn't register, the
      // exact bug that froze the app on the launch icon), the splash MUST still
      // dismiss rather than strand the user forever. CompanionBootProvider
      // calls hideSplash() right after React's first paint, which dismisses it
      // well before this ceiling — the timeout only fires if that call never
      // lands. The web <AppSplash> overlay shares the #01061e backdrop, so the
      // native→web handoff shows no flash of unstyled content either way.
      launchShowDuration: process.env.COGNIA_MOBILE_DEV ? 1500 : 3000,
      launchAutoHide: true,
      // Deep-navy to match the splash illustration + @color/splash_background.
      // Only the legacy (pre-Android-12 / fallback) ImageView path reads this;
      // Android 12+ uses the theme's windowSplashScreenBackground.
      backgroundColor: "#01061e",
      androidSplashResourceName: "splash",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: "DEFAULT",
      overlaysWebView: false,
    },
    Keyboard: {
      resize: "body",
      resizeOnFullScreen: true,
    },
    LocalNotifications: {
      smallIcon: "ic_stat_icon",
      iconColor: "#3b82f6",
      sound: "beep.wav",
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
    // CapacitorHttp (M2.9) — enabled so HTTPS calls to the desktop server's
    // self-signed cert can go through a native pinned trust path. Server-trust
    // mode is configured per call via the `serverTrustMode` request option in
    // `lib/tauri/transport-companion.ts`.
    //
    // Pinning policy:
    //   - LAN (cgnp2|<fingerprint>): we call with `serverTrustMode: "pinned"`
    //     and provide the SHA-256 SPKI fingerprint from the QR pair payload.
    //   - Tunnel (Cloudflare-issued cert): standard OS trust chain via
    //     `serverTrustMode: "default"`.
    //
    // Native pinning is wired through the per-build NSC injection
    // (`mobile/scripts/inject-server-fingerprint.mjs`) which rewrites the
    // `<pin-set>` block under `cognia-companion.local` in
    // `mobile/android/app/src/main/res/xml/network_security_config.xml`
    // when `COGNIA_PIN_FINGERPRINT` (or
    // `~/.cognia/companion-fingerprint.txt`) is present at `cap sync` time.
    // Debug builds skip injection — see
    // `mobile/android/app/src/debug/res/xml/network_security_config.xml`.
    CapacitorHttp: {
      enabled: true,
    },
  },
  ios: {
    contentInset: "automatic",
    limitsNavigationsToAppBoundDomains: false,
    scheme: "cognia",
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    // DEV: expose the WebView to `chrome://inspect/#devices` so we can
    // open DevTools against the emulator. Release builds keep this off.
    webContentsDebuggingEnabled: Boolean(process.env.COGNIA_MOBILE_DEV),
  },
}

export default config
