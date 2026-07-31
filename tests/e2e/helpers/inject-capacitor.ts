/**
 * Playwright helper: install `window.Capacitor` + a comprehensive set of
 * plugin stubs before the page boots. The dev server can't tell whether
 * it's running inside a Capacitor WebView, so platform-detection code
 * (`hooks/use-platform.ts`, `lib/capacitor/_shared.ts`,
 * `lib/tauri/companion-storage.ts`) takes the "web" branch by default.
 * This helper flips it to "mobile" via `addInitScript` so mobile-only UI
 * (offline banner, connection-state badge, biometric sign-out guard,
 * pull-to-refresh, composer plus menu, share-target receiver) renders for
 * E2E specs running in a mobile-shaped viewport.
 *
 * Use BEFORE `page.goto(...)`:
 *
 *   await injectCapacitor(page, { platform: "android" })
 *   await page.goto("/pair")
 *
 * Runtime mocks on `window.__cogniaCapMock` let specs drive plugin
 * behavior at runtime — flip network status, push barcode scan results,
 * push deeplinks, deliver scheduled notifications, etc.
 */

import type { Page } from "@playwright/test"

export type CapacitorPlatform = "android" | "ios"

export interface CameraPhoto {
  base64String?: string
  dataUrl?: string
  webPath?: string
  format: string
  saved: boolean
}

export interface VoiceRecording {
  recordDataBase64: string
  msDuration: number
  mimeType: string
}

export interface SharePayload {
  title?: string
  text?: string
  url?: string
  files?: string[]
}

export interface GeolocationPosition {
  coords: {
    latitude: number
    longitude: number
    accuracy: number
    altitude: number | null
    altitudeAccuracy: number | null
    heading: number | null
    speed: number | null
  }
  timestamp: number
}

export interface LocalNotification {
  id: number
  title: string
  body: string
  schedule?: { at: number }
}

export interface InjectCapacitorOptions {
  platform?: CapacitorPlatform
  network?: { connected: boolean; connectionType: string }
  barcodeResult?: { rawValue: string } | null
  biometricAvailable?: boolean
  /** When false, isAvailable stays true but verifyIdentity rejects — the
   * "enrolled but verification failed" case a guard must BLOCK on
   * (unavailability alone falls through on gates with
   * fallthroughWhenUnavailable). Defaults to true. */
  biometricVerifyOk?: boolean
  cameraResult?: CameraPhoto | null
  voiceRecording?: VoiceRecording | null
  geolocation?: GeolocationPosition | null
  pushToken?: string | null
  initialNotifications?: LocalNotification[]
  shareEnabled?: boolean
  /** Initial mDNS discovery results for the LAN-discovery flow. */
  mdnsResults?: Array<{ host: string; port: number; fingerprint?: string }>
  /** Initial native Keychain/Keystore entries, re-created for every document. */
  secureStorage?: Record<string, string>
}

