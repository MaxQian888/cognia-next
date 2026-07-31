/**
 * @jest-environment jsdom
 */

import { act, render } from "@testing-library/react"

jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn(),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

jest.mock("@cognia/logging", () => ({
  loggers: {
    plugin: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  },
}))

const mockScan = jest.fn(async () => undefined)
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({ scanPlugins: mockScan }),
}))

import { listen } from "@tauri-apps/api/event"
import { isTauri } from "@/lib/tauri"

import { useCliBridgeEvents } from "./use-cli-bridge-events"
import { useHotReloadHistoryStore } from "@/stores/plugin-runtime/hot-reload-history-store"

const mockListen = listen as jest.MockedFunction<typeof listen>
const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

// One mock unlisten per call so we can verify cleanup wires the right
// number of unlisteners.
function makeUnlisten() {
  return jest.fn() as jest.Mock
}

type EventName =
  "cli-bridge:plugin-installed" | "cli-bridge:plugin-uninstalled" | "plugin-hot-reload"

type Callback = (event: { payload: { plugin_id: string; source?: string; via?: string } }) => void

interface ListenerRecord {
  unlisten: jest.Mock
  callback: Callback
}

const listeners: Record<EventName, ListenerRecord | undefined> = {
  "cli-bridge:plugin-installed": undefined,
  "cli-bridge:plugin-uninstalled": undefined,
  "plugin-hot-reload": undefined,
}

function resetListeners() {
  listeners["cli-bridge:plugin-installed"] = undefined
  listeners["cli-bridge:plugin-uninstalled"] = undefined
  listeners["plugin-hot-reload"] = undefined
}

function Harness() {
  useCliBridgeEvents()
  return null
}

beforeEach(() => {
  resetListeners()
  mockListen.mockReset()
  mockIsTauri.mockReset()
  mockIsTauri.mockReturnValue(true)
  mockScan.mockClear()
  useHotReloadHistoryStore.getState().clear()
  mockListen.mockImplementation(async (event, callback) => {
    const name = event as EventName
    const unlisten = makeUnlisten()
    listeners[name] = { unlisten, callback: callback as Callback }
    return unlisten
  })
})

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("useCliBridgeEvents", () => {
  it("subscribes to all three event channels when running in Tauri", async () => {
    render(<Harness />)
    await flushMicrotasks()
    expect(mockListen).toHaveBeenCalledTimes(3)
    expect(listeners["cli-bridge:plugin-installed"]).toBeDefined()
    expect(listeners["cli-bridge:plugin-uninstalled"]).toBeDefined()
    expect(listeners["plugin-hot-reload"]).toBeDefined()
  })

  it("records install events in the hot-reload history and rescans", async () => {
    render(<Harness />)
    await flushMicrotasks()
    listeners["cli-bridge:plugin-installed"]!.callback({
      payload: { plugin_id: "demo-plugin" },
    })
    const entries = useHotReloadHistoryStore.getState().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      pluginId: "demo-plugin",
      kind: "install",
      source: "cli-bridge",
    })
    await flushMicrotasks()
    expect(mockScan).toHaveBeenCalled()
  })

  it("classifies a hot-reload-via-install event as kind=install", async () => {
    render(<Harness />)
    await flushMicrotasks()
    listeners["plugin-hot-reload"]!.callback({
      payload: { plugin_id: "demo-plugin", source: "cli-bridge", via: "install" },
    })
    // The earlier `cli-bridge:plugin-installed` event in the bridge fires
    // first; the global event arrives ~1ms later. Both should dedupe in
    // the store to a single row of kind="install".
    listeners["cli-bridge:plugin-installed"]!.callback({
      payload: { plugin_id: "demo-plugin" },
    })
    const entries = useHotReloadHistoryStore.getState().entries
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe("install")
  })

  it("classifies a hot-reload-via-reload event as kind=hot-reload", async () => {
    render(<Harness />)
    await flushMicrotasks()
    listeners["plugin-hot-reload"]!.callback({
      payload: { plugin_id: "demo-plugin", source: "cli-bridge", via: "reload" },
    })
    const entries = useHotReloadHistoryStore.getState().entries
    expect(entries[0].kind).toBe("hot-reload")
  })

  it("records uninstall events", async () => {
    render(<Harness />)
    await flushMicrotasks()
    listeners["cli-bridge:plugin-uninstalled"]!.callback({
      payload: { plugin_id: "demo-plugin" },
    })
    const entries = useHotReloadHistoryStore.getState().entries
    expect(entries[0].kind).toBe("uninstall")
  })

  it("ignores events with missing plugin_id", async () => {
    render(<Harness />)
    await flushMicrotasks()
    listeners["cli-bridge:plugin-installed"]!.callback({
      payload: { plugin_id: "" },
    })
    expect(useHotReloadHistoryStore.getState().entries).toHaveLength(0)
    expect(mockScan).not.toHaveBeenCalled()
  })

  it("noops outside Tauri (web / Capacitor)", async () => {
    mockIsTauri.mockReturnValue(false)
    render(<Harness />)
    await flushMicrotasks()
    expect(mockListen).not.toHaveBeenCalled()
  })

  it("unsubscribes on unmount", async () => {
    const { unmount } = render(<Harness />)
    await flushMicrotasks()
    const installUnlisten = listeners["cli-bridge:plugin-installed"]!.unlisten
    const uninstallUnlisten = listeners["cli-bridge:plugin-uninstalled"]!.unlisten
    const reloadUnlisten = listeners["plugin-hot-reload"]!.unlisten
    unmount()
    expect(installUnlisten).toHaveBeenCalled()
    expect(uninstallUnlisten).toHaveBeenCalled()
    expect(reloadUnlisten).toHaveBeenCalled()
  })
})
