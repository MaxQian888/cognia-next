/**
 * @jest-environment jsdom
 */

import { render, waitFor } from "@testing-library/react"

import { CompanionBootProvider } from "./companion-boot-provider"

// ── Navigation mocks ─────────────────────────────────────────────────────────
const replaceMock = jest.fn()
const pushMock = jest.fn()
const pathnameMock = jest.fn(() => "/")
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock, back: jest.fn() }),
  usePathname: () => pathnameMock(),
}))

// ── Module mocks ────────────────────────────────────────────────────────────
const hydrateMock = jest.fn()
jest.mock("@/lib/tauri/transport-companion", () => ({
  hydrateCompanionConfig: () => hydrateMock(),
}))

jest.mock("@/lib/accounts/active-account-id", () => ({ DEFAULT_LOCAL_ACCOUNT_ID: "local_acct_a" }))
jest.mock("@/lib/companion/mobile-host-adoption", () => ({
  adoptMobileCompanionHosts: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/companion/credential-book", () => ({
  companionCredentialBook: () => ({ getActive: jest.fn().mockResolvedValue(null) }),
}))
jest.mock("@/lib/db/schema", () => ({ activateAccountDatabase: jest.fn() }))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  setActiveRuntimeTargetContext: jest.fn(),
}))
jest.mock("@/lib/runtime/account-runtime-target", () => ({
  registerCompanionRuntimeTarget: jest.fn().mockResolvedValue({ id: "host-a" }),
}))
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  runtimeHostSnapshotFromManifest: () => ({
    compatible: true,
    operations: ["claude_send"],
    grants: ["claude.chat"],
  }),
  setRuntimeSnapshot: jest.fn(),
  updateRuntimeSnapshot: jest.fn(),
}))
jest.mock("@/lib/runtime/runtime-target-lifecycle", () => ({
  registerRuntimeTargetSubscriptionStopper: () => jest.fn(),
}))
jest.mock("@/lib/connectivity/lan-classify", () => ({ classifyWsHost: () => "ws-lan" }))
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: {
    call: jest.fn().mockResolvedValue({ schemaVersion: 2 }),
    subscribe: jest.fn().mockReturnValue(() => {}),
  },
}))

const getSettingsMock = jest.fn(async () => ({}) as Record<string, unknown>)
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => getSettingsMock(),
}))

const runSyncDownMock = jest.fn()
const installForegroundSyncMock = jest.fn()
const installEventDrivenSyncMock = jest.fn()
const installNetworkSyncMock = jest.fn(async () => () => {})
const installResumeSyncMock = jest.fn(async () => () => {})
jest.mock("@/lib/sync/companion-sync", () => ({
  runSyncDown: () => runSyncDownMock(),
  installForegroundSync: () => installForegroundSyncMock(),
  installEventDrivenSync: () => installEventDrivenSyncMock(),
  installNetworkSync: () => installNetworkSyncMock(),
  installResumeSync: () => installResumeSyncMock(),
}))

const registerPushMock = jest.fn()
const reportPushTokenMock = jest.fn()
jest.mock("@/lib/push/push-notifications", () => ({
  registerPushNotifications: (options?: unknown) => registerPushMock(options),
  reportPushTokenToDesktop: (token: string, platform: string) =>
    reportPushTokenMock(token, platform),
}))

const uninstallPushBridgeMock = jest.fn(async () => {})
const installPushBridgeMock = jest.fn()
jest.mock("@/lib/notifications/inbound-push", () => ({
  installPushNotificationBridge: (observer: (delivery: unknown) => void) =>
    installPushBridgeMock(observer),
}))

const toastFn = jest.fn()
jest.mock("sonner", () => ({
  toast: Object.assign((...args: unknown[]) => toastFn(...args), {
    error: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
  }),
}))

const logInfo = jest.fn()
const logWarn = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: {
    shell: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: (...args: unknown[]) => logWarn(...args),
      error: jest.fn(),
    },
  },
}))

