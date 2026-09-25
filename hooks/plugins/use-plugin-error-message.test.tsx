/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

import { classifyPluginError, usePluginErrorMessage } from "./use-plugin-error-message"

describe("classifyPluginError", () => {
  it.each([
    ['Cannot stop plugin "a": required by "b", "c"', "dependencyInUse", { dependents: "b, c" }],
    [
      'Cannot enable plugin "a": unmet required dependencies — b (missing)',
      "dependencyMissing",
      { dependencies: "b (missing)" },
    ],
    [
      'Cannot load Python plugin "a": the Python runtime is disabled in this profile',
      "pythonDisabled",
      {},
    ],
    ['Plugin "a" is explicitly disabled', "intentDisabled", {}],
    [
      'Plugin "a" has unconfirmed runtime resources; recover it before activation',
      "dirtyRuntime",
      {},
    ],
    ["Plugin not found: a", "notFound", {}],
    ["Plugin manager not initialized. Call initializePluginManager first.", "managerNotReady", {}],
    ["Incompatible plugin: needs tauri", "incompatible", {}],
    ["Signature verification failed for plugin a", "signature", {}],
    ["Invalid plugin manifest: id missing", "invalidManifest", {}],
  ])("classifies %s", (message, code, values) => {
    expect(classifyPluginError(new Error(message))).toEqual({ code, message, values })
  })

  it("accepts a bare message string", () => {
    expect(classifyPluginError("Plugin not found: x").code).toBe("notFound")
  })

  it("honours an error that carries its own code", () => {
    const error = Object.assign(new Error("whatever"), { pluginErrorCode: "uninstallMirrored" })
    expect(classifyPluginError(error).code).toBe("uninstallMirrored")
  })

  it("leaves an unknown message unclassified", () => {
    expect(classifyPluginError(new Error("disk full"))).toEqual({
      code: null,
      message: "disk full",
      values: {},
    })
  })
})

describe("usePluginErrorMessage", () => {
  it("renders the localized sentence for a known failure", () => {
    const { result } = renderHook(() => usePluginErrorMessage())
    expect(result.current(new Error("Plugin not found: x"))).toBe("It's no longer installed.")
  })

  it("falls back to the raw message for an unknown failure", () => {
    const { result } = renderHook(() => usePluginErrorMessage())
    expect(result.current(new Error("disk full"))).toBe("disk full")
  })
})
