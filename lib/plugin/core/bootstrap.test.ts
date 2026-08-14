// `describe` / `it` / `expect` are global in Jest (see `@types/jest`); we
// don't import from `@jest/globals` because that package isn't bundled.
import { resolvePluginRuntimeBootstrap } from "./bootstrap"

describe("resolvePluginRuntimeBootstrap", () => {
  it("returns browser runtime bootstrap config outside Tauri main window requirements", () => {
    expect(
      resolvePluginRuntimeBootstrap({
        isTauri: false,
        windowLabel: null,
      })
    ).toEqual({
      shouldInitialize: true,
      config: {
        runtimeProfile: "browser",
        pluginDirectory: "",
        enablePython: false,
        lifecycleFeatures: {
          ledgerV2: true,
          runtimeServices: true,
          scopedRealms: false,
        },
      },
    })
  })

  it("returns the mobile runtime profile inside the Capacitor shell (non-Tauri + isMobile)", () => {
    expect(
      resolvePluginRuntimeBootstrap({
        isTauri: false,
        isMobile: true,
        windowLabel: null,
      })
    ).toEqual({
      shouldInitialize: true,
      config: {
        runtimeProfile: "mobile",
        pluginDirectory: "",
        enablePython: false,
        lifecycleFeatures: {
          ledgerV2: true,
          runtimeServices: true,
          scopedRealms: false,
        },
      },
    })
  })

  it("returns tauri runtime bootstrap config for the main window", () => {
    expect(
      resolvePluginRuntimeBootstrap({
        isTauri: true,
        windowLabel: "main",
        pluginDirectory: "/plugins",
      })
    ).toEqual({
      shouldInitialize: true,
      config: {
        runtimeProfile: "tauri",
        pluginDirectory: "/plugins",
        enablePython: true,
        lifecycleFeatures: {
          ledgerV2: true,
          runtimeServices: true,
          scopedRealms: false,
        },
      },
    })
  })

  it("skips initialization for non-main tauri windows", () => {
    expect(
      resolvePluginRuntimeBootstrap({
        isTauri: true,
        windowLabel: "assistant-bubble",
        pluginDirectory: "/plugins",
      })
    ).toEqual({
      shouldInitialize: false,
      reason: "non-main-window",
    })
  })
})