// Wave 1.4–1.7 native wrappers — stubbed so the dynamic import never tries
// to resolve the real Capacitor proxies (which throw on .then() in jsdom).
const deeplinkUnsubMock = jest.fn<void, []>()
const deeplinkSubscribeMock = jest.fn(async (_handler: unknown) => deeplinkUnsubMock)
const getLaunchRouteMock = jest.fn(async (): Promise<unknown> => null)
jest.mock("@/lib/capacitor/deeplink", () => ({
  subscribe: (handler: unknown) => deeplinkSubscribeMock(handler),
  getLaunchRoute: () => getLaunchRouteMock(),
}))
const registerNativePluginsMock = jest.fn(async () => ({
  kind: "registered" as const,
  registered: [] as string[],
  available: [] as string[],
}))
jest.mock("@/lib/capacitor/register-plugins", () => ({
  registerNativePlugins: () => registerNativePluginsMock(),
}))
jest.mock("@/lib/capacitor/splash-screen", () => ({
  hide: jest.fn(async () => ({ kind: "ok" })),
}))
const syncStatusBarMock = jest.fn(async () => ({ kind: "ok" }))
jest.mock("@/lib/capacitor/status-bar", () => ({
  syncWithTheme: (...args: unknown[]) => syncStatusBarMock(...(args as [])),
}))
const syncNavBarMock = jest.fn(async () => ({ kind: "ok" }))
jest.mock("@/lib/capacitor/navigation-bar", () => ({
  syncWithTheme: (...args: unknown[]) => syncNavBarMock(...(args as [])),
}))
const localNotifActionUnsubMock = jest.fn()
const onLocalNotifActionMock = jest.fn(async (_handler: unknown) => localNotifActionUnsubMock)
const notificationPermissionUnsubMock = jest.fn()
let notificationPermissionHandler: (() => void) | null = null
const subscribeNotificationPermissionMock = jest.fn((handler: () => void) => {
  notificationPermissionHandler = handler
  return notificationPermissionUnsubMock
})
jest.mock("@/lib/capacitor/local-notifications", () => ({
  DEFAULT_CHANNEL_ID: "cognia-default",
  ensureChannel: jest.fn(async () => ({ kind: "ok" })),
  onAction: (handler: unknown) => onLocalNotifActionMock(handler),
  subscribeNotificationPermissionGranted: (handler: () => void) =>
    subscribeNotificationPermissionMock(handler),
}))
const backButtonUnsubMock = jest.fn()
const subscribeBackButtonMock = jest.fn(
  async (_handler: (e: { canGoBack: boolean }) => void) => backButtonUnsubMock
)
const minimizeAppMock = jest.fn(async () => ({ kind: "ok" as const, value: undefined }))
jest.mock("@/lib/capacitor/app", () => ({
  subscribeBackButton: (handler: (e: { canGoBack: boolean }) => void) =>
    subscribeBackButtonMock(handler),
  minimizeApp: () => minimizeAppMock(),
}))
jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", theme: "light", setTheme: jest.fn() }),
}))

beforeEach(() => {
  replaceMock.mockReset()
  pushMock.mockReset()
  pathnameMock.mockReset().mockReturnValue("/")
  hydrateMock.mockReset()
  getSettingsMock.mockReset().mockResolvedValue({})
  runSyncDownMock.mockReset().mockResolvedValue([])
  installForegroundSyncMock.mockReset().mockReturnValue(() => {})
  installEventDrivenSyncMock.mockReset().mockReturnValue(() => {})
  registerPushMock.mockReset().mockResolvedValue({ kind: "permission_denied" })
  reportPushTokenMock.mockReset().mockResolvedValue({ ok: true })
  uninstallPushBridgeMock.mockClear()
  installPushBridgeMock.mockReset().mockResolvedValue(uninstallPushBridgeMock)
  toastFn.mockReset()
  logInfo.mockReset()
  logWarn.mockReset()
  deeplinkUnsubMock.mockReset()
  deeplinkSubscribeMock.mockClear()
  getLaunchRouteMock.mockReset().mockResolvedValue(null)
  subscribeBackButtonMock.mockClear()
  backButtonUnsubMock.mockClear()
  onLocalNotifActionMock.mockClear()
  localNotifActionUnsubMock.mockClear()
  notificationPermissionHandler = null
  subscribeNotificationPermissionMock.mockClear()
  notificationPermissionUnsubMock.mockClear()
  minimizeAppMock.mockClear()
  registerNativePluginsMock.mockClear()
  syncStatusBarMock.mockClear()
  syncNavBarMock.mockClear()
  delete (window as { Capacitor?: unknown }).Capacitor
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

function setMobile() {
  ;(window as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
    isNativePlatform: () => true,
  }
}

const pairedConfig = {
  baseUrl: "http://test:7890",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
  deviceKeyThumbprint: "thumbprint",
  deviceId: "abc",
  serverVersion: "1.0",
}

describe("<CompanionBootProvider /> — platform gates", () => {
  it("does nothing on web", async () => {
    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await new Promise((r) => setTimeout(r, 0))
    expect(hydrateMock).not.toHaveBeenCalled()
    expect(replaceMock).not.toHaveBeenCalled()
    expect(runSyncDownMock).not.toHaveBeenCalled()
    expect(registerNativePluginsMock).not.toHaveBeenCalled()
  })

  it("does nothing on Tauri", async () => {
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {}
    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await new Promise((r) => setTimeout(r, 0))
    expect(hydrateMock).not.toHaveBeenCalled()
  })
})

describe("<CompanionBootProvider /> — theme sync vs plugin registration", () => {
  it("defers the first status/nav bar sync until native plugins are registered", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(null)
    getSettingsMock.mockResolvedValueOnce({ mobileRuntimeMode: "standalone" })

    let resolveRegistration: (() => void) | undefined
    registerNativePluginsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRegistration = () => resolve({ kind: "registered", registered: [], available: [] })
        }) as ReturnType<typeof registerNativePluginsMock>
    )

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    // Registration still pending → the theme effect must NOT have fired yet
    // (before the fix its first run raced ahead and no-opped as unsupported).
    await new Promise((r) => setTimeout(r, 0))
    expect(syncStatusBarMock).not.toHaveBeenCalled()
    expect(syncNavBarMock).not.toHaveBeenCalled()

    resolveRegistration?.()
    await waitFor(() => expect(syncStatusBarMock).toHaveBeenCalled())
    expect(syncNavBarMock).toHaveBeenCalled()
  })
})

