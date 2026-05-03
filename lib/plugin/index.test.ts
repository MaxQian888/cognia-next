import { getPluginEventHooks, getPluginLifecycleHooks, validatePluginManifest } from "./index"
import * as core from "./core/validation"
import * as hooksSystem from "./messaging/hooks-system"

describe("lib/plugin barrel re-exports", () => {
  it("validatePluginManifest is the canonical core validator", () => {
    expect(validatePluginManifest).toBe(core.validatePluginManifest)
  })

  it("getPluginEventHooks / getPluginLifecycleHooks are the canonical hook factories", () => {
    expect(getPluginEventHooks).toBe(hooksSystem.getPluginEventHooks)
    expect(getPluginLifecycleHooks).toBe(hooksSystem.getPluginLifecycleHooks)
  })

  it("getPluginEventHooks() returns the real PluginEventHooks instance", () => {
    expect(getPluginEventHooks()).toBeInstanceOf(hooksSystem.PluginEventHooks)
  })

  it("getPluginLifecycleHooks() returns the real PluginLifecycleHooks instance", () => {
    expect(getPluginLifecycleHooks()).toBeInstanceOf(hooksSystem.PluginLifecycleHooks)
  })

  it("validatePluginManifest accepts governance options", () => {
    const result = validatePluginManifest(
      { id: "test.plugin", name: "Test", version: "1.0.0", type: "frontend" },
      { governanceMode: "warn" }
    )
    expect(result).toEqual(expect.objectContaining({ valid: expect.any(Boolean) }))
  })
})
