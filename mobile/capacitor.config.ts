import type { CapacitorConfig } from "@capacitor/cli"

/**
 * Capacitor 7 mobile shell configuration.
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
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: false,
      backgroundColor: "#ffffff",
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
    // TODO(P0.2 native): the Android Network Security Config and iOS Info.plist
    // need a matching cert hash entry for `serverTrustMode: "pinned"` to take
    // effect at the platform layer. See mobile/docs/p0-tls-trust-setup.md.
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
    webContentsDebuggingEnabled: false,
  },
}

export default config