describe("<CompanionBootProvider /> — Android hardware back", () => {
  it("registers the backButton policy even in standalone mode", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(null)
    getSettingsMock.mockResolvedValueOnce({ mobileRuntimeMode: "standalone" })

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() => expect(subscribeBackButtonMock).toHaveBeenCalledTimes(1))
    const handler = subscribeBackButtonMock.mock.calls[0][0]

    const historyBack = jest.spyOn(window.history, "back").mockImplementation(() => {})
    try {
      handler({ canGoBack: true })
      expect(historyBack).toHaveBeenCalledTimes(1)
      expect(minimizeAppMock).not.toHaveBeenCalled()

      handler({ canGoBack: false })
      expect(minimizeAppMock).toHaveBeenCalledTimes(1)
      expect(historyBack).toHaveBeenCalledTimes(1) // unchanged
    } finally {
      historyBack.mockRestore()
    }
  })
})

describe("<CompanionBootProvider /> — local-notification taps", () => {
  it("routes a tapped notification via its extra.route payload", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(null)
    getSettingsMock.mockResolvedValueOnce({ mobileRuntimeMode: "standalone" })

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() => expect(onLocalNotifActionMock).toHaveBeenCalledTimes(1))
    const handler = onLocalNotifActionMock.mock.calls[0][0] as (a: {
      actionId: string
      notification: { id: number; extra?: Record<string, unknown> }
    }) => void

    handler({ actionId: "tap", notification: { id: 9101, extra: { route: "/me/backup" } } })
    expect(pushMock).toHaveBeenCalledWith("/me/backup")

    // Non-path / missing routes are ignored.
    handler({ actionId: "tap", notification: { id: 9102, extra: { route: "https://evil" } } })
    handler({ actionId: "tap", notification: { id: 9103 } })
    expect(pushMock).toHaveBeenCalledTimes(1)
  })
})

describe("<CompanionBootProvider /> — cold-start deeplink replay", () => {
  const shareRoute = {
    kind: "share_target" as const,
    text: "hello",
    raw: "cognia://share?text=hello",
  }

  it("replays the launch deeplink when the app was cold-started by a URL", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(null)
    getSettingsMock.mockResolvedValueOnce({ mobileRuntimeMode: "standalone" })
    getLaunchRouteMock.mockResolvedValueOnce(shareRoute)

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/share-target?text=hello"))
    expect(pushMock).toHaveBeenCalledTimes(1)
  })

  it("does not double-dispatch when the live listener already handled the same URL", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(null)
    getSettingsMock.mockResolvedValueOnce({ mobileRuntimeMode: "standalone" })

    // Hold the launch-route promise open until the live listener has fired.
    let resolveLaunch: ((route: unknown) => void) | undefined
    getLaunchRouteMock.mockImplementationOnce(
      () => new Promise<unknown>((resolve) => (resolveLaunch = resolve))
    )

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() => expect(deeplinkSubscribeMock).toHaveBeenCalled())
    const handler = deeplinkSubscribeMock.mock.calls[0]?.[0] as (route: unknown) => void
    handler(shareRoute)
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/share-target?text=hello"))

    resolveLaunch?.(shareRoute)
    await new Promise((r) => setTimeout(r, 0))
    expect(pushMock).toHaveBeenCalledTimes(1)
  })
})

