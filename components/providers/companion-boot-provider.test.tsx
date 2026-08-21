/**
 * @jest-environment jsdom
 */

import { render, waitFor } from "@testing-library/react"

import { CompanionBootProvider } from "./companion-boot-provider"
import { buildLocalHostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import {
  __resetMobileBootForTesting,
  getMobileBootSnapshot,
  setMobileBootOverlayVisible,
} from "@/lib/boot/mobile-boot-stages"

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
const loadCompanionConfigMock = jest.fn((): { deviceId?: string } | null => null)
jest.mock("@/lib/tauri/transport-companion", () => ({
  hydrateCompanionConfig: () => hydrateMock(),
  loadCompanionConfig: () => loadCompanionConfigMock(),
}))
const remoteStepServerOptionsMock = jest.fn()
jest.mock("@/lib/companion/remote-step-server", () => ({
  installRemoteStepServer: (options: unknown) => {
    remoteStepServerOptionsMock(options)
    return () => {}
  },
}))

jest.mock("@/lib/accounts/active-account-id", () => ({ DEFAULT_LOCAL_ACCOUNT_ID: "local_acct_a" }))
const adoptHostsMock = jest.fn(async (): Promise<void> => undefined)
jest.mock("@/lib/companion/mobile-host-adoption", () => ({
  adoptMobileCompanionHosts: () => adoptHostsMock(),
}))
const getActiveHostMock = jest.fn(async (): Promise<unknown> => null)
jest.mock("@/lib/companion/credential-book", () => ({
  companionCredentialBook: () => ({ getActive: () => getActiveHostMock() }),
}))
const activateAccountDatabaseMock = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  activateAccountDatabase: (...args: unknown[]) => activateAccountDatabaseMock(...args),
}))
const setActiveRuntimeTargetContextMock = jest.fn()
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  setActiveRuntimeTargetContext: (...args: unknown[]) => setActiveRuntimeTargetContextMock(...args),
}))
const registerCompanionRuntimeTargetMock = jest.fn().mockResolvedValue({ id: "host-a" })
jest.mock("@/lib/runtime/account-runtime-target", () => ({
  registerCompanionRuntimeTarget: (...args: unknown[]) =>
    registerCompanionRuntimeTargetMock(...args),
}))
const hostSnapshotMock = jest.fn(() => ({
  compatible: true,
  operations: ["claude_send"],
  grants: ["claude.chat"],
}))
const setRuntimeSnapshotMock = jest.fn()
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  runtimeHostSnapshotFromManifest: () => hostSnapshotMock(),
  setRuntimeSnapshot: (...args: unknown[]) => setRuntimeSnapshotMock(...args),
  updateRuntimeSnapshot: jest.fn(),
}))
jest.mock("@/lib/runtime/runtime-target-lifecycle", () => ({
  registerRuntimeTargetSubscriptionStopper: () => jest.fn(),
}))
const classifyWsHostMock = jest.fn((_url: string): string => "ws-lan")
jest.mock("@/lib/connectivity/lan-classify", () => ({
  classifyWsHost: (url: string) => classifyWsHostMock(url),
}))
const transportCallMock = jest.fn().mockResolvedValue({ schemaVersion: 2 })
// Optional members are attached per test (see the capability-reporter case);
// they must be absent by default so the reporter branch stays off.
const mockTransport: Record<string, unknown> = {
  call: (...args: unknown[]) => transportCallMock(...args),
  subscribe: jest.fn().mockReturnValue(() => {}),
}
jest.mock("@/lib/tauri/transport-instance", () => ({
  // Getter, not a value: the factory is hoisted above `mockTransport`'s
  // initialisation, so a direct reference would hit the TDZ.
  get transport() {
    return mockTransport
  },
}))
const installCapabilityReporterMock = jest.fn((..._args: unknown[]) => jest.fn())
jest.mock("@/lib/companion/capability-reporter", () => ({
  installCapabilityReporter: (...args: unknown[]) => installCapabilityReporterMock(...args),
}))

