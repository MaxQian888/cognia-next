/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

type SweepDeps = { readSettings: () => unknown }
const refreshMock = jest.fn<Promise<unknown[]>, [SweepDeps]>(async () => [])
jest.mock("@/lib/ai/providers/oauth-credential-refresh", () => ({
  refreshExpiringOAuthCredentials: (deps: SweepDeps) => refreshMock(deps),
}))

const updateProviderSettings = jest.fn()
const storeState = {
  settings: { providerSettings: { acme: { providerId: "acme" } } },
  updateProviderSettings,
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => storeState },
}))

import {
  PROVIDER_OAUTH_FIRST_SWEEP_MS,
  PROVIDER_OAUTH_SWEEP_MS,
  ProviderOAuthRefreshInitializer,
} from "./provider-oauth-refresh-initializer"

beforeEach(() => {
  jest.useFakeTimers()
  refreshMock.mockClear()
})

afterEach(() => {
  jest.useRealTimers()
})

describe("ProviderOAuthRefreshInitializer", () => {
  it("does not sweep during boot itself", async () => {
    // The proxy-fetch adapter every renewal rides on is installed by a sibling
    // initializer in the same commit.
    render(<ProviderOAuthRefreshInitializer />)
    await jest.advanceTimersByTimeAsync(0)
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it("sweeps shortly after boot, then on the interval", async () => {
    render(<ProviderOAuthRefreshInitializer />)
    await jest.advanceTimersByTimeAsync(PROVIDER_OAUTH_FIRST_SWEEP_MS)
    expect(refreshMock).toHaveBeenCalledTimes(1)

    // The cadence is jittered upward, so one full interval guarantees at most
    // one more sweep and at least none before the interval elapses.
    await jest.advanceTimersByTimeAsync(PROVIDER_OAUTH_SWEEP_MS * 2)
    expect(refreshMock.mock.calls.length).toBeGreaterThan(1)
  })

  it("reads the live settings each sweep rather than a boot-time snapshot", async () => {
    render(<ProviderOAuthRefreshInitializer />)
    await jest.advanceTimersByTimeAsync(PROVIDER_OAUTH_FIRST_SWEEP_MS)
    const deps = refreshMock.mock.calls[0]?.[0]
    expect(deps?.readSettings()).toEqual({ acme: { providerId: "acme" } })
  })

  it("keeps sweeping after a failed sweep", async () => {
    refreshMock.mockRejectedValueOnce(new Error("boom"))
    render(<ProviderOAuthRefreshInitializer />)
    await jest.advanceTimersByTimeAsync(PROVIDER_OAUTH_FIRST_SWEEP_MS)
    expect(refreshMock).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(PROVIDER_OAUTH_SWEEP_MS * 2)
    expect(refreshMock.mock.calls.length).toBeGreaterThan(1)
  })

  it("stops on unmount", async () => {
    const { unmount } = render(<ProviderOAuthRefreshInitializer />)
    unmount()
    await jest.advanceTimersByTimeAsync(PROVIDER_OAUTH_SWEEP_MS * 5)
    expect(refreshMock).not.toHaveBeenCalled()
  })
})
