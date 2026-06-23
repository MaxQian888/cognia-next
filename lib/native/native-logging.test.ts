/**
 * @jest-environment node
 *
 * Tests for native/native-logging — invoke wrappers that update the
 * native-logging-readiness state machine.
 */

import { invoke } from "@tauri-apps/api/core"

let isTauriValue = false
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriValue,
}))

import {
  getNativeLoggingReadiness,
  getNativeLoggingReadinessSnapshot,
  getPlatformLoggingStatus,
  setPlatformLoggingConfig,
  forwardPlatformLoggingEntries,
  getNativeLogDirectory,
  openNativeLogDirectory,
  getTracingLevels,
  setTracingLevels,
} from "./native-logging"
import {
  resetNativeLoggingReadinessForTest,
  type PlatformLoggingStatus,
} from "./native-logging-readiness"

const mockedInvoke = invoke as unknown as jest.Mock

beforeEach(() => {
  isTauriValue = false
  mockedInvoke.mockReset()
  resetNativeLoggingReadinessForTest()
})

describe("getNativeLoggingReadiness", () => {
  it("returns null when not running under Tauri", async () => {
    expect(await getNativeLoggingReadiness()).toBeNull()
  })

  it("updates the readiness state from a successful invoke", async () => {
    isTauriValue = true
    mockedInvoke.mockResolvedValueOnce({
      startupMode: "full",
      startupHealth: "healthy",
      activeTargets: ["stdout"],
      platformLogging: {
        available: true,
        backend: "event_log",
        health: "healthy",
        enabled: true,
        minLevel: "warn",
      },
      checkedAt: "2025-01-01T00:00:00Z",
    })

    const r = await getNativeLoggingReadiness()
    expect(r?.runtime).toBe("tauri")
    expect(r?.startupMode).toBe("full")
    expect(r?.activeTargets).toEqual(["stdout"])
    expect(r?.checkedAt).toBe("2025-01-01T00:00:00Z")
    expect(mockedInvoke).toHaveBeenCalledWith("native_logging_get_readiness")
  })

  it("uses defaults when payload fields are missing", async () => {
    isTauriValue = true
    mockedInvoke.mockResolvedValueOnce({})

    const r = await getNativeLoggingReadiness()
    expect(r?.runtime).toBe("tauri")
    expect(r?.startupMode).toBe("unknown")
    expect(r?.startupHealth).toBe("inactive")
    expect(r?.activeTargets).toEqual([])
    expect(r?.fallbackReason).toBeUndefined()
  })

  it("records a fallback reason when invoke rejects with an Error", async () => {
    isTauriValue = true
    mockedInvoke.mockRejectedValueOnce(new Error("command missing"))

    const r = await getNativeLoggingReadiness()
    expect(r?.startupMode).toBe("fallback")
    expect(r?.startupHealth).toBe("degraded")
    expect(r?.fallbackReason).toEqual({
      code: "native_readiness_query_failed",
      message: "command missing",
    })
  })

  it("records a fallback reason when invoke rejects with a string", async () => {
    isTauriValue = true
    mockedInvoke.mockRejectedValueOnce("boom")

    const r = await getNativeLoggingReadiness()
    expect(r?.fallbackReason?.message).toBe("boom")
  })
})

describe("getNativeLoggingReadinessSnapshot", () => {
  it("returns the current in-memory snapshot", () => {
    const snap = getNativeLoggingReadinessSnapshot()
    expect(snap.runtime).toBe("web")
  })
})

describe("getPlatformLoggingStatus", () => {
  it("returns null on web", async () => {
    expect(await getPlatformLoggingStatus()).toBeNull()
  })

  it("forwards the status into readiness on success", async () => {
    isTauriValue = true
    const status: PlatformLoggingStatus = {
      available: true,
      backend: "event_log",
      health: "healthy",
      enabled: true,
      minLevel: "info",
    }
    mockedInvoke.mockResolvedValueOnce(status)
    await expect(getPlatformLoggingStatus()).resolves.toEqual(status)
    expect(getNativeLoggingReadinessSnapshot().platformLogging.health).toBe("healthy")
  })

  it("falls back to the cached status on invoke failure", async () => {
    isTauriValue = true
    mockedInvoke.mockRejectedValueOnce(new Error("boom"))
    const result = await getPlatformLoggingStatus()
    expect(result?.health).toBe("inactive")
  })
})

