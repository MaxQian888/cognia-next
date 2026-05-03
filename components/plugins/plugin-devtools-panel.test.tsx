/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string, vars?: Record<string, unknown>) => {
    const composed = ns ? `${ns}.${key}` : key
    if (!vars) return composed
    return `${composed}(${JSON.stringify(vars)})`
  },
}))

let mockPlugins: Array<{ id: string; name: string; version: string }> = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockPlugins,
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(async () => mockPlugins),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))

const mockGetDebugLogs = jest.fn()
const mockGetHookCalls = jest.fn()
const mockGetPerformanceStats = jest.fn()
const mockInspectAllPlugins = jest.fn()
const mockClearDebugLogs = jest.fn()
const mockClearHookCalls = jest.fn()

jest.mock("@/lib/plugin/devtools/dev-tools", () => ({
  getDebugLogs: (...args: unknown[]) => mockGetDebugLogs(...args),
  getHookCalls: (...args: unknown[]) => mockGetHookCalls(...args),
  getPerformanceStats: (...args: unknown[]) => mockGetPerformanceStats(...args),
  inspectAllPlugins: (...args: unknown[]) => mockInspectAllPlugins(...args),
  clearDebugLogs: (...args: unknown[]) => mockClearDebugLogs(...args),
  clearHookCalls: (...args: unknown[]) => mockClearHookCalls(...args),
}))

const mockReloadPlugin = jest.fn(async () => undefined)
const mockReloadAll = jest.fn(async () => undefined)
let mockHotReload = {
  isWatching: false,
  reloadHistory: [] as Array<{
    pluginId: string
    success: boolean
    duration: number
  }>,
  reloadPlugin: mockReloadPlugin,
  reloadAll: mockReloadAll,
}
jest.mock("@/lib/plugin/devtools/hot-reload.client", () => ({
  usePluginHotReload: () => mockHotReload,
}))

import {
  PluginDevtoolsPanel,
  LogsPane,
  BusPane,
  HookHistoryPane,
  ProfilerPane,
  HotReloadPane,
  InspectPane,
} from "./plugin-devtools-panel"
import { isTauri } from "@/lib/tauri"

beforeEach(() => {
  window.localStorage.clear()
  mockPlugins = []
  mockGetDebugLogs.mockReset().mockReturnValue([])
  mockGetHookCalls.mockReset().mockReturnValue([])
  mockGetPerformanceStats.mockReset().mockReturnValue({
    totalOperations: 0,
    averageDuration: 0,
    maxDuration: 0,
    minDuration: 0,
    byOperation: {},
  })
  mockInspectAllPlugins.mockReset().mockReturnValue([])
  mockClearDebugLogs.mockReset()
  mockClearHookCalls.mockReset()
  mockReloadPlugin.mockClear()
  mockReloadAll.mockClear()
  mockHotReload = {
    isWatching: false,
    reloadHistory: [],
    reloadPlugin: mockReloadPlugin,
    reloadAll: mockReloadAll,
  }
  ;(isTauri as jest.Mock).mockReturnValue(false)
})

function enableDeveloperMode() {
  window.localStorage.setItem("cognia.plugins.developerMode", "true")
}

describe("PluginDevtoolsPanel — gate", () => {
  it("shows the gate hint when developer mode is off", () => {
    render(<PluginDevtoolsPanel />)
    expect(screen.getByText("plugins.devtoolsPanel.gateHint")).toBeInTheDocument()
  })

  it("clicking the enable button persists the flag and reveals tabs", async () => {
    render(<PluginDevtoolsPanel />)
    fireEvent.click(screen.getByText("plugins.devtoolsPanel.enableDeveloperMode"))
    expect(window.localStorage.getItem("cognia.plugins.developerMode")).toBe("true")
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "plugins.devtoolsPanel.tabs.logs" })
      ).toBeInTheDocument()
    )
  })

  it("renders all six sub-tabs once enabled", async () => {
    enableDeveloperMode()
    render(<PluginDevtoolsPanel />)
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "plugins.devtoolsPanel.tabs.logs" })
      ).toBeInTheDocument()
    )
    for (const key of ["logs", "bus", "hooks", "profiler", "hotReload", "inspect"]) {
      expect(
        screen.getByRole("tab", { name: `plugins.devtoolsPanel.tabs.${key}` })
      ).toBeInTheDocument()
    }
  })
})

