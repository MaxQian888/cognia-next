/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

import { pluginRuntimeProfileFor } from "@/lib/plugin/core/bootstrap"

import { usePluginRuntimeProfile } from "./use-plugin-runtime-profile"

// The hook is `useSyncExternalStore` glue over this rule, and the rule is what
// has to agree with the manager. `resolvePluginRuntimeBootstrap` is its only
// other caller, which is the point: a badge that disagreed with the profile the
// manager boots as would be worse than no badge.
describe("pluginRuntimeProfileFor", () => {
  it("is tauri on the desktop shell", () => {
    expect(pluginRuntimeProfileFor({ isTauri: true })).toBe("tauri")
  })

  it("prefers tauri even if a caller also claims mobile", () => {
    expect(pluginRuntimeProfileFor({ isTauri: true, isMobile: true })).toBe("tauri")
  })

  it("is mobile inside the Capacitor WebView", () => {
    expect(pluginRuntimeProfileFor({ isTauri: false, isMobile: true })).toBe("mobile")
  })

  it("is browser for plain web", () => {
    expect(pluginRuntimeProfileFor({ isTauri: false })).toBe("browser")
  })
})

describe("usePluginRuntimeProfile", () => {
  it("answers browser in a plain jsdom shell", () => {
    const { result } = renderHook(() => usePluginRuntimeProfile())
    expect(result.current).toBe("browser")
  })
})
