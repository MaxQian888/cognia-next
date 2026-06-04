import { render, waitFor } from "@testing-library/react"

import { PluginRuntimeInitializer } from "./plugin-runtime-initializer"
import { isTauri } from "@/lib/native/utils"

jest.mock("@/lib/native/utils", () => ({
  isTauri: jest.fn(() => false),
}))

jest.mock("@/lib/logging", () => ({
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

const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

describe("PluginRuntimeInitializer", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInitializeManager.mockResolvedValue(undefined)
  })

  it("boots the manager with the browser profile when not in Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: true,
      config: { runtimeProfile: "browser", pluginDirectory: "", enablePython: false },
    })

    render(<PluginRuntimeInitializer />)

    await waitFor(() => expect(mockInitializeManager).toHaveBeenCalledTimes(1))
    expect(mockResolveBootstrap).toHaveBeenCalledWith({
      isTauri: false,
      windowLabel: null,
      pluginDirectory: undefined,
    })
    expect(mockInitializeManager).toHaveBeenCalledWith({
      runtimeProfile: "browser",
      pluginDirectory: "",
      enablePython: false,
    })
    // The Tauri path/window APIs must not be touched in web mode.
    expect(mockGetCurrentWindow).not.toHaveBeenCalled()
    expect(mockAppDataDir).not.toHaveBeenCalled()
  })

  it("resolves window label + plugin directory on Tauri before booting", async () => {
    mockIsTauri.mockReturnValue(true)
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
      windowLabel: "main",
      pluginDirectory: "C:\\Users\\u\\AppData\\Roaming\\app\\cognia\\plugins",
    })
  })

  it("skips manager boot when the bootstrap resolution refuses", async () => {
    mockIsTauri.mockReturnValue(true)
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
  })

  it("swallows boot errors instead of crashing the layout", async () => {
    mockIsTauri.mockReturnValue(false)
    mockResolveBootstrap.mockReturnValue({
      shouldInitialize: true,
      config: { runtimeProfile: "browser", pluginDirectory: "", enablePython: false },
    })
    mockInitializeManager.mockRejectedValue(new Error("boom"))

    render(<PluginRuntimeInitializer />)

    await waitFor(() => expect(mockInitializeManager).toHaveBeenCalledTimes(1))
    // No throw — the warn logger absorbed it (asserted via the mock).
    const { loggers } = jest.requireMock("@/lib/logging") as {
      loggers: { plugin: { warn: jest.Mock } }
    }
    await waitFor(() => expect(loggers.plugin.warn).toHaveBeenCalled())
  })

  it("does not re-initialize on re-render", async () => {
    mockIsTauri.mockReturnValue(false)
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
