/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const saveMock = jest.fn(async (..._a: unknown[]) => undefined)
let storeState: { settings: Record<string, unknown> | null; save: typeof saveMock }

// useSettingsStore is a selector hook — drive it from a mutable fake state.
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))
// Heavy siblings reduce to inert stubs so we can mount just the tab.
jest.mock("@/hooks/storage", () => ({
  useStorageBreakdown: () => ({ formatBytes: (n: number) => String(n), refresh: jest.fn() }),
}))
jest.mock("@/components/data/storage/storage-cleanup-dialog", () => ({
  StorageCleanupDialog: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</>,
}))
jest.mock("@/lib/data/clear", () => ({
  clearAll: jest.fn(),
  clearTables: jest.fn(),
}))
const mockTrackEvent = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))
const runWorkspaceMaintenanceMock = jest.fn()
const listWorkspaceMaintenanceEventsMock = jest.fn()
const getWorkspaceLifecyclePolicyMock = jest.fn()
const setWorkspaceLifecyclePolicyMock = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  runWorkspaceMaintenance: (...args: unknown[]) => runWorkspaceMaintenanceMock(...args),
  listWorkspaceMaintenanceEvents: (...args: unknown[]) =>
    listWorkspaceMaintenanceEventsMock(...args),
  getWorkspaceLifecyclePolicy: (...args: unknown[]) => getWorkspaceLifecyclePolicyMock(...args),
  setWorkspaceLifecyclePolicy: (...args: unknown[]) => setWorkspaceLifecyclePolicyMock(...args),
}))
// The policy write is `approval: "interactive"`, so it rides the lease wrapper.
const runWorkspaceUserActionMock = jest.fn((_command: string, operation: () => Promise<unknown>) =>
  operation()
)
jest.mock("@/lib/task-workspace/user-action", () => ({
  runWorkspaceUserAction: (...args: unknown[]) =>
    (runWorkspaceUserActionMock as unknown as (...a: unknown[]) => unknown)(...args),
}))

import { MaintenanceTab } from "./maintenance-tab"

beforeEach(() => {
  saveMock.mockClear()
  mockTrackEvent.mockClear()
  runWorkspaceMaintenanceMock.mockReset().mockResolvedValue({ events: [] })
  listWorkspaceMaintenanceEventsMock.mockReset().mockResolvedValue([])
  getWorkspaceLifecyclePolicyMock.mockReset().mockResolvedValue({
    activeDirectoryCap: 25,
    snapshotRetentionDays: 14,
    blobBudgetBytes: 2_000_000_000,
  })
  setWorkspaceLifecyclePolicyMock.mockReset().mockImplementation(async (policy) => policy)
  runWorkspaceUserActionMock.mockClear()
  runWorkspaceUserActionMock.mockImplementation((_command, operation) => operation())
  localStorage.clear()
  storeState = { settings: { storageRetention: { traceRetentionDays: 30 } }, save: saveMock }
})

describe("<MaintenanceTab /> managed workspace block", () => {
  it("runs host-owned maintenance and refreshes durable history", async () => {
    listWorkspaceMaintenanceEventsMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        eventId: "event-1",
        kind: "reconciled",
        workspaceId: null,
        occurredAt: 1,
        detail: "registry checked",
      },
    ])
    const user = userEvent.setup()
    render(<MaintenanceTab />)

    await waitFor(() => expect(listWorkspaceMaintenanceEventsMock).toHaveBeenCalledWith(20))
    const block = screen.getByTestId("workspace-maintenance")
    await user.click(within(block).getByRole("button"))

    await waitFor(() => expect(runWorkspaceMaintenanceMock).toHaveBeenCalledTimes(1))
    expect(listWorkspaceMaintenanceEventsMock).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(block).toHaveAttribute("data-last-event-detail", "registry checked"))
  })
})

describe("<MaintenanceTab /> privacy block", () => {
  it("updates the real behavior-telemetry consent while preserving the legacy setting alias", async () => {
    const user = userEvent.setup()
    render(<MaintenanceTab />)

    await user.click(screen.getByRole("switch"))

    expect(saveMock).toHaveBeenCalledWith({
      telemetryEnabled: true,
      behaviorTelemetry: expect.objectContaining({ enabled: true }),
    })
    expect(
      JSON.parse(localStorage.getItem("cognia-behavior-telemetry-enabled") ?? "{}")
    ).toMatchObject({ enabled: true })
    expect(mockTrackEvent).toHaveBeenCalledWith("telemetry.preference.changed", { enabled: true })
  })

  it("records opt-out before disabling consent", async () => {
    localStorage.setItem("cognia-behavior-telemetry-enabled", "true")
    storeState.settings = {
      storageRetention: { traceRetentionDays: 30 },
      telemetryEnabled: true,
      behaviorTelemetry: { enabled: true },
    }
    const user = userEvent.setup()
    render(<MaintenanceTab />)

    await user.click(screen.getByRole("switch"))

    expect(mockTrackEvent).toHaveBeenCalledWith("telemetry.preference.changed", { enabled: false })
    expect(
      JSON.parse(localStorage.getItem("cognia-behavior-telemetry-enabled") ?? "{}")
    ).toMatchObject({ enabled: false })
  })
})