describe("setPlatformLoggingConfig", () => {
  it("returns null on web", async () => {
    expect(await setPlatformLoggingConfig({ enabled: true })).toBeNull()
  })

  it("forwards updated status on success", async () => {
    isTauriValue = true
    const status: PlatformLoggingStatus = {
      available: true,
      backend: "event_log",
      health: "healthy",
      enabled: false,
      minLevel: "error",
    }
    mockedInvoke.mockResolvedValueOnce(status)
    await expect(setPlatformLoggingConfig({ enabled: false })).resolves.toEqual(status)
    expect(mockedInvoke).toHaveBeenCalledWith("platform_logging_set_config", {
      config: { enabled: false },
    })
    expect(getNativeLoggingReadinessSnapshot().platformLogging.enabled).toBe(false)
  })

  it("records a degraded platformLogging snapshot on invoke failure", async () => {
    isTauriValue = true
    mockedInvoke.mockRejectedValueOnce(new Error("cant write"))
    const result = await setPlatformLoggingConfig({ enabled: true })
    expect(result).toBeNull()
    const snap = getNativeLoggingReadinessSnapshot()
    expect(snap.platformLogging.health).toBe("degraded")
    expect(snap.platformLogging.error).toBe("cant write")
  })

  it("coerces non-Error rejections to a string", async () => {
    isTauriValue = true
    mockedInvoke.mockRejectedValueOnce("string err")
    await setPlatformLoggingConfig({ enabled: true })
    expect(getNativeLoggingReadinessSnapshot().platformLogging.error).toBe("string err")
  })
})

describe("forwardPlatformLoggingEntries", () => {
  it("returns false on web", async () => {
    expect(
      await forwardPlatformLoggingEntries([{ level: "info", module: "m", message: "x" }])
    ).toBe(false)
  })

  it("returns false for an empty list", async () => {
    isTauriValue = true
    expect(await forwardPlatformLoggingEntries([])).toBe(false)
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it("forwards entries successfully", async () => {
    isTauriValue = true
    mockedInvoke.mockResolvedValueOnce(undefined)
    const entries = [{ level: "warn" as const, module: "mod", message: "hi" }]
    await expect(forwardPlatformLoggingEntries(entries)).resolves.toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith("platform_logging_forward", { entries })
  })

  it("returns false when the invoke rejects", async () => {
    isTauriValue = true
    mockedInvoke.mockRejectedValueOnce(new Error("reject"))
    await expect(
      forwardPlatformLoggingEntries([{ level: "info", module: "m", message: "x" }])
    ).resolves.toBe(false)
  })
})

describe("getNativeLogDirectory / openNativeLogDirectory", () => {
  it("returns null on web (getNativeLogDirectory)", async () => {
    expect(await getNativeLogDirectory()).toBeNull()
  })

  it("returns the directory path on success", async () => {
    isTauriValue = true
    mockedInvoke.mockResolvedValueOnce("/var/log/cognia")
    await expect(getNativeLogDirectory()).resolves.toBe("/var/log/cognia")
  })

  it("returns null when the invoke rejects", async () => {
    isTauriValue = true
    mockedInvoke.mockRejectedValueOnce(new Error("not allowed"))
    expect(await getNativeLogDirectory()).toBeNull()
  })

  it("openNativeLogDirectory returns false on web", async () => {
    expect(await openNativeLogDirectory()).toBe(false)
  })

  it("openNativeLogDirectory returns true on success", async () => {
    isTauriValue = true
    mockedInvoke.mockResolvedValueOnce(undefined)
    expect(await openNativeLogDirectory()).toBe(true)
  })

  it("openNativeLogDirectory returns false on invoke rejection", async () => {
    isTauriValue = true
    mockedInvoke.mockRejectedValueOnce(new Error("boom"))
    expect(await openNativeLogDirectory()).toBe(false)
  })
})

describe("tracing level controls", () => {
  it("getTracingLevels returns null when not running under Tauri", async () => {
    expect(await getTracingLevels()).toBeNull()
  })

  it("getTracingLevels invokes the command and returns the status", async () => {
    isTauriValue = true
    const status = {
      active: true,
      defaultLevel: "info",
      rules: [{ target: "network", level: "debug" }],
    }
    mockedInvoke.mockResolvedValueOnce(status)
    expect(await getTracingLevels()).toEqual(status)
    expect(mockedInvoke).toHaveBeenCalledWith("tracing_logging_get_levels")
  })

  it("getTracingLevels returns null on invoke rejection", async () => {
    isTauriValue = true
    mockedInvoke.mockRejectedValueOnce(new Error("boom"))
    expect(await getTracingLevels()).toBeNull()
  })

  it("setTracingLevels returns null when not running under Tauri", async () => {
    expect(await setTracingLevels([{ target: "network", level: "debug" }])).toBeNull()
  })

  it("setTracingLevels invokes with rules and default level", async () => {
    isTauriValue = true
    const status = { active: true, defaultLevel: "warn", rules: [{ target: "ai", level: "trace" }] }
    mockedInvoke.mockResolvedValueOnce(status)
    const result = await setTracingLevels([{ target: "ai", level: "trace" }], "warn")
    expect(result).toEqual(status)
    expect(mockedInvoke).toHaveBeenCalledWith("tracing_logging_set_levels", {
      rules: [{ target: "ai", level: "trace" }],
      defaultLevel: "warn",
    })
  })

  it("setTracingLevels returns null on invoke rejection", async () => {
    isTauriValue = true
    mockedInvoke.mockRejectedValueOnce(new Error("boom"))
    expect(await setTracingLevels([])).toBeNull()
  })
})
