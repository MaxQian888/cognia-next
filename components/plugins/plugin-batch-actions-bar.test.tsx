/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
}))

const togglePluginEnabledMock = jest.fn(async (_id: string, _enabled: boolean) => ({ ok: true }))
const mockRows: PluginRow[] = [
  {
    id: "a",
    name: "A",
    version: "1.0.0",
    status: "enabled",
    source: "builtin",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: "/",
    manifest: { id: "a" },
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "b",
    name: "B",
    version: "1.0.0",
    status: "enabled",
    source: "builtin",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: "/",
    manifest: { id: "b" },
    createdAt: 1,
    updatedAt: 1,
  },
]

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(() => Promise.resolve(mockRows)),
}))

jest.mock("@/lib/plugin/core/toggle-plugin-enabled", () => ({
  togglePluginEnabled: (id: string, enabled: boolean) => togglePluginEnabledMock(id, enabled),
}))

const toastMock = jest.fn()
jest.mock("sonner", () => ({ toast: (...args: unknown[]) => toastMock(...args) }))

const checkForUpdatesMock = jest.fn(async (_ids?: string[]) => [
  { pluginId: "a", latestVersion: "2.0.0" },
])
const installUpdateMock = jest.fn(async (_id: string, _v: string) => undefined)
jest.mock("@/lib/plugin/lifecycle/updater", () => ({
  getPluginUpdater: () => ({
    checkForUpdates: (ids?: string[]) => checkForUpdatesMock(ids),
    installUpdate: (id: string, v: string) => installUpdateMock(id, v),
  }),
}))

import { PluginBatchActionsBar } from "./plugin-batch-actions-bar"
import { usePluginsStore } from "@/stores/plugins"

beforeEach(() => {
  togglePluginEnabledMock.mockClear()
  toastMock.mockClear()
  checkForUpdatesMock.mockClear()
  installUpdateMock.mockClear()
  // Reset the update flag mutated by the batch-update tests.
  mockRows[0].manifest = { id: "a" }
  usePluginsStore.setState({
    selection: new Set(["a", "b"]),
    deleteTarget: null,
    deleteQueue: [],
  })
})

describe("PluginBatchActionsBar", () => {
  it("returns null when selection is empty", () => {
    usePluginsStore.setState({ selection: new Set() })
    const { container } = render(<PluginBatchActionsBar />)
    expect(container.firstChild).toBeNull()
  })

  it("renders the selected count", () => {
    render(<PluginBatchActionsBar />)
    expect(screen.getByText(/selected:2/)).toBeInTheDocument()
  })

  it("disable-all toggles every selected row, one at a time", async () => {
    render(<PluginBatchActionsBar />)
    fireEvent.click(screen.getByText("disableAll"))

    // Sequential by design: each toggle now runs a real activation, and
    // `withLifecycleLock` serializes them anyway — so only the first has fired
    // synchronously and the rest need the microtask queue to drain.
    expect(togglePluginEnabledMock).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(togglePluginEnabledMock).toHaveBeenCalledTimes(2))
    expect(togglePluginEnabledMock).toHaveBeenCalledWith("a", false)
    expect(togglePluginEnabledMock).toHaveBeenCalledWith("b", false)
  })

  it("clear-selection button empties the selection", () => {
    render(<PluginBatchActionsBar />)
    fireEvent.click(screen.getByLabelText("clearSelection"))
    expect(usePluginsStore.getState().selection.size).toBe(0)
  })

  it("hides secondary labels behind hidden sm:inline on narrow viewports", () => {
    render(<PluginBatchActionsBar />)
    const disableLabel = screen.getByText("disableAll")
    const uninstallLabel = screen.getByText("uninstall")
    for (const label of [disableLabel, uninstallLabel]) {
      expect(label.className).toContain("hidden")
      expect(label.className).toContain("sm:inline")
    }
  })

  it("does not render the legacy refresh button", () => {
    render(<PluginBatchActionsBar />)
    expect(screen.queryByText("refresh")).not.toBeInTheDocument()
  })

  it("Uninstall enqueues every selected plugin into the delete queue", () => {
    render(<PluginBatchActionsBar />)
    fireEvent.click(screen.getByLabelText("uninstall"))
    const state = usePluginsStore.getState()
    // Head of the queue lands in deleteTarget, the rest stays in deleteQueue.
    expect(state.deleteTarget).toEqual({ pluginId: "a", name: "A" })
    expect(state.deleteQueue).toEqual([{ pluginId: "b", name: "B" }])
  })

  it("hides the update button when no selected plugin has an update", () => {
    render(<PluginBatchActionsBar />)
    expect(screen.queryByLabelText(/updateAll/)).not.toBeInTheDocument()
  })

  it("shows the update button and applies updates to updatable selected plugins", async () => {
    mockRows[0].manifest = { id: "a", updateAvailable: true }
    render(<PluginBatchActionsBar />)
    const btn = screen.getByLabelText("updateAll:1")
    fireEvent.click(btn)
    await waitFor(() => expect(installUpdateMock).toHaveBeenCalledWith("a", "2.0.0"))
    expect(checkForUpdatesMock).toHaveBeenCalledWith(["a"])
    expect(toastMock).toHaveBeenCalled()
  })

  it("Clear-selection drops any pending delete queue", () => {
    usePluginsStore.setState({
      selection: new Set(["a"]),
      deleteQueue: [{ pluginId: "b", name: "B" }],
    })
    render(<PluginBatchActionsBar />)
    fireEvent.click(screen.getByLabelText("clearSelection"))
    expect(usePluginsStore.getState().deleteQueue).toEqual([])
    expect(usePluginsStore.getState().selection.size).toBe(0)
  })
})
