/**
 * @jest-environment jsdom
 */

import {
  isPluginAdapterError,
  PluginAdapterError,
  pluginAdapterError,
  reportAdapterError,
} from "./adapter-error"
import { subscribePluginError, type PluginErrorEventDetail } from "@/lib/plugin/error-bus"

jest.mock("@cognia/logging", () => ({
  loggers: {
    plugin: {
      warn: jest.fn(),
      error: jest.fn(),
    },
  },
}))

describe("host-side adapter-error re-exports", () => {
  it("re-exports the same PluginAdapterError symbol authors import", () => {
    const err = pluginAdapterError("TIMEOUT")
    expect(err).toBeInstanceOf(PluginAdapterError)
    expect(isPluginAdapterError(err)).toBe(true)
  })
})

describe("reportAdapterError", () => {
  it("dispatches an adapter-stage event with the code + message", () => {
    const seen: PluginErrorEventDetail[] = []
    const unsubscribe = subscribePluginError((d) => seen.push(d))
    try {
      reportAdapterError(pluginAdapterError("SECRET_MISSING", "AI_KEY not resolved"), {
        pluginId: "plg-e2b",
        pluginName: "E2B Sandbox",
      })
    } finally {
      unsubscribe()
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      pluginId: "plg-e2b",
      pluginName: "E2B Sandbox",
      stage: "adapter",
      severity: "error",
      message: "SECRET_MISSING: AI_KEY not resolved",
      recoverable: true,
    })
  })

  it("appends the hint to the dispatched message when present", () => {
    const seen: PluginErrorEventDetail[] = []
    const unsubscribe = subscribePluginError((d) => seen.push(d))
    try {
      reportAdapterError(
        new PluginAdapterError("DEPENDENCY_MISSING", "rg not installed", "brew install ripgrep"),
        { pluginId: "plg-grep" }
      )
    } finally {
      unsubscribe()
    }
    expect(seen[0]?.message).toBe("DEPENDENCY_MISSING: rg not installed (brew install ripgrep)")
  })

  it("marks permanent codes as non-recoverable", () => {
    const seen: PluginErrorEventDetail[] = []
    const unsubscribe = subscribePluginError((d) => seen.push(d))
    try {
      for (const code of ["PERMISSION_DENIED", "TARGET_NOT_ALLOWED", "STALE_REVISION"] as const) {
        reportAdapterError(pluginAdapterError(code), { pluginId: "plg-x" })
      }
    } finally {
      unsubscribe()
    }
    expect(seen).toHaveLength(3)
    for (const detail of seen) {
      expect(detail.recoverable).toBe(false)
      expect(detail.stage).toBe("adapter")
    }
  })

  it("marks transient codes as recoverable so the toast can offer retry", () => {
    const seen: PluginErrorEventDetail[] = []
    const unsubscribe = subscribePluginError((d) => seen.push(d))
    try {
      for (const code of [
        "DEPENDENCY_MISSING",
        "SECRET_MISSING",
        "TIMEOUT",
        "PROCESS_LIMIT",
      ] as const) {
        reportAdapterError(pluginAdapterError(code), { pluginId: "plg-x" })
      }
    } finally {
      unsubscribe()
    }
    expect(seen.every((d) => d.recoverable)).toBe(true)
  })

  it("honors an explicit severity override for warnings", () => {
    const seen: PluginErrorEventDetail[] = []
    const unsubscribe = subscribePluginError((d) => seen.push(d))
    try {
      reportAdapterError(pluginAdapterError("OUTPUT_TRUNCATED", "log truncated"), {
        pluginId: "plg-tail",
        severity: "warning",
      })
    } finally {
      unsubscribe()
    }
    expect(seen[0]?.severity).toBe("warning")
  })
})
