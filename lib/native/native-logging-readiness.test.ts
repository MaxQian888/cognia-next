/**
 * @jest-environment node
 */

import {
  getNativeLoggingReadiness,
  resetNativeLoggingReadinessForTest,
  updateNativeLoggingReadiness,
} from "./native-logging-readiness"

beforeEach(() => {
  resetNativeLoggingReadinessForTest()
})

describe("native-logging readiness state machine", () => {
  it("starts as 'inactive' for the web runtime by default", () => {
    const r = getNativeLoggingReadiness()
    expect(r.runtime).toBe("web")
    expect(r.status).toBe("inactive")
    expect(r.startupMode).toBe("disabled")
    expect(r.bridgeState).toBe("inactive")
  })

  it("derives 'healthy' when Tauri full-mode + bridge active", () => {
    const next = updateNativeLoggingReadiness({
      runtime: "tauri",
      startupMode: "full",
      startupHealth: "healthy",
      activeTargets: ["stdout", "folder", "webview"],
      bridgeState: "active",
      platformLogging: {
        available: true,
        backend: "event_log",
        health: "healthy",
        enabled: true,
        minLevel: "warn",
      },
    })
    expect(next.status).toBe("healthy")
  })

  it("derives 'degraded' when bootstrap fell back to fallback mode", () => {
    const next = updateNativeLoggingReadiness({
      runtime: "tauri",
      startupMode: "fallback",
      startupHealth: "degraded",
      activeTargets: ["stdout", "webview"],
      bridgeState: "active",
      fallbackReason: { code: "x", message: "no log dir" },
      platformLogging: {
        available: true,
        backend: "event_log",
        health: "healthy",
        enabled: true,
        minLevel: "warn",
      },
    })
    expect(next.status).toBe("degraded")
    expect(next.fallbackReason?.code).toBe("x")
  })

  it("derives 'degraded' when the bridge is degraded even with healthy startup", () => {
    const next = updateNativeLoggingReadiness({
      runtime: "tauri",
      startupMode: "full",
      startupHealth: "healthy",
      bridgeState: "degraded",
      bridgeLastError: "listen failed",
      platformLogging: {
        available: true,
        backend: "event_log",
        health: "healthy",
        enabled: true,
        minLevel: "warn",
      },
    })
    expect(next.status).toBe("degraded")
    expect(next.bridgeLastError).toBe("listen failed")
  })

  it("collapses to 'inactive' when nothing is set up (web mode)", () => {
    const next = updateNativeLoggingReadiness({
      runtime: "web",
      bridgeState: "inactive",
    })
    expect(next.status).toBe("inactive")
  })

  it("clears optional fields when null is explicitly passed", () => {
    updateNativeLoggingReadiness({
      runtime: "tauri",
      startupMode: "fallback",
      startupHealth: "degraded",
      fallbackReason: { code: "a", message: "b" },
      bridgeLastError: "c",
    })
    const cleared = updateNativeLoggingReadiness({
      fallbackReason: null,
      bridgeLastError: null,
    })
    expect(cleared.fallbackReason).toBeUndefined()
    expect(cleared.bridgeLastError).toBeUndefined()
  })

  it("preserves prior fields when an update omits them", () => {
    updateNativeLoggingReadiness({
      runtime: "tauri",
      startupMode: "full",
      activeTargets: ["stdout", "folder", "webview"],
      bridgeState: "active",
    })
    const partial = updateNativeLoggingReadiness({ bridgeLastError: "x" })
    expect(partial.runtime).toBe("tauri")
    expect(partial.activeTargets).toEqual(["stdout", "folder", "webview"])
    expect(partial.bridgeLastError).toBe("x")
  })
})
