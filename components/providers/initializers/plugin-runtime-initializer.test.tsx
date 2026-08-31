import { StrictMode } from "react"
import { render, waitFor } from "@testing-library/react"

import { PluginRuntimeInitializer } from "./plugin-runtime-initializer"
import { detectPlatform } from "@/lib/platform/detect"

// Preserve the real module's other exports (isTauri/isCapacitor/…) so any
// transitive importer keeps working; only `detectPlatform` is driven per-test.
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: jest.fn(() => "web"),
}))

jest.mock("@cognia/logging", () => ({
  loggers: {
    plugin: { debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
  },
}))

const mockResolveBootstrap = jest.fn()
jest.mock("@/lib/plugin/core/bootstrap", () => ({
  resolvePluginRuntimeBootstrap: (...args: unknown[]) => mockResolveBootstrap(...args),
}))

const mockInitializeManager = jest.fn()
jest.mock("@/lib/plugin/core/manager", () => ({
  initializePluginManager: (...args: unknown[]) => mockInitializeManager(...args),
}))

const mockInstallPackWarningRefreshWiring = jest.fn()
jest.mock("@/lib/plugin/character-pack/warning-refresh-wiring", () => ({
  installPackWarningRefreshWiring: () => mockInstallPackWarningRefreshWiring(),
}))

const mockMarkBootCapabilityReady = jest.fn()
const mockMarkBootCapabilityFailed = jest.fn()
let mockPluginRuntimeRequested = true
jest.mock("@/lib/boot/capabilities", () => ({
  markBootCapabilityReady: (...args: unknown[]) => mockMarkBootCapabilityReady(...args),
  markBootCapabilityFailed: (...args: unknown[]) => mockMarkBootCapabilityFailed(...args),
  getBootCapabilitySnapshot: () => 1,
  subscribeBootCapabilities: () => () => {},
  isBootCapabilityRequested: () => mockPluginRuntimeRequested,
}))

jest.mock("@/lib/plugin/messaging/message-bus", () => ({
  SystemEvents: { APP_READY: "system:app:ready", APP_CLOSING: "system:app:closing" },
  emitSystemBusEvent: jest.fn(),
}))
import { emitSystemBusEvent } from "@/lib/plugin/messaging/message-bus"
const mockEmitBus = emitSystemBusEvent as jest.Mock

const mockDisposeMicrovmAdapters = jest.fn(async () => undefined)
jest.mock("@/lib/sandbox/microvm-bridge", () => ({
  disposeMicrovmAdapters: () => mockDisposeMicrovmAdapters(),
}))

const mockGetCurrentWindow = jest.fn()
jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mockGetCurrentWindow(),
}))

const mockAppDataDir = jest.fn()
const mockJoin = jest.fn()
jest.mock("@tauri-apps/api/path", () => ({
  appDataDir: () => mockAppDataDir(),
  join: (...parts: string[]) => mockJoin(...parts),
}))

const mockDetectPlatform = detectPlatform as jest.MockedFunction<typeof detectPlatform>
let mockUnlockedAccountId: string | null = "acct_test"
let mockAccountRevision = 1

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      unlockedAccountId: mockUnlockedAccountId,
      accountRevision: mockAccountRevision,
    }),
}))