describe("LogsPane", () => {
  it("renders empty hint when there are no logs", async () => {
    render(<LogsPane />)
    expect(await screen.findByText("plugins.devtoolsPanel.logs.empty")).toBeInTheDocument()
  })

  it("renders log rows from getDebugLogs", async () => {
    mockGetDebugLogs.mockReturnValue([
      {
        timestamp: new Date("2026-05-03T12:00:00.000Z"),
        pluginId: "p1",
        level: "info",
        category: "core",
        message: "hello",
      },
    ])
    render(<LogsPane />)
    await waitFor(() => expect(screen.getByText(/\[core\] hello/)).toBeInTheDocument())
  })

  it("clear button calls clearDebugLogs", async () => {
    mockGetDebugLogs.mockReturnValue([
      {
        timestamp: new Date(),
        pluginId: "p1",
        level: "info",
        category: "core",
        message: "x",
      },
    ])
    render(<LogsPane />)
    fireEvent.click(await screen.findByText("plugins.devtoolsPanel.clear"))
    expect(mockClearDebugLogs).toHaveBeenCalled()
  })
})

describe("BusPane", () => {
  it("shows desktopOnly when not running under Tauri", async () => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    render(<BusPane />)
    expect(await screen.findByText("plugins.devtoolsPanel.bus.desktopOnly")).toBeInTheDocument()
  })
})

describe("HookHistoryPane", () => {
  it("renders empty hint when there is no hook activity", async () => {
    render(<HookHistoryPane />)
    expect(await screen.findByText("plugins.devtoolsPanel.hooks.empty")).toBeInTheDocument()
  })

  it("renders hook rows", async () => {
    mockGetHookCalls.mockReturnValue([
      {
        timestamp: new Date(),
        pluginId: "p1",
        hookName: "onUserPromptSubmit",
        args: [],
        result: undefined,
        error: undefined,
        duration: 12.34,
      },
    ])
    render(<HookHistoryPane />)
    expect(await screen.findByText("onUserPromptSubmit")).toBeInTheDocument()
    expect(screen.getByText("12.3ms")).toBeInTheDocument()
  })
})

describe("ProfilerPane", () => {
  it("shows the no-plugins empty state", async () => {
    render(<ProfilerPane />)
    expect(await screen.findByText("plugins.devtoolsPanel.profiler.emptyAll")).toBeInTheDocument()
  })

  it("auto-selects the first plugin and renders its stats", async () => {
    mockPlugins = [{ id: "p1", name: "Plugin One", version: "1.0.0" }]
    mockGetPerformanceStats.mockReturnValue({
      totalOperations: 5,
      averageDuration: 10,
      maxDuration: 20,
      minDuration: 1,
      byOperation: { foo: { count: 5, avgDuration: 10 } },
    })
    render(<ProfilerPane />)
    await waitFor(() => expect(mockGetPerformanceStats).toHaveBeenCalledWith("p1"))
    expect(screen.getByText("foo")).toBeInTheDocument()
  })
})

describe("HotReloadPane", () => {
  it("shows the empty-plugins message when no plugins are installed", async () => {
    render(<HotReloadPane />)
    expect(
      await screen.findByText("plugins.devtoolsPanel.hotReload.emptyPlugins")
    ).toBeInTheDocument()
  })

  it("clicking reload calls reloadPlugin with the plugin id", async () => {
    mockPlugins = [{ id: "p1", name: "Plugin One", version: "1.0.0" }]
    render(<HotReloadPane />)
    const button = await screen.findByLabelText(/reloadAria/)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(mockReloadPlugin).toHaveBeenCalledWith("p1")
  })

  it("reload-all triggers reloadAll", async () => {
    mockPlugins = [{ id: "p1", name: "Plugin One", version: "1.0.0" }]
    render(<HotReloadPane />)
    const button = await screen.findByText("plugins.devtoolsPanel.hotReload.reloadAll")
    await act(async () => {
      fireEvent.click(button)
    })
    expect(mockReloadAll).toHaveBeenCalled()
  })
})

describe("InspectPane", () => {
  it("shows empty when inspectAllPlugins returns nothing", async () => {
    render(<InspectPane />)
    expect(await screen.findByText("plugins.devtoolsPanel.inspect.empty")).toBeInTheDocument()
  })

  it("renders one row per inspected plugin and surfaces error badges", async () => {
    mockInspectAllPlugins.mockReturnValue([
      {
        id: "p1",
        manifest: { id: "p1" },
        status: "active",
        config: {},
        registeredHooks: ["onStartup"],
        registeredTools: [],
        registeredModes: [],
        registeredCommands: [],
        registeredComponents: [],
        lastError: undefined,
      },
      {
        id: "p2",
        manifest: { id: "p2" },
        status: "error",
        config: {},
        registeredHooks: [],
        registeredTools: [],
        registeredModes: [],
        registeredCommands: [],
        registeredComponents: [],
        lastError: "boom",
      },
    ])
    render(<InspectPane />)
    expect(await screen.findByText("p1")).toBeInTheDocument()
    expect(screen.getByText("p2")).toBeInTheDocument()
    expect(screen.getByText("plugins.devtoolsPanel.inspect.error")).toBeInTheDocument()
  })
})
