/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    jest.fn((selector: (state: { settings: object }) => unknown) => selector({ settings: {} })),
    { getState: jest.fn(() => ({ settings: {} })) }
  ),
}))
jest.mock("./aggregate", () => ({ queryAllConfiguredLimits: jest.fn() }))
jest.mock("./store", () => ({ recordLimitsSnapshot: jest.fn(async () => undefined) }))
jest.mock("./coalesce", () => ({ queryAccountLimitsCoalesced: jest.fn() }))
jest.mock("@cognia/logging", () => ({
  loggers: {
    store: { warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
    auth: { warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
  },
}))

import { loggers } from "@cognia/logging"
import {
  __resetSecretStoreReadinessForTesting,
  getSecretStoreFailureSources,
  getSecretStoreReadiness,
} from "@/lib/credentials/secret-store-readiness"

import { queryAllConfiguredLimits } from "./aggregate"
import { recordLimitsSnapshot } from "./store"
import { useAllConfiguredLimits } from "./hooks"

const queryAll = queryAllConfiguredLimits as jest.Mock
const record = recordLimitsSnapshot as jest.Mock
const storeWarn = loggers.store.warn as jest.Mock
const authWarn = loggers.auth.warn as jest.Mock

describe("useAllConfiguredLimits().refresh", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetSecretStoreReadinessForTesting()
  })

  it("never rejects when the secret store is locked, and reports it once centrally", async () => {
    queryAll.mockRejectedValue("SECRET_STORE_LOCKED: master key read: passphrase not correct")
    const { result } = renderHook(() => useAllConfiguredLimits())
    await act(async () => {
      await expect(result.current.refresh()).resolves.toBeUndefined()
      await expect(result.current.refresh()).resolves.toBeUndefined()
    })
    expect(getSecretStoreReadiness()).toBe("locked")
    expect(getSecretStoreFailureSources()).toEqual(["subscription.limits"])
    expect(authWarn).toHaveBeenCalledTimes(1)
    expect(storeWarn).not.toHaveBeenCalled()
    expect(result.current.refreshing).toBe(false)
  })

  it("logs any other failure instead of leaking an unhandled rejection", async () => {
    queryAll.mockRejectedValue(new Error("usage endpoint down"))
    const { result } = renderHook(() => useAllConfiguredLimits())
    await act(async () => {
      await expect(result.current.refresh()).resolves.toBeUndefined()
    })
    expect(storeWarn).toHaveBeenCalledWith("Configured limits refresh failed", {
      error: "usage endpoint down",
    })
    expect(getSecretStoreReadiness()).toBe("uninitialized")
  })

  it("persists every snapshot on success", async () => {
    const snap = { provider: "anthropic", fetchedAt: 1, meters: [] }
    queryAll.mockResolvedValue([snap])
    const { result } = renderHook(() => useAllConfiguredLimits())
    await act(async () => {
      await result.current.refresh()
    })
    expect(record).toHaveBeenCalledWith(snap)
    expect(result.current.snapshots).toEqual([snap])
  })
})
