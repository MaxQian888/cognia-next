/**
 * Coverage for the adapter lifecycle registry — the singleton hook the
 * Health Tab's "Reconnect now" affordance reaches into.
 */

import {
  __resetLifecycleForTesting,
  getRunningAdapter,
  listRunningAdapters,
  registerRunningAdapter,
  requeueAdapter,
  unregisterRunningAdapter,
  type AdapterRuntimeEntry,
} from "./lifecycle"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { HeartbeatHandle } from "@/lib/connectors/health/heartbeat"

function makeEntry(id: string, overrides: Partial<AdapterRuntimeEntry> = {}): AdapterRuntimeEntry {
  return {
    adapter: { id, stop: jest.fn().mockResolvedValue(undefined) } as unknown as PlatformAdapter,
    heartbeat: { dispose: jest.fn() } as HeartbeatHandle,
    abortController: new AbortController(),
    restart: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

beforeEach(() => {
  __resetLifecycleForTesting()
})

describe("registerRunningAdapter / getRunningAdapter / listRunningAdapters", () => {
  it("stores and retrieves entries by id", () => {
    const e1 = makeEntry("a")
    const e2 = makeEntry("b")
    registerRunningAdapter("a", e1)
    registerRunningAdapter("b", e2)
    expect(getRunningAdapter("a")).toBe(e1)
    expect(getRunningAdapter("b")).toBe(e2)
    expect(listRunningAdapters()).toHaveLength(2)
  })

  it("overwrites a previous entry for the same id", () => {
    const oldEntry = makeEntry("dup")
    const newEntry = makeEntry("dup")
    registerRunningAdapter("dup", oldEntry)
    registerRunningAdapter("dup", newEntry)
    expect(getRunningAdapter("dup")).toBe(newEntry)
  })

  it("returns undefined for unknown ids", () => {
    expect(getRunningAdapter("nope")).toBeUndefined()
  })
})

describe("unregisterRunningAdapter", () => {
  it("disposes heartbeat, aborts the signal, and calls adapter.stop()", async () => {
    const entry = makeEntry("x")
    registerRunningAdapter("x", entry)
    unregisterRunningAdapter("x")
    expect(entry.heartbeat.dispose).toHaveBeenCalledTimes(1)
    expect(entry.abortController.signal.aborted).toBe(true)
    // adapter.stop is fire-and-forget; await one microtask
    await new Promise((r) => setTimeout(r, 0))
    expect(entry.adapter.stop).toHaveBeenCalledTimes(1)
    expect(getRunningAdapter("x")).toBeUndefined()
  })

  it("is a no-op when the id is unknown", () => {
    expect(() => unregisterRunningAdapter("missing")).not.toThrow()
  })

  it("swallows a thrown stop() so unmount cleanup never propagates", async () => {
    const entry = makeEntry("throws", {
      adapter: {
        id: "throws",
        stop: jest.fn().mockRejectedValue(new Error("stop crashed")),
      } as unknown as PlatformAdapter,
    })
    registerRunningAdapter("throws", entry)
    expect(() => unregisterRunningAdapter("throws")).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(entry.adapter.stop).toHaveBeenCalledTimes(1)
  })
})

describe("requeueAdapter", () => {
  it("returns false when the adapter is not registered", async () => {
    expect(await requeueAdapter("ghost")).toBe(false)
  })

  it("tears down the entry and calls restart() once", async () => {
    const restart = jest.fn().mockResolvedValue(undefined)
    const entry = makeEntry("r1", { restart })
    registerRunningAdapter("r1", entry)
    const result = await requeueAdapter("r1")
    expect(result).toBe(true)
    expect(entry.heartbeat.dispose).toHaveBeenCalledTimes(1)
    expect(entry.abortController.signal.aborted).toBe(true)
    expect(restart).toHaveBeenCalledTimes(1)
    // The registry is empty after unregister; the restart callback is
    // responsible for re-populating it.
    expect(getRunningAdapter("r1")).toBeUndefined()
  })

  it("propagates restart() rejections to the caller", async () => {
    const restart = jest.fn().mockRejectedValue(new Error("restart bombed"))
    const entry = makeEntry("r2", { restart })
    registerRunningAdapter("r2", entry)
    await expect(requeueAdapter("r2")).rejects.toThrow(/restart bombed/)
    expect(entry.heartbeat.dispose).toHaveBeenCalledTimes(1)
  })
})

describe("__resetLifecycleForTesting", () => {
  it("clears all entries and tears down their resources", () => {
    const e1 = makeEntry("a")
    const e2 = makeEntry("b")
    registerRunningAdapter("a", e1)
    registerRunningAdapter("b", e2)
    __resetLifecycleForTesting()
    expect(listRunningAdapters()).toHaveLength(0)
    expect(e1.heartbeat.dispose).toHaveBeenCalledTimes(1)
    expect(e2.heartbeat.dispose).toHaveBeenCalledTimes(1)
    expect(e1.abortController.signal.aborted).toBe(true)
    expect(e2.abortController.signal.aborted).toBe(true)
  })
})
