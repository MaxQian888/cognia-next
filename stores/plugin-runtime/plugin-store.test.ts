/**
 * @jest-environment jsdom
 */

const applyPolicyMock = jest.fn()
jest.mock("@/lib/plugin/core/policy-runtime", () => ({
  applyPluginPolicyToRuntime: (...args: unknown[]) => applyPolicyMock(...args),
}))

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

  it("initialize() hydrates the persisted policy into the runtime", async () => {
    applyPolicyMock.mockClear()
    window.localStorage.setItem(
      "cognia.plugins.policy",
      JSON.stringify({ governance: "block", signatureRequired: true, autoUpdate: true })
    )

    await usePluginStore.getState().initialize("/tmp/plugins")

    expect(applyPolicyMock).toHaveBeenCalledWith({
      governance: "block",
      signatureRequired: true,
      autoUpdate: true,
    })

    window.localStorage.clear()
  })

  it("initialize() defaults policy flags when localStorage has no blob", async () => {
    applyPolicyMock.mockClear()
    window.localStorage.clear()

    await usePluginStore.getState().initialize("/tmp/plugins")

    // ADR 0016 P0-3: signatureRequired is default-on; autoUpdate stays off.
    expect(applyPolicyMock).toHaveBeenCalledWith({
      governance: "warn",
      signatureRequired: true,
      autoUpdate: false,
    })
  })
})
