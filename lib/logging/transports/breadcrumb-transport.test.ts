/**
 * @jest-environment node
 *
 * Tests for the breadcrumb transport — level floor, native-origin skip, rate
 * limiting, and desktop-only behaviour. `pushCrashBreadcrumb` and `isTauri`
 * are mocked so we can assert forwarding without a Tauri runtime.
 */

import type { LogLevel, StructuredLogEntry } from "@/types/logging"

let isTauriValue = true
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriValue,
}))

const pushCrashBreadcrumb = jest.fn(async (..._args: unknown[]) => {})
jest.mock("@/lib/native/crash-context", () => ({
  pushCrashBreadcrumb: (...args: unknown[]) => pushCrashBreadcrumb(...args),
}))

import { createBreadcrumbTransport } from "./breadcrumb-transport"

function makeEntry(
  level: LogLevel,
  overrides: Partial<StructuredLogEntry> = {}
): StructuredLogEntry {
  return {
    id: `id-${Math.random()}`,
    timestamp: "2026-06-11T00:00:00.000Z",
    level,
    message: "something happened",
    module: "chat",
    ...overrides,
  }
}

beforeEach(() => {
  isTauriValue = true
  pushCrashBreadcrumb.mockClear()
})

describe("BreadcrumbTransport", () => {
  it("forwards warn/error/fatal with module-tagged message", () => {
    const t = createBreadcrumbTransport()
    t.log(makeEntry("error", { module: "ai", message: "model failed" }))
    expect(pushCrashBreadcrumb).toHaveBeenCalledWith("[ai] model failed", "error")
  })

  it("ignores entries below the warn floor", () => {
    const t = createBreadcrumbTransport()
    t.log(makeEntry("info"))
    t.log(makeEntry("debug"))
    t.log(makeEntry("trace"))
    expect(pushCrashBreadcrumb).not.toHaveBeenCalled()
  })

  it("skips tauri-origin entries to avoid the log://log echo loop", () => {
    const t = createBreadcrumbTransport()
    t.log(makeEntry("error", { origin: "tauri" }))
    expect(pushCrashBreadcrumb).not.toHaveBeenCalled()
  })

  it("is a no-op off the desktop runtime", () => {
    isTauriValue = false
    const t = createBreadcrumbTransport()
    t.log(makeEntry("fatal"))
    expect(pushCrashBreadcrumb).not.toHaveBeenCalled()
    expect(t.getHealth().status).toBe("offline")
  })

  it("rate-limits bursts within a window and resumes in the next window", () => {
    let clock = 1000
    const t = createBreadcrumbTransport({ maxPerInterval: 2, intervalMs: 1000, now: () => clock })

    t.log(makeEntry("warn")) // window opens, count 1
    t.log(makeEntry("warn")) // count 2
    t.log(makeEntry("warn")) // dropped
    expect(pushCrashBreadcrumb).toHaveBeenCalledTimes(2)
    expect(t.getHealth().droppedEntries).toBe(1)

    clock += 1001 // new window
    t.log(makeEntry("warn"))
    expect(pushCrashBreadcrumb).toHaveBeenCalledTimes(3)
  })

  it("reports healthy after a successful forward", () => {
    const t = createBreadcrumbTransport()
    t.log(makeEntry("error"))
    expect(t.getHealth().status).toBe("healthy")
    expect(t.getHealth().lastSuccessAt).toBeDefined()
  })
})
