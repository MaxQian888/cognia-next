/**
 * @jest-environment node
 */

import {
  createLogRuntimeContext,
  normalizeLogOrigin,
  normalizeLogRuntime,
  withLogRuntimeContext,
} from "./runtime"
import type { Logger } from "./types"

describe("normalizeLogRuntime", () => {
  it("passes known runtimes through", () => {
    for (const value of [
      "browser",
      "server",
      "tauri",
      "mcp",
      "plugin",
      "internal",
      "unknown",
    ] as const) {
      expect(normalizeLogRuntime(value)).toBe(value)
    }
  })

  it("trims and lowercases input", () => {
    expect(normalizeLogRuntime(" Tauri ")).toBe("tauri")
    expect(normalizeLogRuntime("BROWSER")).toBe("browser")
  })

  it("collapses unknown strings to 'unknown'", () => {
    expect(normalizeLogRuntime("renderer")).toBe("unknown")
    expect(normalizeLogRuntime("")).toBe("unknown")
  })

  it("returns undefined for non-string input", () => {
    expect(normalizeLogRuntime(undefined)).toBeUndefined()
    expect(normalizeLogRuntime(42)).toBeUndefined()
    expect(normalizeLogRuntime({})).toBeUndefined()
  })
})

describe("normalizeLogOrigin", () => {
  it("passes known origins through", () => {
    for (const value of [
      "frontend",
      "web-runtime",
      "tauri",
      "mcp",
      "plugin",
      "diagnostic",
      "unknown",
    ] as const) {
      expect(normalizeLogOrigin(value)).toBe(value)
    }
  })

  it("collapses unknown strings to 'unknown'", () => {
    expect(normalizeLogOrigin("custom-origin")).toBe("unknown")
  })

  it("returns undefined for non-string input", () => {
    expect(normalizeLogOrigin(null)).toBeUndefined()
  })
})

describe("createLogRuntimeContext", () => {
  it("emits runtime, origin, and a deduped tag set including runtime:/source: prefixes", () => {
    const ctx = createLogRuntimeContext({
      runtime: "tauri",
      origin: "tauri",
      tags: ["native", "tauri"], // duplicate of runtime: prefix should still dedupe
    })
    expect(ctx.runtime).toBe("tauri")
    expect(ctx.origin).toBe("tauri")
    const tags = ctx.tags as string[]
    expect(tags).toContain("runtime:tauri")
    expect(tags).toContain("source:tauri")
    expect(tags).toContain("native")
    expect(tags).toContain("tauri")
    // Set semantics — no duplicates.
    expect(new Set(tags).size).toBe(tags.length)
  })

  it("preserves arbitrary extra fields", () => {
    const ctx = createLogRuntimeContext({
      runtime: "browser",
      origin: "frontend",
      target: "log://log",
      tauriTimestamp: "2026-04-29T00:00:00Z",
    } as Parameters<typeof createLogRuntimeContext>[0])
    expect(ctx.target).toBe("log://log")
    expect(ctx.tauriTimestamp).toBe("2026-04-29T00:00:00Z")
  })

  it("works with no tags supplied", () => {
    const ctx = createLogRuntimeContext({ runtime: "browser", origin: "frontend" })
    expect(ctx.tags).toEqual(["runtime:browser", "source:frontend"])
  })
})

describe("withLogRuntimeContext", () => {
  it("delegates to logger.withContext with the resolved runtime context", () => {
    const child = { tag: "child-logger" } as unknown as Logger
    const withContext = jest.fn().mockReturnValue(child)
    const logger = { withContext } as unknown as Logger
    const result = withLogRuntimeContext(logger, {
      runtime: "tauri",
      origin: "tauri",
      tags: ["native"],
    })
    expect(result).toBe(child)
    expect(withContext).toHaveBeenCalledTimes(1)
    const passed = withContext.mock.calls[0][0]
    expect(passed.runtime).toBe("tauri")
    expect(passed.origin).toBe("tauri")
    expect(passed.tags).toContain("runtime:tauri")
  })
})
