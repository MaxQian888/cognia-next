/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"

const startMock = jest.fn((..._args: unknown[]) => undefined)
const stopMock = jest.fn()
const isTauriMock = jest.fn(() => true)
const getActiveAccountMock = jest.fn(async (..._args: unknown[]) => ({
  activeAccountId: "acc-1" as string | undefined,
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))
jest.mock("@/lib/subscription/codex/scheduler", () => ({
  startCodexUsageScheduler: (...args: unknown[]) => {
    startMock(...args)
    return { stop: stopMock, triggerNow: jest.fn() }
  },
}))
jest.mock("@/lib/subscription/core/transport", () => ({
  getActiveAccount: (...args: unknown[]) => getActiveAccountMock(...args),
}))
const mockStoreState = { settings: { codexSubscriptionSettings: { probeEnabled: true } } }
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: Object.assign(
    <T,>(selector: (s: typeof mockStoreState) => T) => selector(mockStoreState),
    { getState: () => mockStoreState }
  ),
}))

import { CodexUsageSchedulerInitializer } from "./codex-usage-scheduler-initializer"

beforeEach(() => {
  startMock.mockClear()
  stopMock.mockClear()
  isTauriMock.mockReturnValue(true)
  getActiveAccountMock.mockClear()
})

describe("CodexUsageSchedulerInitializer", () => {
  it("starts the scheduler on mount and stops it on unmount in Tauri", () => {
    const { unmount } = render(<CodexUsageSchedulerInitializer />)
    expect(startMock).toHaveBeenCalledTimes(1)
    unmount()
    expect(stopMock).toHaveBeenCalledTimes(1)
  })

  it("does not start the scheduler outside Tauri", () => {
    isTauriMock.mockReturnValue(false)
    render(<CodexUsageSchedulerInitializer />)
    expect(startMock).not.toHaveBeenCalled()
  })

  it("wires getActiveAccountId to the codex active account", async () => {
    render(<CodexUsageSchedulerInitializer />)
    const deps = startMock.mock.calls[0][1] as {
      getActiveAccountId: () => Promise<string | null>
    }
    await expect(deps.getActiveAccountId()).resolves.toBe("acc-1")
    expect(getActiveAccountMock).toHaveBeenCalledWith("codex")
  })

  it("getActiveAccountId resolves null when the vault call throws", async () => {
    getActiveAccountMock.mockRejectedValueOnce(new Error("no vault"))
    render(<CodexUsageSchedulerInitializer />)
    const deps = startMock.mock.calls[0][1] as {
      getActiveAccountId: () => Promise<string | null>
    }
    await expect(deps.getActiveAccountId()).resolves.toBeNull()
  })

  it("passes a settings getter that reflects the store", () => {
    render(<CodexUsageSchedulerInitializer />)
    const settingsGetter = startMock.mock.calls[0][0] as () => { probeEnabled: boolean }
    expect(settingsGetter().probeEnabled).toBe(true)
  })
})
