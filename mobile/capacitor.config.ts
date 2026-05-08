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
    CapacitorHttp: {
      enabled: false,
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