describe("<CompanionBootProvider /> — unpaired", () => {
  it("redirects to /welcome when unpaired and no mode chosen", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(null)
    getSettingsMock.mockResolvedValueOnce({}) // no mobileRuntimeMode yet

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/welcome"))
    // Native plugin proxies are registered on every mobile boot, even unpaired.
    expect(registerNativePluginsMock).toHaveBeenCalled()
    // Sync + push should NOT run when there's no pairing.
    expect(runSyncDownMock).not.toHaveBeenCalled()
    expect(registerPushMock).not.toHaveBeenCalled()
  })

  it("redirects to /pair when the user chose pairing but isn't paired yet", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(null)
    getSettingsMock.mockResolvedValueOnce({ mobileRuntimeMode: "paired" })

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/pair"))
  })

  it("registers and reports push as soon as an unpaired session finishes pairing", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(null).mockResolvedValueOnce(pairedConfig)
    getSettingsMock.mockResolvedValue({ mobileRuntimeMode: "paired" })
    registerPushMock.mockResolvedValueOnce({
      kind: "registered",
      token: "tok-after-pair",
      platform: "android",
    })

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() => expect(notificationPermissionHandler).not.toBeNull())
    await waitFor(() => expect(hydrateMock).toHaveBeenCalledTimes(1))
    notificationPermissionHandler?.()

    await waitFor(() =>
      expect(reportPushTokenMock).toHaveBeenCalledWith("tok-after-pair", "android")
    )
    expect(registerPushMock).toHaveBeenCalledWith({ requestPermission: false })
  })

  it("skips companion sync/push entirely in standalone (BYOK) mode", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(null)
    getSettingsMock.mockResolvedValueOnce({ mobileRuntimeMode: "standalone" })

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() => expect(getSettingsMock).toHaveBeenCalled())
    expect(replaceMock).not.toHaveBeenCalled()
    expect(runSyncDownMock).not.toHaveBeenCalled()
    expect(registerPushMock).not.toHaveBeenCalled()
  })

  it("does not redirect when already on an onboarding route (/welcome)", async () => {
    setMobile()
    pathnameMock.mockReturnValue("/welcome")
    hydrateMock.mockResolvedValueOnce(null)

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() => expect(hydrateMock).toHaveBeenCalled())
    expect(replaceMock).not.toHaveBeenCalled()
  })
})