const hostStateStopMock = jest.fn()
const hostStateResyncMock = jest.fn().mockResolvedValue(undefined)
const installHostStateSyncMock = jest.fn().mockResolvedValue({
  status: { migrationStage: "host-authoritative" },
  stop: hostStateStopMock,
  resync: hostStateResyncMock,
})
jest.mock("@/lib/sync/host-state-service", () => ({
  hostStateStatusAllowsWrites: () => true,
  installHostStateSyncForTarget: (...args: unknown[]) => installHostStateSyncMock(...args),
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
const registerNativePluginsMock = jest.fn(
  async (): Promise<{
    kind: "registered" | "unavailable" | "skipped"
    registered: string[]
    available: string[]
  }> => ({
    kind: "registered",
    registered: [],
    available: [],
  })
)
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
  transportCallMock.mockReset().mockResolvedValue({ schemaVersion: 2 })
  registerCompanionRuntimeTargetMock.mockReset().mockResolvedValue({ id: "host-a" })
  installHostStateSyncMock.mockClear()
  hostStateStopMock.mockClear()
  hostStateResyncMock.mockClear()
  hostSnapshotMock.mockReset().mockReturnValue({
    compatible: true,
    operations: ["claude_send"],
    grants: ["claude.chat"],
  })
  getActiveHostMock.mockReset().mockResolvedValue(null)
  adoptHostsMock.mockReset().mockResolvedValue(undefined)
  classifyWsHostMock.mockReset().mockReturnValue("ws-lan")
  remoteStepServerOptionsMock.mockClear()
  loadCompanionConfigMock.mockReset().mockReturnValue(null)
  activateAccountDatabaseMock.mockClear()
  setActiveRuntimeTargetContextMock.mockClear()
  setRuntimeSnapshotMock.mockClear()
  installCapabilityReporterMock.mockClear()
  delete mockTransport.getConnectionState
  delete mockTransport.onConnectionStateChange
  __resetMobileBootForTesting()
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
  it("redirects to the first-run flow when unpaired and no mode chosen", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(null)
    getSettingsMock.mockResolvedValueOnce({}) // no mobileRuntimeMode yet

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    // The standalone/paired fork moved into the first-run flow (ADR-0122);
    // an unset mode means that fork was never answered.
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/onboarding"))
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

  it("does not redirect when already on an onboarding route (/onboarding)", async () => {
    setMobile()
    pathnameMock.mockReturnValue("/onboarding")
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
  it("installs HostState sync for the registered runtime target and stops it on unmount", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(pairedConfig)
    transportCallMock.mockResolvedValueOnce(
      buildLocalHostFeatureManifest({ platform: "tauri", hostId: "host-a" })
    )

    const view = render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() =>
      expect(installHostStateSyncMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "local_acct_a", runtimeTargetId: "host-a" })
      )
    )
    view.unmount()
    expect(hostStateStopMock).toHaveBeenCalledTimes(1)
  })

  it("does not install host bindings when target registration fails", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(pairedConfig)
    registerCompanionRuntimeTargetMock.mockResolvedValueOnce(null)

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() => expect(registerCompanionRuntimeTargetMock).toHaveBeenCalled())
    expect(transportCallMock).not.toHaveBeenCalledWith("host_feature_manifest", {})
    expect(installHostStateSyncMock).not.toHaveBeenCalled()
  })

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

