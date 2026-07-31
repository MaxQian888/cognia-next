const maybeAutoUploadSubscriptionMock = jest.fn().mockResolvedValue({ ran: false })
jest.mock("./subscription-sync", () => ({
  maybeAutoUploadSubscription: (...a: unknown[]) => maybeAutoUploadSubscriptionMock(...a),
}))

import {
  VAULT_CHANGE_DEBOUNCE_MS,
  __resetVaultChangeTrackerForTesting,
  getLastVaultChangeAtMs,
  markSubscriptionVaultChanged,
} from "./change-tracker"

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  __resetVaultChangeTrackerForTesting()
})

afterEach(() => {
  __resetVaultChangeTrackerForTesting()
  jest.useRealTimers()
})

// Drain the dynamic-import microtask chain after the timer fires.
async function flushAsync() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe("markSubscriptionVaultChanged", () => {
  it("records the change timestamp", () => {
    expect(getLastVaultChangeAtMs()).toBeNull()
    markSubscriptionVaultChanged(1234)
    expect(getLastVaultChangeAtMs()).toBe(1234)
  })

  it("fires the debounced auto-upload once after the window", async () => {
    markSubscriptionVaultChanged()
    expect(maybeAutoUploadSubscriptionMock).not.toHaveBeenCalled()
    jest.advanceTimersByTime(VAULT_CHANGE_DEBOUNCE_MS)
    await flushAsync()
    expect(maybeAutoUploadSubscriptionMock).toHaveBeenCalledTimes(1)
  })

  it("coalesces rapid mutations into one upload", async () => {
    markSubscriptionVaultChanged()
    jest.advanceTimersByTime(VAULT_CHANGE_DEBOUNCE_MS / 2)
    markSubscriptionVaultChanged()
    jest.advanceTimersByTime(VAULT_CHANGE_DEBOUNCE_MS / 2)
    await flushAsync()
    expect(maybeAutoUploadSubscriptionMock).not.toHaveBeenCalled()
    jest.advanceTimersByTime(VAULT_CHANGE_DEBOUNCE_MS / 2)
    await flushAsync()
    expect(maybeAutoUploadSubscriptionMock).toHaveBeenCalledTimes(1)
  })

  it("reset cancels a pending upload", async () => {
    markSubscriptionVaultChanged()
    __resetVaultChangeTrackerForTesting()
    jest.advanceTimersByTime(VAULT_CHANGE_DEBOUNCE_MS * 2)
    await flushAsync()
    expect(maybeAutoUploadSubscriptionMock).not.toHaveBeenCalled()
    expect(getLastVaultChangeAtMs()).toBeNull()
  })
})
