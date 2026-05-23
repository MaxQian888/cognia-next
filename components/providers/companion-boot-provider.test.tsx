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
const subscribePushMock = jest.fn()
jest.mock("@/lib/push/push-notifications", () => ({
  registerPushNotifications: () => registerPushMock(),
  reportPushTokenToDesktop: (token: string, platform: string) =>
    reportPushTokenMock(token, platform),
  subscribeToPushNotifications: (handler: (d: unknown) => void) => subscribePushMock(handler),
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
jest.mock("@/lib/logging", () => ({
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
jest.mock("@/lib/capacitor/deeplink", () => ({
  subscribe: (handler: unknown) => deeplinkSubscribeMock(handler),
}))
jest.mock("@/lib/capacitor/splash-screen", () => ({
  hide: jest.fn(async () => ({ kind: "ok" })),
}))
jest.mock("@/lib/capacitor/status-bar", () => ({
  syncWithTheme: jest.fn(async () => ({ kind: "ok" })),
}))
jest.mock("@/lib/capacitor/navigation-bar", () => ({
  syncWithTheme: jest.fn(async () => ({ kind: "ok" })),
}))
jest.mock("@/lib/capacitor/local-notifications", () => ({
  ensureChannel: jest.fn(async () => ({ kind: "ok" })),
}))
jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", theme: "light", setTheme: jest.fn() }),
}))

beforeEach(() => {
  replaceMock.mockReset()
  pushMock.mockReset()
  pathnameMock.mockReset().mockReturnValue("/")
  hydrateMock.mockReset()
  runSyncDownMock.mockReset().mockResolvedValue([])
  installForegroundSyncMock.mockReset().mockReturnValue(() => {})
  installEventDrivenSyncMock.mockReset().mockReturnValue(() => {})
  registerPushMock.mockReset().mockResolvedValue({ kind: "permission_denied" })
  reportPushTokenMock.mockReset().mockResolvedValue({ ok: true })
  subscribePushMock.mockReset().mockResolvedValue(() => Promise.resolve())
  toastFn.mockReset()
  logInfo.mockReset()
  logWarn.mockReset()
  deeplinkUnsubMock.mockReset()
  deeplinkSubscribeMock.mockClear()
  delete (window as { Capacitor?: unknown }).Capacitor
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

function setMobile() {
  ;(window as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
    isNativePlatform: () => true,
  }
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

describe("<CompanionBootProvider /> — unpaired", () => {
  it("redirects to /pair when storage is empty", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(null)

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/pair"))
    // Sync + push should NOT run when there's no pairing.
    expect(runSyncDownMock).not.toHaveBeenCalled()
    expect(registerPushMock).not.toHaveBeenCalled()
  })

  it("does not redirect when already on /pair", async () => {
    setMobile()
    pathnameMock.mockReturnValue("/pair")
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
  const pairedConfig = {
    baseUrl: "http://test:7890",
    deviceJwt: "jwt",
    deviceId: "abc",
    serverVersion: "1.0",
  }

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
    expect(registerPushMock).toHaveBeenCalled()
    await waitFor(() => expect(reportPushTokenMock).toHaveBeenCalledWith("tok-123", "ios"))
    expect(subscribePushMock).toHaveBeenCalled()
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
    // Subscribe still happens (silent pushes can come without registration).
    await waitFor(() => expect(subscribePushMock).toHaveBeenCalled())
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

  it("a foreground push surfaces as a sonner toast", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(pairedConfig)
    registerPushMock.mockResolvedValueOnce({ kind: "permission_denied" })

    let pushHandler: ((d: unknown) => void) | null = null
    subscribePushMock.mockImplementationOnce((handler: (d: unknown) => void) => {
      pushHandler = handler
      return Promise.resolve(() => Promise.resolve())
    })

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )
    await waitFor(() => expect(pushHandler).not.toBeNull())

    pushHandler!({
      title: "New message",
      body: "ping",
      data: {},
      foreground: true,
    })

    expect(toastFn).toHaveBeenCalledWith("New message", { description: "ping" })
  })

  it("a tap-from-background push deep-links to the session", async () => {
    setMobile()
    hydrateMock.mockResolvedValueOnce(pairedConfig)
    registerPushMock.mockResolvedValueOnce({ kind: "permission_denied" })

    let pushHandler: ((d: unknown) => void) | null = null
    subscribePushMock.mockImplementationOnce((handler: (d: unknown) => void) => {
      pushHandler = handler
      return Promise.resolve(() => Promise.resolve())
    })

    render(
      <CompanionBootProvider>
        <div>child</div>
      </CompanionBootProvider>
    )
    await waitFor(() => expect(pushHandler).not.toBeNull())

    pushHandler!({
      data: { sessionId: "s-123" },
      foreground: false,
    })

    expect(pushMock).toHaveBeenCalledWith("/inbox/c/s-123")
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
