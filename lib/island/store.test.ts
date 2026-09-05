/** @jest-environment jsdom */
const getPrefMock = jest.fn()
const setPrefMock = jest.fn()

jest.mock("@/lib/tauri/store", () => ({
  getPref: (...a: unknown[]) => getPrefMock(...a),
  setPref: (...a: unknown[]) => setPrefMock(...a),
}))

import { ISLAND_PREF, useIslandStore, __resetIslandStoreForTesting } from "./store"
import { DEFAULT_ISLAND_PREFERENCES } from "./types"

beforeEach(() => {
  getPrefMock.mockReset().mockResolvedValue(undefined)
  setPrefMock.mockReset().mockResolvedValue(undefined)
  __resetIslandStoreForTesting()
})

it("starts on the most private default before hydration", () => {
  expect(useIslandStore.getState().preferences).toEqual(DEFAULT_ISLAND_PREFERENCES)
  expect(useIslandStore.getState().hydrated).toBe(false)
})

it("migrates an unknown persisted value rather than trusting it", async () => {
  getPrefMock.mockResolvedValue({ detailVisibility: "always" })
  await useIslandStore.getState().hydrate()
  expect(useIslandStore.getState().preferences.detailVisibility).toBe("click-to-reveal")
  expect(useIslandStore.getState().hydrated).toBe(true)
})

it("fails closed when the store cannot be read", async () => {
  getPrefMock.mockRejectedValue(new Error("locked"))
  await useIslandStore.getState().hydrate()
  expect(useIslandStore.getState().preferences).toEqual(DEFAULT_ISLAND_PREFERENCES)
  expect(useIslandStore.getState().hydrated).toBe(true)
})

it("persists an explicit opt-in", () => {
  useIslandStore.getState().setPreferences({ detailVisibility: "hover" })
  expect(useIslandStore.getState().preferences.detailVisibility).toBe("hover")
  expect(setPrefMock).toHaveBeenCalledWith(ISLAND_PREF, { detailVisibility: "hover" })
})

it("keeps the store usable when persisting fails", () => {
  setPrefMock.mockRejectedValue(new Error("disk full"))
  expect(() =>
    useIslandStore.getState().setPreferences({ detailVisibility: "summary-only" })
  ).not.toThrow()
  expect(useIslandStore.getState().preferences.detailVisibility).toBe("summary-only")
})