describe("<CompanionBootProvider /> — boot timeline (lib/boot/mobile-boot-stages)", () => {
  const stages = () => {
    const snap = getMobileBootSnapshot()
    return {
      settled: snap.settled,
      bridge: `${snap.stages.bridge.status}:${snap.stages.bridge.detail}`,
      companion: `${snap.stages.companion.status}:${snap.stages.companion.detail}`,
      host: `${snap.stages.host.status}:${snap.stages.host.detail}`,
      sync: `${snap.stages.sync.status}:${snap.stages.sync.detail}`,
    }
  }

  function mount() {
    return render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )
  }

  it("records the whole happy path: bridge → paired → linked → synced, settled before the sync", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)
    let releaseSync: (() => void) | undefined
    runSyncDownMock.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          releaseSync = () => resolve([])
        })
    )
    mount()

    await waitFor(() => expect(stages().sync).toBe("active:null"))
    expect(stages()).toMatchObject({
      settled: true,
      bridge: "done:registered",
      companion: "done:paired",
      host: "done:linked",
    })
    expect(getMobileBootSnapshot().active).toBe("sync")

    releaseSync?.()
    await waitFor(() => expect(stages().sync).toBe("done:synced"))
    expect(getMobileBootSnapshot().active).toBeNull()
  })

  it("marks the sync failed but keeps the boot settled when the first sync-down throws", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)
    runSyncDownMock.mockRejectedValueOnce(new Error("boom"))
    mount()
    await waitFor(() => expect(stages().sync).toBe("failed:syncFailed"))
    expect(stages().settled).toBe(true)
    expect(stages().host).toBe("done:linked")
  })

  it("standalone: pairing resolves standalone, host and sync are not needed, settled", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(null)
    getSettingsMock.mockResolvedValue({ mobileRuntimeMode: "standalone" })
    mount()
    await waitFor(() => expect(stages().settled).toBe(true))
    expect(stages()).toEqual({
      settled: true,
      bridge: "done:registered",
      companion: "done:standalone",
      host: "skipped:notNeeded",
      sync: "skipped:notNeeded",
    })
    expect(registerCompanionRuntimeTargetMock).not.toHaveBeenCalled()
  })

  it("unpaired: pairing resolves unpaired, later stages not needed, settled", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(null)
    getSettingsMock.mockResolvedValue({ mobileRuntimeMode: "paired" })
    mount()
    await waitFor(() => expect(stages().settled).toBe(true))
    expect(stages().companion).toBe("done:unpaired")
    expect(stages().host).toBe("skipped:notNeeded")
    expect(stages().sync).toBe("skipped:notNeeded")
  })

  it("host offline: no runtime target → host failed, sync not needed, settled", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)
    registerCompanionRuntimeTargetMock.mockResolvedValue(null)
    mount()
    await waitFor(() => expect(stages().settled).toBe(true))
    expect(stages().companion).toBe("done:paired")
    expect(stages().host).toBe("failed:offline")
    expect(stages().sync).toBe("skipped:notNeeded")
    expect(runSyncDownMock).not.toHaveBeenCalled()
  })

  it("host offline: manifest call throws → host failed, settled", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)
    transportCallMock.mockRejectedValue(new Error("unreachable"))
    mount()
    await waitFor(() => expect(stages().settled).toBe(true))
    expect(stages().host).toBe("failed:offline")
    expect(stages().sync).toBe("skipped:notNeeded")
  })

  it("host incompatible: manifest negotiated but rejected → host failed:incompatible, settled", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)
    hostSnapshotMock.mockReturnValue({ compatible: false, operations: [], grants: [] })
    mount()
    await waitFor(() => expect(stages().settled).toBe(true))
    expect(stages().host).toBe("failed:incompatible")
    expect(stages().sync).toBe("skipped:notNeeded")
    expect(runSyncDownMock).not.toHaveBeenCalled()
  })

  it("a native bridge that exposes no plugins is recorded as unavailable", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(null)
    getSettingsMock.mockResolvedValue({ mobileRuntimeMode: "standalone" })
    registerNativePluginsMock.mockResolvedValueOnce({
      kind: "unavailable",
      registered: [],
      available: [],
    })
    mount()
    await waitFor(() => expect(stages().bridge).toBe("failed:unavailable"))
  })

  it("stands aside from status/nav bar theme sync while the splash overlay is up, then repaints", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(null)
    getSettingsMock.mockResolvedValue({ mobileRuntimeMode: "standalone" })
    setMobileBootOverlayVisible(true)
    mount()
    await waitFor(() => expect(stages().settled).toBe(true))
    // Plugins are registered, but the overlay owns the chrome for now.
    expect(syncStatusBarMock).not.toHaveBeenCalled()
    expect(syncNavBarMock).not.toHaveBeenCalled()

    setMobileBootOverlayVisible(false)
    await waitFor(() => expect(syncStatusBarMock).toHaveBeenCalled())
    expect(syncNavBarMock).toHaveBeenCalled()
  })
})

