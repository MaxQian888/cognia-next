import { usePluginStore } from "./plugin-store"
import * as barrel from "./"

it("barrel re-exports usePluginStore", () => {
  expect(barrel.usePluginStore).toBe(usePluginStore)
})

describe("usePluginStore", () => {
  it("exposes getAllModes() returning an empty list (stub)", () => {
    const fn = usePluginStore.getState().getAllModes
    expect(typeof fn).toBe("function")
    expect(fn()).toEqual([])
  })

  it("returns the same empty array shape on repeated calls", () => {
    const first = usePluginStore.getState().getAllModes()
    const second = usePluginStore.getState().getAllModes()
    expect(first).toEqual([])
    expect(second).toEqual([])
  })
})