describe("<CompanionBootProvider /> — paired", () => {
  it("triggers sync + installs listeners + registers push when paired", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(pairedConfig)
    registerPushMock.mockResolvedValueOnce({
      kind: "registered",
      token: "tok-123",
      platform: "ios",
    })

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() => expect(runSyncDownMock).toHaveBeenCalled())
    expect(installForegroundSyncMock).toHaveBeenCalled()
    expect(installEventDrivenSyncMock).toHaveBeenCalled()
    expect(registerPushMock).toHaveBeenCalledWith({ requestPermission: false })
    await waitFor(() => expect(reportPushTokenMock).toHaveBeenCalledWith("tok-123", "ios"))
    expect(installPushBridgeMock).toHaveBeenCalledTimes(1)
    expect(registerNativePluginsMock.mock.invocationCallOrder[0]).toBeLessThan(
      installPushBridgeMock.mock.invocationCallOrder[0]
    )
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("does not call reportPushToken when registration is denied", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(pairedConfig)
    registerPushMock.mockResolvedValueOnce({ kind: "permission_denied" })

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() => expect(registerPushMock).toHaveBeenCalled())
    expect(reportPushTokenMock).not.toHaveBeenCalled()
    // The inbound bridge still installs even when token registration is denied.
    await waitFor(() => expect(installPushBridgeMock).toHaveBeenCalledTimes(1))
  })

  it("logs a warning when initial sync-down throws", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(pairedConfig)
    runSyncDownMock.mockRejectedValueOnce(new Error("network unreachable"))

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() => expect(logWarn).toHaveBeenCalled())
    // Listeners still install — the failure was non-fatal.
    expect(installForegroundSyncMock).toHaveBeenCalled()
  })

  it("logs a warning when reportPushToken fails (server doesn't ship the rpc)", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(pairedConfig)
    registerPushMock.mockResolvedValueOnce({
      kind: "registered",
      token: "tok",
      platform: "android",
    })
    reportPushTokenMock.mockResolvedValueOnce({ ok: false, reason: "unknown_command" })

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() =>
      expect(logWarn).toHaveBeenCalledWith(
        "companion: failed to report push token",
        expect.objectContaining({ reason: "unknown_command" })
      )
    )
  })

  it("tears down the unified push bridge on unmount", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(pairedConfig)
    registerPushMock.mockResolvedValueOnce({ kind: "permission_denied" })

    const { unmount } = render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )
    await waitFor(() => expect(installPushBridgeMock).toHaveBeenCalledTimes(1))

    unmount()
    await waitFor(() => expect(uninstallPushBridgeMock).toHaveBeenCalledTimes(1))
    expect(notificationPermissionUnsubMock).toHaveBeenCalledTimes(1)
  })

  it("does not continue into registration when a late bridge install resolves after unmount", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(pairedConfig)
    let resolveInstall: ((cleanup: () => Promise<void>) => void) | undefined
    installPushBridgeMock.mockReturnValueOnce(
      new Promise<() => Promise<void>>((resolve) => {
        resolveInstall = resolve
      })
    )

    const { unmount } = render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )
    await waitFor(() => expect(installPushBridgeMock).toHaveBeenCalledTimes(1))

    unmount()
    resolveInstall?.(uninstallPushBridgeMock)

    await waitFor(() => expect(uninstallPushBridgeMock).toHaveBeenCalledTimes(1))
    expect(registerPushMock).not.toHaveBeenCalled()
  })

  it("a tap-from-background push deep-links to the session", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(pairedConfig)
    registerPushMock.mockResolvedValueOnce({ kind: "permission_denied" })

    let pushObserver: ((d: unknown) => void) | null = null
    installPushBridgeMock.mockImplementationOnce((observer: (d: unknown) => void) => {
      pushObserver = observer
      return Promise.resolve(uninstallPushBridgeMock)
    })

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )
    await waitFor(() => expect(pushObserver).not.toBeNull())

    pushObserver!({
      data: { sessionId: "s-123" },
      foreground: false,
    })

    expect(pushMock).toHaveBeenCalledWith("/inbox/c?key=s-123")
  })

  it("keeps boot listeners installed across in-app navigations", async () => {
    // Regression: `pathname` in the boot effect's dep array made the FIRST
    // navigation run the cleanup (tearing down backButton / deeplink / push /
    // sync) while the ranRef guard blocked re-setup — native lifecycle dead
    // for the rest of the session.
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)

    const { rerender } = render(
      <CompanionBootProvider>
        <div>a</div>
      </CompanionBootProvider>
    )
    await waitFor(() => expect(subscribeBackButtonMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(installPushBridgeMock).toHaveBeenCalledTimes(1))

    pathnameMock.mockReturnValue("/me")
    rerender(
      <CompanionBootProvider>
        <div>b</div>
      </CompanionBootProvider>
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(backButtonUnsubMock).not.toHaveBeenCalled()
    expect(deeplinkUnsubMock).not.toHaveBeenCalled()
    expect(uninstallPushBridgeMock).not.toHaveBeenCalled()
    expect(subscribeBackButtonMock).toHaveBeenCalledTimes(1) // no duplicate re-install either
  })

  it("restarts Host bindings without reinstalling one-time native listeners", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )
    await waitFor(() => expect(runSyncDownMock).toHaveBeenCalledTimes(1))

    window.dispatchEvent(new Event("cognia:companion-config-changed"))

    await waitFor(() => expect(runSyncDownMock).toHaveBeenCalledTimes(2))
    expect(registerNativePluginsMock).toHaveBeenCalledTimes(1)
    expect(installPushBridgeMock).toHaveBeenCalledTimes(1)
    expect(subscribeBackButtonMock).toHaveBeenCalledTimes(1)
  })

  it("hydrates only once across re-renders", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)

    const { rerender } = render(
      <CompanionBootProvider>
        <div>a</div>
      </CompanionBootProvider>
    )
    await waitFor(() => expect(hydrateMock).toHaveBeenCalledTimes(1))
    rerender(
      <CompanionBootProvider>
        <div>b</div>
      </CompanionBootProvider>
    )
    expect(hydrateMock).toHaveBeenCalledTimes(1)
  })
})
