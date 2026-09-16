/**
 * @jest-environment jsdom
 */
/**
 * The single liveness rule every dispatcher consults.
 */

import { isPluginHooksEnabled } from "./plugin-liveness"
import { usePluginStore } from "@/stores/plugin-runtime"

beforeEach(() => {
  usePluginStore.setState({ plugins: {} } as never)
})

describe("isPluginHooksEnabled", () => {
  it("is true for an enabled plugin", () => {
    usePluginStore.setState({ plugins: { p1: { id: "p1", status: "enabled" } } } as never)
    expect(isPluginHooksEnabled("p1")).toBe(true)
  })

  it("is false for any non-enabled status", () => {
    for (const status of ["disabled", "error", "loading", "updating"]) {
      usePluginStore.setState({ plugins: { p1: { id: "p1", status } } } as never)
      expect(isPluginHooksEnabled("p1")).toBe(false)
    }
  })

  it("counts a plugin with no row yet as live, so its own onEnable can fire", () => {
    expect(isPluginHooksEnabled("mid-activation")).toBe(true)
  })
})