describe("<MaintenanceTab /> retention block", () => {
  it("renders the current trace-retention window", async () => {
    render(<MaintenanceTab />)
    const input = (await screen.findByLabelText(/Trace retention/i)) as HTMLInputElement
    expect(input.value).toBe("30")
  })

  it("commits a clamped, floored retention value on blur", async () => {
    const user = userEvent.setup()
    render(<MaintenanceTab />)
    const input = await screen.findByLabelText(/Trace retention/i)
    await user.clear(input)
    await user.type(input, "14.9")
    await user.tab()
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({ storageRetention: { traceRetentionDays: 14 } })
    )
  })

  it("clamps a negative value to 0 (keep forever)", async () => {
    const user = userEvent.setup()
    render(<MaintenanceTab />)
    const input = await screen.findByLabelText(/Trace retention/i)
    await user.clear(input)
    await user.type(input, "-5")
    await user.tab()
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({ storageRetention: { traceRetentionDays: 0 } })
    )
  })

  it("treats an empty entry as 0 (keep forever)", async () => {
    const user = userEvent.setup()
    render(<MaintenanceTab />)
    const input = await screen.findByLabelText(/Trace retention/i)
    await user.clear(input)
    await user.tab()
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({ storageRetention: { traceRetentionDays: 0 } })
    )
  })
})

describe("<MaintenanceTab /> worktree lifecycle policy", () => {
  it("shows the rules the maintenance run enforces", async () => {
    // The policy commands existed, were companion-reachable, and had exactly
    // one caller in the repo: their own unit test. "Run maintenance" was on
    // screen while the three numbers deciding what it reclaims were not.
    render(<MaintenanceTab />)

    expect(await screen.findByTestId("workspace-lifecycle-policy")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-lifecycle-activeDirectoryCap")).toHaveValue(25)
    expect(screen.getByTestId("workspace-lifecycle-snapshotRetentionDays")).toHaveValue(14)
    expect(screen.getByTestId("workspace-lifecycle-blobBudgetBytes")).toHaveValue(2_000_000_000)
  })

  it("saves an edited policy through the approval wrapper", async () => {
    render(<MaintenanceTab />)
    await screen.findByTestId("workspace-lifecycle-policy")

    fireEvent.change(screen.getByTestId("workspace-lifecycle-activeDirectoryCap"), {
      target: { value: "40" },
    })
    fireEvent.click(screen.getByTestId("workspace-lifecycle-save"))

    await waitFor(() => expect(setWorkspaceLifecyclePolicyMock).toHaveBeenCalled())
    expect(setWorkspaceLifecyclePolicyMock).toHaveBeenCalledWith({
      activeDirectoryCap: 40,
      snapshotRetentionDays: 14,
      blobBudgetBytes: 2_000_000_000,
    })
    expect(runWorkspaceUserActionMock).toHaveBeenCalledWith(
      "task_workspace_policy_set",
      expect.any(Function)
    )
  })

  it("refuses a zero client-side, because the host does", async () => {
    // `service.rs::set_workspace_lifecycle_policy` rejects a zero on all three
    // fields. Catching it here is the difference between a disabled Save and a
    // raw Rust error string.
    render(<MaintenanceTab />)
    await screen.findByTestId("workspace-lifecycle-policy")

    fireEvent.change(screen.getByTestId("workspace-lifecycle-snapshotRetentionDays"), {
      target: { value: "0" },
    })

    expect(screen.getByTestId("workspace-lifecycle-save")).toBeDisabled()
    fireEvent.click(screen.getByTestId("workspace-lifecycle-save"))
    expect(setWorkspaceLifecyclePolicyMock).not.toHaveBeenCalled()
  })

  it("keeps Save inert until something actually changed", async () => {
    render(<MaintenanceTab />)
    await screen.findByTestId("workspace-lifecycle-policy")

    expect(screen.getByTestId("workspace-lifecycle-save")).toBeDisabled()
  })

  it("renders nothing when the host cannot answer for a policy", async () => {
    getWorkspaceLifecyclePolicyMock.mockRejectedValue(new Error("unsupported"))
    render(<MaintenanceTab />)

    await waitFor(() => expect(getWorkspaceLifecyclePolicyMock).toHaveBeenCalled())
    expect(screen.queryByTestId("workspace-lifecycle-policy")).not.toBeInTheDocument()
  })
})