export async function injectCapacitor(
  page: Page,
  options: InjectCapacitorOptions = {}
): Promise<void> {
  const args = {
    platform: options.platform ?? "android",
    network: options.network ?? { connected: true, connectionType: "wifi" },
    barcodeResult: options.barcodeResult ?? null,
    biometricAvailable: options.biometricAvailable ?? true,
    biometricVerifyOk: options.biometricVerifyOk ?? true,
    cameraResult: options.cameraResult ?? null,
    voiceRecording: options.voiceRecording ?? null,
    geolocation: options.geolocation ?? null,
    pushToken: options.pushToken ?? null,
    initialNotifications: options.initialNotifications ?? [],
    shareEnabled: options.shareEnabled ?? true,
    mdnsResults: options.mdnsResults ?? [],
    secureStorage: options.secureStorage ?? {},
  }

  await page.addInitScript((init) => {
    type Listener = (...args: unknown[]) => void

    interface MockState {
      platform: string
      network: { connected: boolean; connectionType: string }
      barcodeResult: { rawValue: string } | null
      biometricAvailable: boolean
      biometricVerifyOk: boolean
      cameraResult: CameraPhoto | null
      voiceRecording: VoiceRecording | null
      geolocation: GeolocationPosition | null
      pushToken: string | null
      notifications: LocalNotification[]
      shareEnabled: boolean
      mdnsResults: Array<{ host: string; port: number; fingerprint?: string }>
      networkListeners: Listener[]
      appUrlOpenListeners: Listener[]
      appStateListeners: Listener[]
      backButtonListeners: Listener[]
      keyboardWillShowListeners: Listener[]
      keyboardWillHideListeners: Listener[]
      pushRegistrationListeners: Listener[]
      pushNotificationListeners: Listener[]
      localNotificationActionListeners: Listener[]
      orientationListeners: Listener[]
      mdnsListeners: Listener[]
      secureStore: Record<string, string>
      fsRoot: Record<string, string>
      lockedOrientation: string | null
      lastShare: SharePayload | null
      lastBrowserOpen: { url: string; presentationStyle?: string } | null
    }

    type CameraPhoto = {
      base64String?: string
      dataUrl?: string
      webPath?: string
      format: string
      saved: boolean
    }
    type VoiceRecording = { recordDataBase64: string; msDuration: number; mimeType: string }
    type SharePayload = { title?: string; text?: string; url?: string; files?: string[] }
    type GeolocationPosition = {
      coords: {
        latitude: number
        longitude: number
        accuracy: number
        altitude: number | null
        altitudeAccuracy: number | null
        heading: number | null
        speed: number | null
      }
      timestamp: number
    }
    type LocalNotification = { id: number; title: string; body: string; schedule?: { at: number } }

    const state: MockState = {
      platform: init.platform,
      network: { ...init.network },
      barcodeResult: init.barcodeResult ? { ...init.barcodeResult } : null,
      biometricAvailable: init.biometricAvailable,
      biometricVerifyOk: init.biometricVerifyOk,
      cameraResult: init.cameraResult ? { ...(init.cameraResult as CameraPhoto) } : null,
      voiceRecording: init.voiceRecording ? { ...(init.voiceRecording as VoiceRecording) } : null,
      geolocation: init.geolocation ? { ...(init.geolocation as GeolocationPosition) } : null,
      pushToken: init.pushToken,
      notifications: [...(init.initialNotifications as LocalNotification[])],
      shareEnabled: init.shareEnabled,
      mdnsResults: [...init.mdnsResults],
      networkListeners: [],
      appUrlOpenListeners: [],
      appStateListeners: [],
      backButtonListeners: [],
      keyboardWillShowListeners: [],
      keyboardWillHideListeners: [],
      pushRegistrationListeners: [],
      pushNotificationListeners: [],
      localNotificationActionListeners: [],
      orientationListeners: [],
      mdnsListeners: [],
      secureStore: { ...init.secureStorage },
      fsRoot: {},
      lockedOrientation: null,
      lastShare: null,
      lastBrowserOpen: null,
    }

    const addListener = (bag: Listener[], cb: Listener) => {
      bag.push(cb)
      return Promise.resolve({
        remove: () => {
          const i = bag.indexOf(cb)
          if (i !== -1) bag.splice(i, 1)
        },
      })
    }

    const Plugins = {
      Network: {
        getStatus: async () => ({ ...state.network }),
        addListener: async (event: string, cb: Listener) => {
          if (event !== "networkStatusChange") return { remove: () => {} }
          return addListener(state.networkListeners, cb)
        },
        removeAllListeners: async () => {
          state.networkListeners.length = 0
        },
      },
      App: {
        getInfo: async () => ({
          name: "Cognia",
          id: "ai.cognia.app",
          version: "0.1.0",
          build: "1",
        }),
        getState: async () => ({ isActive: true }),
        exitApp: async () => undefined,
        minimizeApp: async () => undefined,
        addListener: async (event: string, cb: Listener) => {
          if (event === "appUrlOpen") return addListener(state.appUrlOpenListeners, cb)
          if (event === "appStateChange") return addListener(state.appStateListeners, cb)
          if (event === "backButton") return addListener(state.backButtonListeners, cb)
          return { remove: () => {} }
        },
        removeAllListeners: async () => {
          state.appUrlOpenListeners.length = 0
          state.appStateListeners.length = 0
          state.backButtonListeners.length = 0
        },
      },
      BarcodeScanner: {
        scan: async () => ({
          barcodes: state.barcodeResult ? [{ ...state.barcodeResult }] : [],
        }),
        requestPermissions: async () => ({ camera: "granted" }),
        checkPermissions: async () => ({ camera: "granted" }),
        isSupported: async () => ({ supported: true }),
      },
      SecureStoragePlugin: {
        set: async ({ key, value }: { key: string; value: string }) => {
          state.secureStore[key] = value
          return { value: true }
        },
        get: async ({ key }: { key: string }) => {
          const v = state.secureStore[key]
          if (typeof v !== "string") {
            throw new Error(`SecureStorage: key '${key}' not found`)
          }
          return { value: v }
        },
        remove: async ({ key }: { key: string }) => {
          delete state.secureStore[key]
          return { value: true }
        },
        keys: async () => ({ value: Object.keys(state.secureStore) }),
        clear: async () => {
          for (const k of Object.keys(state.secureStore)) delete state.secureStore[k]
          return { value: true }
        },
      },
      NativeBiometric: {
        isAvailable: async () => ({
          isAvailable: state.biometricAvailable,
          biometryType: 1,
        }),
        verifyIdentity: async () => {
          if (!state.biometricAvailable || !state.biometricVerifyOk) {
            throw new Error("Biometric verification failed")
          }
          return undefined
        },
      },
      Toast: {
        show: async () => undefined,
      },
      StatusBar: {
        setStyle: async () => undefined,
        setBackgroundColor: async () => undefined,
        show: async () => undefined,
        hide: async () => undefined,
        setOverlaysWebView: async () => undefined,
      },
      SplashScreen: {
        hide: async () => undefined,
        show: async () => undefined,
      },
      Keyboard: {
        getResizeMode: async () => ({ mode: "native" }),
        addListener: async (event: string, cb: Listener) => {
          if (event === "keyboardWillShow") return addListener(state.keyboardWillShowListeners, cb)
          if (event === "keyboardWillHide") return addListener(state.keyboardWillHideListeners, cb)
          return { remove: () => {} }
        },
        hide: async () => undefined,
        show: async () => undefined,
      },
      Haptics: {
        impact: async () => undefined,
        notification: async () => undefined,
        vibrate: async () => undefined,
        selectionStart: async () => undefined,
        selectionChanged: async () => undefined,
        selectionEnd: async () => undefined,
      },
      Preferences: {
        get: async ({ key }: { key: string }) => ({
          value:
            typeof window.localStorage.getItem(`cap.prefs.${key}`) === "string"
              ? window.localStorage.getItem(`cap.prefs.${key}`)
              : null,
        }),
        set: async ({ key, value }: { key: string; value: string }) => {
          window.localStorage.setItem(`cap.prefs.${key}`, value)
        },
        remove: async ({ key }: { key: string }) => {
          window.localStorage.removeItem(`cap.prefs.${key}`)
        },
        keys: async () => ({
          keys: Object.keys(window.localStorage).filter((k) => k.startsWith("cap.prefs.")),
        }),
        clear: async () => {
          for (const k of Object.keys(window.localStorage)) {
            if (k.startsWith("cap.prefs.")) window.localStorage.removeItem(k)
          }
        },
      },
      CapacitorHttp: {
        request: async (opts: {
          url: string
          method?: string
          data?: unknown
          headers?: Record<string, string>
        }) => {
          const body =
            opts.data === undefined || opts.data === null
              ? undefined
              : typeof opts.data === "string"
                ? opts.data
                : JSON.stringify(opts.data)
          const res = await fetch(opts.url, {
            method: opts.method ?? "GET",
            headers: opts.headers,
            body,
          })
          const text = await res.text()
          let data: unknown = text
          try {
            data = JSON.parse(text)
          } catch {
            // not json — leave as plain text
          }
          return {
            status: res.status,
            data,
            url: res.url,
            headers: Object.fromEntries(res.headers.entries()),
          }
        },
      },
      Camera: {
        getPhoto: async () => {
          if (!state.cameraResult) {
            throw new Error("Camera: no result configured. Call setCameraResult().")
          }
          return { ...state.cameraResult }
        },
        pickImages: async () => ({
          photos: state.cameraResult ? [{ ...state.cameraResult }] : [],
        }),
        requestPermissions: async () => ({ camera: "granted", photos: "granted" }),
        checkPermissions: async () => ({ camera: "granted", photos: "granted" }),
      },
      Filesystem: {
        readFile: async ({ path }: { path: string }) => {
          if (!(path in state.fsRoot)) throw new Error(`Filesystem: ${path} not found`)
          return { data: state.fsRoot[path] }
        },
        writeFile: async ({ path, data }: { path: string; data: string }) => {
          state.fsRoot[path] = data
          return { uri: `file://mock${path}` }
        },
        deleteFile: async ({ path }: { path: string }) => {
          delete state.fsRoot[path]
        },
        mkdir: async () => undefined,
        rmdir: async () => undefined,
        readdir: async () => ({
          files: Object.keys(state.fsRoot).map((name) => ({ name, type: "file", size: 0 })),
        }),
        stat: async ({ path }: { path: string }) => ({
          type: path in state.fsRoot ? "file" : "directory",
          size: 0,
          mtime: 0,
          uri: `file://mock${path}`,
        }),
        getUri: async ({ path }: { path: string }) => ({ uri: `file://mock${path}` }),
      },
      Geolocation: {
        getCurrentPosition: async () => {
          if (!state.geolocation) {
            throw new Error("Geolocation: no position configured. Call setGeolocation().")
          }
          return { ...state.geolocation }
        },
        watchPosition: async () => "watch_1",
        clearWatch: async () => undefined,
        requestPermissions: async () => ({ location: "granted", coarseLocation: "granted" }),
        checkPermissions: async () => ({ location: "granted", coarseLocation: "granted" }),
      },
      LocalNotifications: {
        schedule: async ({ notifications }: { notifications: LocalNotification[] }) => {
          state.notifications.push(...notifications)
          return { notifications }
        },
        getPending: async () => ({ notifications: [...state.notifications] }),
        cancel: async ({ notifications }: { notifications: Array<{ id: number }> }) => {
          for (const { id } of notifications) {
            const i = state.notifications.findIndex((n) => n.id === id)
            if (i !== -1) state.notifications.splice(i, 1)
          }
        },
        getDeliveredNotifications: async () => ({ notifications: [] }),
        removeAllDeliveredNotifications: async () => undefined,
        requestPermissions: async () => ({ display: "granted" }),
        checkPermissions: async () => ({ display: "granted" }),
        addListener: async (event: string, cb: Listener) => {
          if (event === "localNotificationActionPerformed") {
            return addListener(state.localNotificationActionListeners, cb)
          }
          return { remove: () => {} }
        },
      },
      PushNotifications: {
        register: async () => {
          if (state.pushToken) {
            for (const cb of state.pushRegistrationListeners.slice()) {
              try {
                cb({ value: state.pushToken })
              } catch {
                // ignore listener errors
              }
            }
          }
        },
        getDeliveredNotifications: async () => ({ notifications: [] }),
        removeAllDeliveredNotifications: async () => undefined,
        requestPermissions: async () => ({ receive: "granted" }),
        checkPermissions: async () => ({ receive: "granted" }),
        addListener: async (event: string, cb: Listener) => {
          if (event === "registration") return addListener(state.pushRegistrationListeners, cb)
          if (event === "pushNotificationReceived")
            return addListener(state.pushNotificationListeners, cb)
          if (event === "pushNotificationActionPerformed")
            return addListener(state.pushNotificationListeners, cb)
          return { remove: () => {} }
        },
      },
      Share: {
        share: async (payload: SharePayload) => {
          if (!state.shareEnabled) {
            throw new Error("Share: not available")
          }
          state.lastShare = { ...payload }
          return { activityType: "mock" }
        },
        canShare: async () => ({ value: state.shareEnabled }),
      },
      Browser: {
        open: async (opts: { url: string; presentationStyle?: string }) => {
          state.lastBrowserOpen = { ...opts }
        },
        close: async () => {
          state.lastBrowserOpen = null
        },
        addListener: async () => ({ remove: () => {} }),
      },
      Dialog: {
        alert: async () => undefined,
        confirm: async () => ({ value: true }),
        prompt: async () => ({ value: "", cancelled: false }),
      },
      ScreenOrientation: {
        orientation: async () => ({ type: state.lockedOrientation ?? "portrait-primary" }),
        lock: async ({ orientation }: { orientation: string }) => {
          state.lockedOrientation = orientation
          for (const cb of state.orientationListeners.slice()) {
            try {
              cb({ type: orientation })
            } catch {
              // ignore listener errors
            }
          }
        },
        unlock: async () => {
          state.lockedOrientation = null
        },
        addListener: async (event: string, cb: Listener) => {
          if (event === "screenOrientationChange")
            return addListener(state.orientationListeners, cb)
          return { remove: () => {} }
        },
      },
      VoiceRecorder: {
        canDeviceVoiceRecord: async () => ({ value: true }),
        requestAudioRecordingPermission: async () => ({ value: true }),
        hasAudioRecordingPermission: async () => ({ value: true }),
        startRecording: async () => ({ value: true }),
        stopRecording: async () => {
          if (!state.voiceRecording) {
            throw new Error("VoiceRecorder: no recording configured. Call setVoiceResult().")
          }
          return { value: { ...state.voiceRecording } }
        },
        pauseRecording: async () => ({ value: true }),
        resumeRecording: async () => ({ value: true }),
        getCurrentStatus: async () => ({ status: "RECORDING" }),
      },
      NavigationBar: {
        setColor: async () => undefined,
        setNavigationBarColor: async () => undefined,
      },
      // capacitor-zeroconf — consumed by lib/connectivity/mdns-discovery.ts
      // (pair page "nearby devices"). Replays `state.mdnsResults` as resolved
      // services to every "discover" listener; setMdnsResults pushes live.
      ZeroConf: {
        watch: async () => undefined,
        unwatch: async () => undefined,
        addListener: async (event: string, cb: Listener) => {
          if (event !== "discover") return { remove: () => {} }
          const sub = addListener(state.mdnsListeners, cb)
          for (const r of state.mdnsResults) {
            cb({
              action: "resolved",
              service: {
                name: "cognia",
                hostname: r.host,
                ipv4Addresses: [r.host],
                port: r.port,
                txtRecord: r.fingerprint ? { fp: r.fingerprint } : {},
              },
            })
          }
          return sub
        },
      },
    }

    const Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => state.platform,
      isPluginAvailable: () => true,
      Plugins,
      registerPlugin: <T>(_name: string, impl: T) => impl,
    }

    ;(window as unknown as { Capacitor: typeof Capacitor }).Capacitor = Capacitor
    ;(window as unknown as { __cogniaCapMock: unknown }).__cogniaCapMock = {
      // ── Existing controls (back-compat) ────────────────────────────────
      setNetwork(next: { connected: boolean; connectionType?: string }) {
        state.network = {
          connected: next.connected,
          connectionType: next.connectionType ?? state.network.connectionType,
        }
        for (const cb of state.networkListeners.slice()) {
          try {
            cb({ ...state.network })
          } catch {
            // ignore listener errors
          }
        }
      },
      getNetworkListenerCount() {
        return state.networkListeners.length
      },
      setBarcodeResult(payload: string | null) {
        state.barcodeResult = payload === null ? null : { rawValue: payload }
      },
      setBiometricAvailable(available: boolean) {
        state.biometricAvailable = available
      },
      setBiometricVerify(ok: boolean) {
        state.biometricVerifyOk = ok
      },
      pushAppUrlOpen(url: string) {
        for (const cb of state.appUrlOpenListeners.slice()) {
          try {
            cb({ url })
          } catch {
            // ignore listener errors
          }
        }
      },
      pushAppStateChange(active: boolean) {
        for (const cb of state.appStateListeners.slice()) {
          try {
            cb({ isActive: active })
          } catch {
            // ignore listener errors
          }
        }
      },
      pushBackButton() {
        for (const cb of state.backButtonListeners.slice()) {
          try {
            cb({ canGoBack: true })
          } catch {
            // ignore listener errors
          }
        }
      },
      secureStorageSnapshot() {
        return { ...state.secureStore }
      },
      clearSecureStorage() {
        for (const k of Object.keys(state.secureStore)) delete state.secureStore[k]
      },
      // ── New controls (Wave 2/3 surfaces) ───────────────────────────────
      setCameraResult(photo: CameraPhoto | null) {
        state.cameraResult = photo ? { ...photo } : null
      },
      setVoiceResult(recording: VoiceRecording | null) {
        state.voiceRecording = recording ? { ...recording } : null
      },
      setGeolocation(position: GeolocationPosition | null) {
        state.geolocation = position ? { ...position } : null
      },
      setPushToken(token: string | null) {
        state.pushToken = token
      },
      pushPushNotification(notification: {
        id: string
        title?: string
        body?: string
        data?: unknown
      }) {
        for (const cb of state.pushNotificationListeners.slice()) {
          try {
            cb({ ...notification })
          } catch {
            // ignore listener errors
          }
        }
      },
      pushLocalNotificationAction(payload: { actionId: string; notification: LocalNotification }) {
        for (const cb of state.localNotificationActionListeners.slice()) {
          try {
            cb({ ...payload })
          } catch {
            // ignore listener errors
          }
        }
      },
      pendingNotifications() {
        return [...state.notifications]
      },
      setShareEnabled(enabled: boolean) {
        state.shareEnabled = enabled
      },
      lastShare(): SharePayload | null {
        return state.lastShare ? { ...state.lastShare } : null
      },
      lastBrowserOpen() {
        return state.lastBrowserOpen ? { ...state.lastBrowserOpen } : null
      },
      pushKeyboardEvent(kind: "show" | "hide", height = 0) {
        const bag =
          kind === "show" ? state.keyboardWillShowListeners : state.keyboardWillHideListeners
        for (const cb of bag.slice()) {
          try {
            cb({ keyboardHeight: height })
          } catch {
            // ignore listener errors
          }
        }
      },
      pushOrientationChange(orientation: string) {
        state.lockedOrientation = orientation
        for (const cb of state.orientationListeners.slice()) {
          try {
            cb({ type: orientation })
          } catch {
            // ignore listener errors
          }
        }
      },
      setMdnsResults(results: Array<{ host: string; port: number; fingerprint?: string }>) {
        state.mdnsResults = [...results]
        for (const r of results) {
          for (const cb of state.mdnsListeners.slice()) {
            try {
              cb({
                action: "resolved",
                service: {
                  name: "cognia",
                  hostname: r.host,
                  ipv4Addresses: [r.host],
                  port: r.port,
                  txtRecord: r.fingerprint ? { fp: r.fingerprint } : {},
                },
              })
            } catch {
              // ignore listener errors
            }
          }
        }
      },
      mdnsResults() {
        return [...state.mdnsResults]
      },
      filesystemSnapshot() {
        return { ...state.fsRoot }
      },
      setFilesystemEntry(path: string, data: string) {
        state.fsRoot[path] = data
      },
    }
  }, args)
}
