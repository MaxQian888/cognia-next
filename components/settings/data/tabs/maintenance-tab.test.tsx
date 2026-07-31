/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
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

import { MaintenanceTab } from "./maintenance-tab"

beforeEach(() => {
  saveMock.mockClear()
  mockTrackEvent.mockClear()
  localStorage.clear()
  storeState = { settings: { storageRetention: { traceRetentionDays: 30 } }, save: saveMock }
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