describe("PluginRuntimeInitializer", () => {
  const warningRefreshTeardown = jest.fn()
  const originalE2E = process.env.NEXT_PUBLIC_E2E

  beforeEach(() => {
    jest.clearAllMocks()
    mockInitializeManager.mockResolvedValue(undefined)
    mockInstallPackWarningRefreshWiring.mockReturnValue(warningRefreshTeardown)
    mockPluginRuntimeRequested = true
    mockUnlockedAccountId = "acct_test"
    mockAccountRevision = 1
    process.env.NEXT_PUBLIC_E2E = originalE2E
    delete (window as typeof window & { __cogniaPluginRuntimeReady?: boolean })
      .__cogniaPluginRuntimeReady
    window.history.replaceState({}, "", "/")
  })

  it("keeps the pre-account E2E runtime off unrelated browser routes", () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    render(<PluginRuntimeInitializer onlyForPluginSurfaceE2E />)

    expect(mockInitializeManager).not.toHaveBeenCalled()
    expect(mockInstallPackWarningRefreshWiring).not.toHaveBeenCalled()
  })

  it("boots the plugin-surface E2E runtime without an account or boot request", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    mockPluginRuntimeRequested = false
    mockUnlockedAccountId = null
    mockDetectPlatform.mockReturnValue("web")
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: true,
      config: { runtimeProfile: "browser", pluginDirectory: "", enablePython: false },
    })
    window.history.replaceState({}, "", "/e2e/plugin-ui-surfaces")

    render(<PluginRuntimeInitializer onlyForPluginSurfaceE2E />)

    await waitFor(() => expect(mockInitializeManager).toHaveBeenCalledTimes(1))
    expect(mockInstallPackWarningRefreshWiring).toHaveBeenCalledTimes(1)
    expect(mockMarkBootCapabilityReady).toHaveBeenCalledWith("plugin-runtime")
  })

  it("does not enable the pre-account bypass outside an E2E build", () => {
    process.env.NEXT_PUBLIC_E2E = "0"
    mockUnlockedAccountId = null
    window.history.replaceState({}, "", "/e2e/plugin-ui-surfaces")

    render(<PluginRuntimeInitializer onlyForPluginSurfaceE2E />)

    expect(mockInitializeManager).not.toHaveBeenCalled()
    expect(mockInstallPackWarningRefreshWiring).not.toHaveBeenCalled()
  })

  it("boots the manager with the browser profile when not in Tauri", async () => {
    mockDetectPlatform.mockReturnValue("web")
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: true,
      config: { runtimeProfile: "browser", pluginDirectory: "", enablePython: false },
    })

    render(<PluginRuntimeInitializer />)

    await waitFor(() => expect(mockInitializeManager).toHaveBeenCalledTimes(1))
    expect(mockResolveBootstrap).toHaveBeenCalledWith({
      isTauri: false,
      isMobile: false,
      windowLabel: null,
      pluginDirectory: undefined,
    })
    expect(mockInitializeManager).toHaveBeenCalledWith({
      runtimeProfile: "browser",
      pluginDirectory: "",
      enablePython: false,
    })
    expect(mockMarkBootCapabilityReady).toHaveBeenCalledWith("plugin-runtime")
    // The Tauri path/window APIs must not be touched in web mode.
    expect(mockGetCurrentWindow).not.toHaveBeenCalled()
    expect(mockAppDataDir).not.toHaveBeenCalled()
  })

  it("does not boot while the LocalProfile is locked", () => {
    mockUnlockedAccountId = null
    render(<PluginRuntimeInitializer />)
    expect(mockInitializeManager).not.toHaveBeenCalled()
  })

  it("installs character-pack warning refresh wiring in the browser", () => {
    mockDetectPlatform.mockReturnValue("web")
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: true,
      config: { runtimeProfile: "browser", pluginDirectory: "", enablePython: false },
    })

    const { unmount } = render(<PluginRuntimeInitializer />)

    expect(mockInstallPackWarningRefreshWiring).toHaveBeenCalledTimes(1)
    unmount()
    expect(warningRefreshTeardown).toHaveBeenCalledTimes(1)
  })

  it("reinstalls character-pack warning refresh wiring after a StrictMode replay", () => {
    mockDetectPlatform.mockReturnValue("web")
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: true,
      config: { runtimeProfile: "browser", pluginDirectory: "", enablePython: false },
    })

    render(
      <StrictMode>
        <PluginRuntimeInitializer />
      </StrictMode>
    )

    expect(mockInstallPackWarningRefreshWiring).toHaveBeenCalledTimes(2)
    expect(warningRefreshTeardown).toHaveBeenCalledTimes(1)
  })

  it("boots the manager with the mobile profile in the Capacitor shell", async () => {
    mockDetectPlatform.mockReturnValue("mobile")
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: true,
      config: { runtimeProfile: "mobile", pluginDirectory: "", enablePython: false },
    })

    render(<PluginRuntimeInitializer />)

    await waitFor(() => expect(mockInitializeManager).toHaveBeenCalledTimes(1))
    expect(mockResolveBootstrap).toHaveBeenCalledWith({
      isTauri: false,
      isMobile: true,
      windowLabel: null,
      pluginDirectory: undefined,
    })
    expect(mockInitializeManager).toHaveBeenCalledWith({
      runtimeProfile: "mobile",
      pluginDirectory: "",
      enablePython: false,
    })
    // Mobile has no Tauri bridge — the window/path APIs stay untouched.
    expect(mockGetCurrentWindow).not.toHaveBeenCalled()
    expect(mockAppDataDir).not.toHaveBeenCalled()
  })

  it("resolves window label + plugin directory on Tauri before booting", async () => {
    mockDetectPlatform.mockReturnValue("tauri")
    mockGetCurrentWindow.mockReturnValue({ label: "main" })
    mockAppDataDir.mockResolvedValue("C:\\Users\\u\\AppData\\Roaming\\app")
    mockJoin.mockResolvedValue("C:\\Users\\u\\AppData\\Roaming\\app\\cognia\\plugins")
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: true,
      config: {
        runtimeProfile: "tauri",
        pluginDirectory: "C:\\Users\\u\\AppData\\Roaming\\app\\cognia\\plugins",
        enablePython: true,
      },
    })

    render(<PluginRuntimeInitializer />)

    await waitFor(() => expect(mockInitializeManager).toHaveBeenCalledTimes(1))
    expect(mockJoin).toHaveBeenCalledWith(
      "C:\\Users\\u\\AppData\\Roaming\\app",
      "cognia",
      "plugins"
    )
    expect(mockResolveBootstrap).toHaveBeenCalledWith({
      isTauri: true,
      isMobile: false,
      windowLabel: "main",
      pluginDirectory: "C:\\Users\\u\\AppData\\Roaming\\app\\cognia\\plugins",
    })
  })

  it("boots the manager even when seeding the bundled plugins throws", async () => {
    // The seeder resolves a bundle resource and calls into the host. Neither
    // is available in this suite, which is the point: a bundled plugin that
    // cannot be put on disk costs the user that plugin, and must never cost
    // them the plugin runtime. Removing the guard around it makes every Tauri
    // case in this file hang instead of failing here alone.
    mockDetectPlatform.mockReturnValue("tauri")
    mockGetCurrentWindow.mockReturnValue({ label: "main" })
    mockAppDataDir.mockResolvedValue("/data")
    mockJoin.mockResolvedValue("/data/cognia/plugins")
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: true,
      config: { runtimeProfile: "tauri", pluginDirectory: "/data/cognia/plugins" },
    })

    render(<PluginRuntimeInitializer />)

    await waitFor(() => expect(mockInitializeManager).toHaveBeenCalledTimes(1))
    expect(mockMarkBootCapabilityFailed).not.toHaveBeenCalled()
  })

  it("skips manager boot when the bootstrap resolution refuses", async () => {
    mockDetectPlatform.mockReturnValue("tauri")
    mockGetCurrentWindow.mockReturnValue({ label: "plugin-devtools" })
    mockAppDataDir.mockResolvedValue("/data")
    mockJoin.mockResolvedValue("/data/cognia/plugins")
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: false,
      reason: "non-main-window",
    })

    render(<PluginRuntimeInitializer />)

    await waitFor(() => expect(mockResolveBootstrap).toHaveBeenCalledTimes(1))
    expect(mockInitializeManager).not.toHaveBeenCalled()
    expect(mockMarkBootCapabilityReady).toHaveBeenCalledWith("plugin-runtime")
  })

  it("reports boot errors and retries after a fresh capability request", async () => {
    mockDetectPlatform.mockReturnValue("web")
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: true,
      config: { runtimeProfile: "browser", pluginDirectory: "", enablePython: false },
    })
    mockInitializeManager.mockRejectedValue(new Error("boom"))

    const { rerender } = render(<PluginRuntimeInitializer />)

    await waitFor(() => expect(mockInitializeManager).toHaveBeenCalledTimes(1))
    // No throw — the warn logger absorbed it (asserted via the mock).
    const { loggers } = jest.requireMock("@cognia/logging") as {
      loggers: { plugin: { warn: jest.Mock } }
    }
    await waitFor(() => expect(loggers.plugin.warn).toHaveBeenCalled())
    expect(mockMarkBootCapabilityFailed).toHaveBeenCalledWith("plugin-runtime", expect.any(Error))

    mockPluginRuntimeRequested = false
    rerender(<PluginRuntimeInitializer />)
    mockInitializeManager.mockResolvedValue(undefined)
    mockPluginRuntimeRequested = true
    rerender(<PluginRuntimeInitializer />)
    await waitFor(() => expect(mockInitializeManager).toHaveBeenCalledTimes(2))
  })

  it("emits APP_READY on the plugin bus after the manager boots", async () => {
    mockDetectPlatform.mockReturnValue("web")
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: true,
      config: { runtimeProfile: "browser", pluginDirectory: "", enablePython: false },
    })

    render(<PluginRuntimeInitializer />)

    await waitFor(() => expect(mockInitializeManager).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockEmitBus).toHaveBeenCalledWith("system:app:ready", {}))
  })

  it("publishes E2E readiness only after the manager boot settles", async () => {
    let release!: () => void
    mockInitializeManager.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    mockDetectPlatform.mockReturnValue("web")
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: true,
      config: { runtimeProfile: "browser", pluginDirectory: "", enablePython: false },
    })

    render(<PluginRuntimeInitializer />)
    await waitFor(() => expect(mockInitializeManager).toHaveBeenCalledTimes(1))
    expect(
      (window as typeof window & { __cogniaPluginRuntimeReady?: boolean })
        .__cogniaPluginRuntimeReady
    ).toBe(false)

    release()
    await waitFor(() =>
      expect(
        (window as typeof window & { __cogniaPluginRuntimeReady?: boolean })
          .__cogniaPluginRuntimeReady
      ).toBe(true)
    )
  })

  it("emits APP_CLOSING on the plugin bus on beforeunload", async () => {
    mockDetectPlatform.mockReturnValue("web")
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: true,
      config: { runtimeProfile: "browser", pluginDirectory: "", enablePython: false },
    })

    render(<PluginRuntimeInitializer />)
    await waitFor(() => expect(mockInitializeManager).toHaveBeenCalledTimes(1))
    mockEmitBus.mockClear()
    window.dispatchEvent(new Event("beforeunload"))
    expect(mockEmitBus).toHaveBeenCalledWith("system:app:closing", {})
    expect(mockDisposeMicrovmAdapters).toHaveBeenCalledTimes(1)
  })

  it("does not re-initialize on re-render", async () => {
    mockDetectPlatform.mockReturnValue("web")
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: true,
      config: { runtimeProfile: "browser", pluginDirectory: "", enablePython: false },
    })

    const { rerender } = render(<PluginRuntimeInitializer />)
    await waitFor(() => expect(mockInitializeManager).toHaveBeenCalledTimes(1))
    rerender(<PluginRuntimeInitializer />)
    await waitFor(() => expect(mockInitializeManager).toHaveBeenCalledTimes(1))
  })
})
