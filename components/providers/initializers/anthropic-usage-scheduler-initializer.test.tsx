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
const getAccountMock = jest.fn(
  async (..._args: unknown[]) =>
    ({
      id: "acc-1",
      credential: { provider: "anthropic", accessToken: "tok" },
    }) as unknown
)
const refreshMock = jest.fn(
  async (..._args: unknown[]) =>
    ({
      provider: "anthropic",
      accessToken: "fresh",
    }) as unknown
)

jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))
jest.mock("@/lib/subscription/anthropic/scheduler", () => ({
  startUsageScheduler: (...args: unknown[]) => {
    startMock(...args)
    return { stop: stopMock, triggerNow: jest.fn() }
  },
}))
jest.mock("@/lib/subscription/core/transport", () => ({
  getActiveAccount: (...args: unknown[]) => getActiveAccountMock(...args),
  getAccount: (...args: unknown[]) => getAccountMock(...args),
}))
jest.mock("@/lib/subscription/anthropic/refresh", () => ({
  refreshAndPersistAnthropicAccount: (...args: unknown[]) => refreshMock(...args),
}))

const mockStoreState: {
  settings: {
    subscriptionSettings: { probeEnabled: boolean }
    limitsQueryEnabledAccounts: string[]
  }
} = {
  settings: {
    subscriptionSettings: { probeEnabled: true },
    limitsQueryEnabledAccounts: ["anthropic:acc-1"],
  },
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: Object.assign(
    <T,>(selector: (s: typeof mockStoreState) => T) => selector(mockStoreState),
    { getState: () => mockStoreState }
  ),
}))

import { AnthropicUsageSchedulerInitializer } from "./anthropic-usage-scheduler-initializer"

type SchedulerDeps = {
  getCredential: () => Promise<unknown>
  refresh: (c: unknown) => Promise<unknown>
}

function mountAndGetDeps(): SchedulerDeps {
  render(<AnthropicUsageSchedulerInitializer />)
  return startMock.mock.calls[0][1] as SchedulerDeps
}

beforeEach(() => {
  startMock.mockClear()
  stopMock.mockClear()
  isTauriMock.mockReturnValue(true)
  getActiveAccountMock.mockClear()
  getAccountMock.mockClear()
  refreshMock.mockClear()
  mockStoreState.settings.limitsQueryEnabledAccounts = ["anthropic:acc-1"]
})

describe("AnthropicUsageSchedulerInitializer", () => {
  it("starts the scheduler on mount and stops it on unmount in Tauri", () => {
    const { unmount } = render(<AnthropicUsageSchedulerInitializer />)
    expect(startMock).toHaveBeenCalledTimes(1)
    unmount()
    expect(stopMock).toHaveBeenCalledTimes(1)
  })

  it("does not start the scheduler outside Tauri", () => {
    isTauriMock.mockReturnValue(false)
    render(<AnthropicUsageSchedulerInitializer />)
    expect(startMock).not.toHaveBeenCalled()
  })

  it("passes a settings getter reading subscriptionSettings from the store", () => {
    render(<AnthropicUsageSchedulerInitializer />)
    const settingsGetter = startMock.mock.calls[0][0] as () => { probeEnabled: boolean }
    // This is the assertion that would have caught the original bug: the
    // Probes panel writes `subscriptionSettings`, and nothing read it.
    expect(settingsGetter().probeEnabled).toBe(true)
  })

  it("resolves the active anthropic account's credential", async () => {
    const deps = mountAndGetDeps()
    await expect(deps.getCredential()).resolves.toMatchObject({ provider: "anthropic" })
    expect(getActiveAccountMock).toHaveBeenCalledWith("anthropic")
    expect(getAccountMock).toHaveBeenCalledWith("anthropic", "acc-1")
  })

  it("yields no credential until the account opts in to quota queries", async () => {
    mockStoreState.settings.limitsQueryEnabledAccounts = []
    const deps = mountAndGetDeps()
    await expect(deps.getCredential()).resolves.toBeNull()
    expect(getAccountMock).not.toHaveBeenCalled()
  })

  it("yields no credential when there is no active account", async () => {
    getActiveAccountMock.mockResolvedValueOnce({ activeAccountId: undefined })
    const deps = mountAndGetDeps()
    await expect(deps.getCredential()).resolves.toBeNull()
  })

  it("swallows a throwing vault call rather than killing the loop", async () => {
    getActiveAccountMock.mockRejectedValueOnce(new Error("no vault"))
    const deps = mountAndGetDeps()
    await expect(deps.getCredential()).resolves.toBeNull()
  })

  it("ignores an account whose credential belongs to another provider", async () => {
    getAccountMock.mockResolvedValueOnce({
      id: "acc-1",
      credential: { provider: "codex" },
    })
    const deps = mountAndGetDeps()
    await expect(deps.getCredential()).resolves.toBeNull()
  })

  it("refreshes without reactivating, so a background probe never restarts the sidecar", async () => {
    const deps = mountAndGetDeps()
    await expect(deps.refresh({})).resolves.toMatchObject({ accessToken: "fresh" })
    expect(refreshMock).toHaveBeenCalledWith("acc-1", { reactivate: false })
  })

  it("refresh resolves null when the refresh exchange throws", async () => {
    refreshMock.mockRejectedValueOnce(new Error("invalid_grant"))
    const deps = mountAndGetDeps()
    await expect(deps.refresh({})).resolves.toBeNull()
  })
})
