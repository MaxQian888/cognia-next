/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    if (vars) return `${key}:${JSON.stringify(vars)}`
    return key
  },
}))

const mockProfile = jest.fn(() => "tauri")
jest.mock("@/hooks/plugins/use-plugin-runtime-profile", () => ({
  usePluginRuntimeProfile: () => mockProfile(),
}))

const setPluginEnabledForHostMock = jest.fn(
  async (
    _id: string,
    _enabled: boolean
  ): Promise<{ ok: boolean; queued: boolean; error?: string }> => ({ ok: true, queued: false })
)
const mockRows: PluginRow[] = [
  {
    id: "a",
    name: "A",
    version: "1.0.0",
    status: "enabled",
    source: "marketplace",
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
    source: "marketplace",
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

jest.mock("@/lib/plugin/core/set-plugin-enabled-for-host", () => ({
  setPluginEnabledForHost: (id: string, enabled: boolean) =>
    setPluginEnabledForHostMock(id, enabled),
  isMirroredPluginClient: () => false,
}))

const toastMock = jest.fn()
const toastSuccess = jest.fn()
const toastError = jest.fn()
const toastMessage = jest.fn()
jest.mock("sonner", () => ({
  toast: Object.assign((...args: unknown[]) => toastMock(...args), {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    message: (...args: unknown[]) => toastMessage(...args),
  }),
}))

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
import { COMPACT_ABOVE_TAB_BAR_BOTTOM } from "@/lib/shell/compact-shell"

beforeEach(() => {
  setPluginEnabledForHostMock.mockClear()
  setPluginEnabledForHostMock.mockImplementation(async () => ({ ok: true, queued: false }))
  mockProfile.mockReturnValue("tauri")
  toastMock.mockClear()
  toastSuccess.mockClear()
  toastError.mockClear()
  toastMessage.mockClear()
  mockRows[0].source = "marketplace"
  mockRows[0].enabled = true
  mockRows[1].enabled = true
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
    expect(setPluginEnabledForHostMock).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(setPluginEnabledForHostMock).toHaveBeenCalledTimes(2))
    expect(setPluginEnabledForHostMock).toHaveBeenCalledWith("a", false)
    expect(setPluginEnabledForHostMock).toHaveBeenCalledWith("b", false)
  })

  it("reports one summary toast once the whole batch settles", async () => {
    render(<PluginBatchActionsBar />)
    fireEvent.click(screen.getByText("disableAll"))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
    expect(toastSuccess.mock.calls[0][0]).toBe(
      'toggleResult:{"applied":2,"queued":0,"failed":0,"skipped":0}'
    )
  })

  it("aggregates failures by name instead of dropping them", async () => {
    setPluginEnabledForHostMock.mockImplementation(async (id: string) =>
      id === "b" ? { ok: false, queued: false, error: "boom" } : { ok: true, queued: false }
    )
    render(<PluginBatchActionsBar />)
    fireEvent.click(screen.getByText("disableAll"))
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastError.mock.calls[0][0]).toBe(
      'toggleResult:{"applied":1,"queued":0,"failed":1,"skipped":0}'
    )
    expect(toastError.mock.calls[0][1].description).toBe('toggleFailedNames:{"names":"B"}')
  })

  it("disables the bar while the batch runs", async () => {
    let release!: () => void
    setPluginEnabledForHostMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, queued: false })
        })
    )
    render(<PluginBatchActionsBar />)
    fireEvent.click(screen.getByTestId("plugin-batch-toggle"))
    await waitFor(() => expect(screen.getByTestId("plugin-batch-toggle")).toBeDisabled())
    expect(screen.getByLabelText("uninstall")).toBeDisabled()
    expect(screen.getByLabelText("clearSelection")).toBeDisabled()
    expect(screen.getByRole("region", { name: "ariaLabel" })).toHaveAttribute("aria-busy", "true")
    release()
    await waitFor(() => expect(setPluginEnabledForHostMock).toHaveBeenCalledTimes(2))
    release()
    await waitFor(() => expect(screen.getByTestId("plugin-batch-toggle")).not.toBeDisabled())
  })

  it("skips plugins this host cannot run when enabling, and says so", async () => {
    mockProfile.mockReturnValue("browser")
    mockRows[0].enabled = false
    mockRows[1].enabled = false
    render(<PluginBatchActionsBar />)
    fireEvent.click(screen.getByText("enableAll"))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
    expect(setPluginEnabledForHostMock).not.toHaveBeenCalled()
    expect(toastSuccess.mock.calls[0][0]).toBe(
      'toggleResult:{"applied":0,"queued":0,"failed":0,"skipped":2}'
    )
  })

  it("leaves built-ins out of a batch uninstall", () => {
    mockRows[0].source = "builtin"
    render(<PluginBatchActionsBar />)
    fireEvent.click(screen.getByLabelText("uninstall"))
    const state = usePluginsStore.getState()
    expect(state.deleteTarget).toEqual({ pluginId: "b", name: "B" })
    expect(state.deleteQueue).toEqual([])
    expect(toastMessage).toHaveBeenCalledWith("uninstallSkipped:1")
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

  /**
   * The bar is `fixed`, and the two shells that mount it disagree about what
   * is at the bottom of the viewport: `PluginPanel` has nothing there,
   * `PluginsMobileBody` has `MobileTabBar`. The offset is therefore the
   * caller's to state, and the merge has to actually REPLACE the default —
   * two `bottom-*` utilities both present would be decided by stylesheet
   * order, not by the caller.
   */
  describe("bottom offset", () => {
    const bar = () => screen.getByRole("region", { name: "ariaLabel" })

    it("clears only the safe area by default, for the shell with no tab bar", () => {
      render(<PluginBatchActionsBar />)
      expect(bar().className).toContain("bottom-[max(1rem,env(safe-area-inset-bottom))]")
    })

    it("takes the caller's lift instead of the default, not alongside it", () => {
      render(<PluginBatchActionsBar className={COMPACT_ABOVE_TAB_BAR_BOTTOM} />)
      expect(bar().className).toContain(COMPACT_ABOVE_TAB_BAR_BOTTOM)
      expect(bar().className).not.toContain("bottom-[max(1rem,env(safe-area-inset-bottom))]")
    })

    it("keeps the rest of the floating-bar geometry when a class is passed", () => {
      render(<PluginBatchActionsBar className={COMPACT_ABOVE_TAB_BAR_BOTTOM} />)
      for (const cls of ["fixed", "left-1/2", "-translate-x-1/2", "z-30"]) {
        expect(bar().className).toContain(cls)
      }
    })
  })
})
