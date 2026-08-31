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
import { usePluginDevSessionStore } from "@/stores/plugins/plugin-dev-session-store"

const mockListen = listen as jest.MockedFunction<typeof listen>
const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

// One mock unlisten per call so we can verify cleanup wires the right
// number of unlisteners.
function makeUnlisten() {
  return jest.fn() as jest.Mock
}

type EventName =
  "cli-bridge:plugin-installed" | "cli-bridge:plugin-uninstalled" | "cli-bridge:plugin-dev-session"

type Callback = (event: { payload: Record<string, unknown> }) => void

interface ListenerRecord {
  unlisten: jest.Mock
  callback: Callback
}

const listeners: Record<EventName, ListenerRecord | undefined> = {
  "cli-bridge:plugin-installed": undefined,
  "cli-bridge:plugin-uninstalled": undefined,
  "cli-bridge:plugin-dev-session": undefined,
}

function resetListeners() {
  listeners["cli-bridge:plugin-installed"] = undefined
  listeners["cli-bridge:plugin-uninstalled"] = undefined
  listeners["cli-bridge:plugin-dev-session"] = undefined
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
  usePluginDevSessionStore.getState().clear()
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
    expect(listeners["cli-bridge:plugin-dev-session"]).toBeDefined()
  })

  it("rescans install events and records them in the hot-reload history", async () => {
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
      status: "success",
      source: "cli",
    })
    await flushMicrotasks()
    expect(mockScan).toHaveBeenCalled()
  })

  it("never lets an install event claim a runtime success", async () => {
    // An install event proves a bundle landed on disk. Only the verified
    // `plugin_dev_reload` round-trip may write a `hot-reload` row, so a
    // regression that relabels this entry would make the panel lie about
    // whether the plugin actually activated.
    render(<Harness />)
    await flushMicrotasks()
    listeners["cli-bridge:plugin-installed"]!.callback({
      payload: { plugin_id: "demo-plugin" },
    })
    const entries = useHotReloadHistoryStore.getState().entries
    expect(entries.some((entry) => entry.kind === "hot-reload")).toBe(false)
  })

  it("credits the in-app Load unpacked flow rather than the CLI", async () => {
    render(<Harness />)
    await flushMicrotasks()
    listeners["cli-bridge:plugin-installed"]!.callback({
      payload: { plugin_id: "demo-plugin", source: "load-unpacked" },
    })
    expect(useHotReloadHistoryStore.getState().entries[0].source).toBe("app")
  })

  it("records CLI build events in the canonical dev session store", async () => {
    render(<Harness />)
    await flushMicrotasks()
    listeners["cli-bridge:plugin-dev-session"]!.callback({
      payload: {
        schemaVersion: 1,
        sessionId: "session-a",
        attempt: 1,
        event: "build_started",
        occurredAt: "2026-08-29T10:00:00Z",
      },
    })
    expect(usePluginDevSessionStore.getState().sessions[0].attempts[0].state).toBe("building")
  })

  it("rescans uninstall events and records them as uninstalls", async () => {
    render(<Harness />)
    await flushMicrotasks()
    listeners["cli-bridge:plugin-uninstalled"]!.callback({
      payload: { plugin_id: "demo-plugin" },
    })
    const entries = useHotReloadHistoryStore.getState().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ pluginId: "demo-plugin", kind: "uninstall" })
    expect(entries[0].kind).not.toBe("hot-reload")
    await flushMicrotasks()
    expect(mockScan).toHaveBeenCalled()
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
    const sessionUnlisten = listeners["cli-bridge:plugin-dev-session"]!.unlisten
    unmount()
    expect(installUnlisten).toHaveBeenCalled()
    expect(uninstallUnlisten).toHaveBeenCalled()
    expect(sessionUnlisten).toHaveBeenCalled()
  })
})
