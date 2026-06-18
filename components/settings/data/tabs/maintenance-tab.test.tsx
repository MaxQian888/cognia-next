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

import { MaintenanceTab } from "./maintenance-tab"

beforeEach(() => {
  saveMock.mockClear()
  storeState = { settings: { storageRetention: { traceRetentionDays: 30 } }, save: saveMock }
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