describe("<CompanionBootProvider /> — host bindings detail", () => {
  function mount() {
    return render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )
  }

  it("restores the active companion host before hydrating: database, target context, connecting snapshot", async () => {
    setMobile()
    getActiveHostMock.mockResolvedValue({
      hostId: "host-a",
      endpoints: { baseUrl: "ws://192.168.1.10:7890" },
    })
    hydrateMock.mockResolvedValue(pairedConfig)
    mount()
    await waitFor(() => expect(runSyncDownMock).toHaveBeenCalled())
    expect(activateAccountDatabaseMock).toHaveBeenCalledWith("local_acct_a", "host-a")
    expect(setActiveRuntimeTargetContextMock).toHaveBeenCalledWith("local_acct_a", "host-a")
    expect(setRuntimeSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ id: "host-a", kind: "companion", hostKind: "desktop" }),
        vaultState: "unlocked",
        connectionState: "connecting",
      })
    )
  })

  it("routes remote resync requests: host-state to the host-state sync, everything else to a sync-down", async () => {
    const { remoteEventResyncCoordinator } = await import("@/lib/tauri/resync-coordinator")
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)
    transportCallMock.mockResolvedValue(
      buildLocalHostFeatureManifest({ platform: "tauri", hostId: "host-a" })
    )
    const view = mount()
    await waitFor(() => expect(installHostStateSyncMock).toHaveBeenCalled())
    await waitFor(() => expect(runSyncDownMock).toHaveBeenCalledTimes(1))

    await remoteEventResyncCoordinator.resolve(["host-state"])
    expect(hostStateResyncMock).toHaveBeenCalledTimes(1)
    await remoteEventResyncCoordinator.resolve(["session"])
    expect(runSyncDownMock).toHaveBeenCalledTimes(2)

    // Both resolvers are host cleanups: gone with the bindings.
    view.unmount()
    await waitFor(() => expect(hostStateStopMock).toHaveBeenCalled())
    expect(remoteEventResyncCoordinator.hasResolverForEvent("host-state:changed")).toBe(false)
  })

  it("installs the capability reporter only when the transport can report connection state", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)
    mockTransport.getConnectionState = () => "connected"
    mockTransport.onConnectionStateChange = () => () => {}
    mount()
    await waitFor(() => expect(installCapabilityReporterMock).toHaveBeenCalledTimes(1))
  })

  it("restarts host bindings when the companion config changes, and survives a restart failure", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)
    mount()
    await waitFor(() => expect(hydrateMock).toHaveBeenCalledTimes(1))

    window.dispatchEvent(new Event("cognia:companion-config-changed"))
    await waitFor(() => expect(hydrateMock).toHaveBeenCalledTimes(2))
  })

  it("logs, and keeps running, when a config-change restart of the host bindings fails", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)
    mount()
    await waitFor(() => expect(hydrateMock).toHaveBeenCalledTimes(1))

    adoptHostsMock.mockRejectedValueOnce(new Error("adoption exploded"))
    window.dispatchEvent(new Event("cognia:companion-config-changed"))
    await waitFor(() =>
      expect(logWarn).toHaveBeenCalledWith(
        "companion: failed to restart Host bindings",
        expect.objectContaining({ error: "adoption exploded" })
      )
    )
  })

  it("logs when a permission-triggered push registration rejects", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)
    mount()
    await waitFor(() => expect(registerPushMock).toHaveBeenCalled())
    expect(notificationPermissionHandler).not.toBeNull()

    registerPushMock.mockRejectedValueOnce(new Error("apns down"))
    notificationPermissionHandler?.()
    await waitFor(() =>
      expect(logWarn).toHaveBeenCalledWith(
        "companion: permission-triggered push registration failed",
        expect.objectContaining({ error: "apns down" })
      )
    )
  })

  it("stops a host-state sync that resolves after the bindings were torn down", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)
    transportCallMock.mockResolvedValue(
      buildLocalHostFeatureManifest({ platform: "tauri", hostId: "host-a" })
    )
    let releaseInstall: (() => void) | undefined
    installHostStateSyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseInstall = () =>
            resolve({
              status: { migrationStage: "host-authoritative" },
              stop: hostStateStopMock,
              resync: hostStateResyncMock,
            })
        })
    )
    const view = mount()
    await waitFor(() => expect(installHostStateSyncMock).toHaveBeenCalled())
    view.unmount()
    releaseInstall?.()
    await waitFor(() => expect(hostStateStopMock).toHaveBeenCalledTimes(1))
    // Never installed as a binding: no sync-down, no listeners.
    expect(runSyncDownMock).not.toHaveBeenCalled()
  })

  it("tolerates a native cleanup that throws on unmount", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(null)
    getSettingsMock.mockResolvedValue({ mobileRuntimeMode: "standalone" })
    deeplinkUnsubMock.mockImplementationOnce(() => {
      throw new Error("already gone")
    })
    const view = mount()
    await waitFor(() => expect(deeplinkSubscribeMock).toHaveBeenCalled())
    expect(() => view.unmount()).not.toThrow()
    expect(deeplinkUnsubMock).toHaveBeenCalled()
  })

  it("classifies a tunnelled host as cloud, and hands the remote step server a live device id", async () => {
    setMobile()
    classifyWsHostMock.mockReturnValue("wss-tunnel")
    getActiveHostMock.mockResolvedValue({
      hostId: "host-b",
      endpoints: { baseUrl: "wss://relay.example/ws" },
    })
    hydrateMock.mockResolvedValue(pairedConfig)
    loadCompanionConfigMock.mockReturnValue({ deviceId: "dev-42" })
    mount()
    await waitFor(() => expect(remoteStepServerOptionsMock).toHaveBeenCalled())
    expect(setRuntimeSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ hostKind: "cloud" }) })
    )
    const options = remoteStepServerOptionsMock.mock.calls[0][0] as { getDeviceId: () => unknown }
    expect(options.getDeviceId()).toBe("dev-42")
    loadCompanionConfigMock.mockReturnValue(null)
    expect(options.getDeviceId()).toBeUndefined()
  })

  it("registers push once: a later permission grant is a no-op after success, and de-dupes a concurrent grant", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)
    let releasePush: (() => void) | undefined
    registerPushMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePush = () => resolve({ kind: "registered", token: "tok-1", platform: "ios" })
        })
    )
    mount()
    await waitFor(() => expect(registerPushMock).toHaveBeenCalledTimes(1))
    // A grant while the first attempt is still in flight joins it.
    notificationPermissionHandler?.()
    expect(registerPushMock).toHaveBeenCalledTimes(1)

    releasePush?.()
    await waitFor(() => expect(reportPushTokenMock).toHaveBeenCalledWith("tok-1", "ios"))
    // Registered: a later grant has nothing to do.
    notificationPermissionHandler?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(registerPushMock).toHaveBeenCalledTimes(1)
  })

  it("stringifies non-Error failures in its warnings", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)
    transportCallMock.mockRejectedValueOnce("manifest-nope")
    mount()
    await waitFor(() =>
      expect(logWarn).toHaveBeenCalledWith(
        "companion: host manifest unavailable",
        expect.objectContaining({ error: "manifest-nope" })
      )
    )
    adoptHostsMock.mockRejectedValueOnce("restart-nope")
    window.dispatchEvent(new Event("cognia:companion-config-changed"))
    await waitFor(() =>
      expect(logWarn).toHaveBeenCalledWith(
        "companion: failed to restart Host bindings",
        expect.objectContaining({ error: "restart-nope" })
      )
    )
  })

  it("stringifies a non-Error sync-down failure and a non-Error push failure", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(pairedConfig)
    runSyncDownMock.mockRejectedValueOnce("sync-nope")
    mount()
    await waitFor(() =>
      expect(logWarn).toHaveBeenCalledWith(
        "companion: initial sync-down failed",
        expect.objectContaining({ error: "sync-nope" })
      )
    )
    await waitFor(() => expect(registerPushMock).toHaveBeenCalled())
    registerPushMock.mockRejectedValueOnce("push-nope")
    notificationPermissionHandler?.()
    await waitFor(() =>
      expect(logWarn).toHaveBeenCalledWith(
        "companion: permission-triggered push registration failed",
        expect.objectContaining({ error: "push-nope" })
      )
    )
  })

  it("ignores foreground pushes and pushes without a session id", async () => {
    setMobile()
    hydrateMock.mockResolvedValue(null)
    getSettingsMock.mockResolvedValue({ mobileRuntimeMode: "standalone" })
    let pushObserver: ((d: unknown) => void) | null = null
    installPushBridgeMock.mockImplementationOnce((observer: (d: unknown) => void) => {
      pushObserver = observer
      return Promise.resolve(uninstallPushBridgeMock)
    })
    mount()
    await waitFor(() => expect(pushObserver).not.toBeNull())
    pushObserver!({ data: {}, foreground: false })
    pushObserver!({ data: { sessionId: "s-1" }, foreground: true })
    expect(pushMock).not.toHaveBeenCalled()
  })
})
