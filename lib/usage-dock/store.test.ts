/** @jest-environment jsdom */
// The store fails closed: a missing or corrupt preference blob leaves the dock
// off rather than opening an overlay window the user never asked for.

const getPrefMock = jest.fn()
const setPrefMock = jest.fn(async () => {})

jest.mock("@/lib/tauri/store", () => ({
  getPref: (...a: unknown[]) => getPrefMock(...a),
  setPref: (...a: unknown[]) => setPrefMock(...a),
}))

import { __resetUsageDockStoreForTesting, USAGE_DOCK_PREF, useUsageDockStore } from "./store"
import { DEFAULT_USAGE_DOCK_PREFERENCES } from "./types"

beforeEach(() => {
  __resetUsageDockStoreForTesting()
  getPrefMock.mockReset().mockResolvedValue(null)
  setPrefMock.mockClear()
})

describe("useUsageDockStore", () => {
  it("starts on the shipped defaults, which are off", () => {
    expect(useUsageDockStore.getState().preferences).toEqual(DEFAULT_USAGE_DOCK_PREFERENCES)
    expect(useUsageDockStore.getState().hydrated).toBe(false)
  })

  it("hydrates a stored blob through the merge", async () => {
    getPrefMock.mockResolvedValue({ enabled: true, edge: "left" })
    await useUsageDockStore.getState().hydrate()
    expect(useUsageDockStore.getState().preferences).toMatchObject({
      enabled: true,
      edge: "left",
    })
    expect(useUsageDockStore.getState().hydrated).toBe(true)
  })

  it("stays off when the stored blob is corrupt", async () => {
    getPrefMock.mockResolvedValue("not-an-object")
    await useUsageDockStore.getState().hydrate()
    expect(useUsageDockStore.getState().preferences.enabled).toBe(false)
  })

  it("marks itself hydrated even when the read throws", async () => {
    // Otherwise the initializer waits forever and the dock never restores.
    getPrefMock.mockRejectedValue(new Error("store locked"))
    await useUsageDockStore.getState().hydrate()
    expect(useUsageDockStore.getState().hydrated).toBe(true)
    expect(useUsageDockStore.getState().preferences.enabled).toBe(false)
  })

  it("persists a patch under the versioned key", () => {
    useUsageDockStore.getState().setPreferences({ enabled: true })
    expect(setPrefMock).toHaveBeenCalledWith(
      USAGE_DOCK_PREF,
      expect.objectContaining({ enabled: true })
    )
  })

  it("sanitizes a patch on the way in", () => {
    useUsageDockStore.getState().setPreferences({ scale: 99, edge: "diagonal" as never })
    expect(useUsageDockStore.getState().preferences.scale).toBeLessThanOrEqual(1.2)
    expect(useUsageDockStore.getState().preferences.edge).toBe("right")
  })

  it("survives a failed write rather than losing the in-memory change", () => {
    setPrefMock.mockRejectedValueOnce(new Error("disk full"))
    useUsageDockStore.getState().setPreferences({ enabled: true })
    expect(useUsageDockStore.getState().preferences.enabled).toBe(true)
  })

  it("resets to the defaults and persists that", () => {
    useUsageDockStore.getState().setPreferences({ enabled: true, edge: "top" })
    useUsageDockStore.getState().reset()
    expect(useUsageDockStore.getState().preferences).toEqual(DEFAULT_USAGE_DOCK_PREFERENCES)
    expect(setPrefMock).toHaveBeenLastCalledWith(USAGE_DOCK_PREF, DEFAULT_USAGE_DOCK_PREFERENCES)
  })
})
