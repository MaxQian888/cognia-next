/**
 * Tests for Plugin Profiler
 */

import { PluginProfiler, getPluginProfiler, resetPluginProfiler, withProfiling } from "./profiler"

describe("PluginProfiler", () => {
  let profiler: PluginProfiler

  beforeEach(() => {
    resetPluginProfiler()
    profiler = new PluginProfiler({ enabled: true })
  })

  afterEach(() => {
    profiler.clearEntries()
  })

  describe("Basic Profiling", () => {
    it("should start and stop a profiling session", () => {
      profiler.startSession("plugin-a")
      expect(profiler.isSessionActive("plugin-a")).toBe(true)
      expect(profiler.isEnabled()).toBe(true)

      const summary = profiler.endSession("plugin-a")
      expect(summary.pluginId).toBe("plugin-a")
      expect(profiler.isSessionActive("plugin-a")).toBe(false)
      expect(profiler.isEnabled()).toBe(false)
    })

    it("should start and end a profile", () => {
      const profileId = profiler.startProfile("plugin-a", "operation")
      expect(profileId).toBeTruthy()

      const entry = profiler.endProfile(profileId)
      expect(entry).toBeDefined()
      expect(entry?.operation).toBe("operation")
      expect(entry?.status).toBe("completed")
      expect(entry?.duration).toBeGreaterThanOrEqual(0)
    })

    it("should track error status", () => {
      const profileId = profiler.startProfile("plugin-a", "operation")
      const entry = profiler.endProfile(profileId, new Error("Test error"))

      expect(entry?.status).toBe("error")
      expect(entry?.error).toBe("Test error")
    })

    it("should handle disabled profiler", () => {
      profiler.setEnabled(false)

      const profileId = profiler.startProfile("plugin-a", "operation")
      expect(profileId).toBe("")
    })
  })

  describe("Synchronous Profiling", () => {
    it("should profile synchronous functions", () => {
      const result = profiler.profile("plugin-a", "sync-op", () => {
        return 42
      })

      expect(result).toBe(42)

      const entries = profiler.getEntries("plugin-a")
      expect(entries.length).toBe(1)
      expect(entries[0].operation).toBe("sync-op")
    })

    it("should capture errors in sync functions", () => {
      expect(() => {
        profiler.profile("plugin-a", "error-op", () => {
          throw new Error("Sync error")
        })
      }).toThrow("Sync error")

      const entries = profiler.getEntries("plugin-a")
      expect(entries[0].status).toBe("error")
    })
  })

  describe("Asynchronous Profiling", () => {
    it("should profile async functions", async () => {
      jest.useFakeTimers()
      const pending = profiler.profileAsync("plugin-a", "async-op", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return "async result"
      })
      await jest.advanceTimersByTimeAsync(10)
      const result = await pending
      jest.useRealTimers()

      expect(result).toBe("async result")

      const entries = profiler.getEntries("plugin-a")
      expect(entries.length).toBe(1)
      expect(entries[0].duration).toBeGreaterThanOrEqual(10)
    })

    it("should capture errors in async functions", async () => {
      await expect(
        profiler.profileAsync("plugin-a", "async-error", async () => {
          throw new Error("Async error")
        })
      ).rejects.toThrow("Async error")

      const entries = profiler.getEntries("plugin-a")
      expect(entries[0].status).toBe("error")
    })
  })

  describe("Nested Profiling", () => {
    it("should handle nested profiles", () => {
      const parentId = profiler.startProfile("plugin-a", "parent")

      const childId = profiler.startProfile("plugin-a", "child")
      profiler.endProfile(childId)

      const parent = profiler.endProfile(parentId)

      expect(parent?.children.length).toBe(1)
      expect(parent?.children[0].operation).toBe("child")
    })
  })

  describe("Profile Summary", () => {
    beforeEach(() => {
      profiler.profile("plugin-a", "op-fast", () => {})
      profiler.profile("plugin-a", "op-fast", () => {})
      profiler.profile("plugin-a", "op-slow", () => {
        const start = Date.now()
        while (Date.now() - start < 5) {
          // Busy wait
        }
      })
    })

    it("should generate summary", () => {
      const summary = profiler.getSummary("plugin-a")

      expect(summary.pluginId).toBe("plugin-a")
      expect(summary.totalOperations).toBe(3)
      expect(summary.totalDuration).toBeGreaterThan(0)
    })

    it("should calculate operation breakdown", () => {
      const summary = profiler.getSummary("plugin-a")

      expect(summary.operationBreakdown["op-fast"]).toBeDefined()
      expect(summary.operationBreakdown["op-fast"].count).toBe(2)
      expect(summary.operationBreakdown["op-slow"].count).toBe(1)
    })

    it("should identify hotspots", () => {
      const summary = profiler.getSummary("plugin-a")

      expect(summary.hotspots.length).toBeGreaterThan(0)
      expect(summary.hotspots[0].operation).toBeDefined()
      expect(summary.hotspots[0].percentage).toBeDefined()
    })
  })

  describe("Slow Operations", () => {
    it("should detect slow operations", async () => {
      await profiler.profileAsync("plugin-a", "slow", async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })

      profiler.profile("plugin-a", "fast", () => {})

      const slow = profiler.getSlowOperations("plugin-a", 30)
      expect(slow.length).toBe(1)
      expect(slow[0].operation).toBe("slow")
    })
  })

  describe("Error Operations", () => {
    it("should collect error operations", () => {
      try {
        profiler.profile("plugin-a", "error-1", () => {
          throw new Error("Error 1")
        })
      } catch {
        // Expected
      }

      profiler.profile("plugin-a", "success", () => {})

      const errors = profiler.getErrorOperations("plugin-a")
      expect(errors.length).toBe(1)
      expect(errors[0].operation).toBe("error-1")
    })
  })

  describe("Flame Graph Data", () => {
    it("should generate flame graph data", () => {
      const parentId = profiler.startProfile("plugin-a", "parent")
      const childId = profiler.startProfile("plugin-a", "child")
      profiler.endProfile(childId)
      profiler.endProfile(parentId)

      const flameData = profiler.getFlameGraphData("plugin-a")

      expect(flameData.length).toBe(1)
      expect(flameData[0].name).toBe("parent")
      expect(flameData[0].children.length).toBe(1)
      expect(flameData[0].children[0].name).toBe("child")
    })
  })

  describe("Resource Snapshots", () => {
    it("should capture resource snapshots", () => {
      const usage = profiler.captureResourceSnapshot("plugin-a")

      expect(usage.timestamp).toBeDefined()
      expect(typeof usage.memory).toBe("number")
    })

    it("should store snapshot history", () => {
      profiler.captureResourceSnapshot("plugin-a")
      profiler.captureResourceSnapshot("plugin-a")
      profiler.captureResourceSnapshot("plugin-a")

      const history = profiler.getResourceHistory("plugin-a")
      expect(history.length).toBe(3)
    })
  })

  describe("Entry Management", () => {
    it("should clear entries for a plugin", () => {
      profiler.profile("plugin-a", "op", () => {})
      profiler.profile("plugin-b", "op", () => {})

      profiler.clearEntries("plugin-a")

      expect(profiler.getEntries("plugin-a").length).toBe(0)
      expect(profiler.getEntries("plugin-b").length).toBe(1)
    })

    it("should clear all entries", () => {
      profiler.profile("plugin-a", "op", () => {})
      profiler.profile("plugin-b", "op", () => {})

      profiler.clearEntries()

      expect(profiler.getEntries("plugin-a").length).toBe(0)
      expect(profiler.getEntries("plugin-b").length).toBe(0)
    })
  })
})

describe("withProfiling", () => {
  beforeEach(() => {
    resetPluginProfiler()
  })

  it("should wrap a function with profiling", () => {
    const fn = (x: number, y: number) => x + y
    const profiled = withProfiling(
      "plugin-a",
      "add",
      fn as unknown as (...args: unknown[]) => unknown
    )

    const result = profiled(2, 3)

    expect(result).toBe(5)

    const profiler = getPluginProfiler()
    const entries = profiler.getEntries("plugin-a")
    expect(entries.length).toBe(1)
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetPluginProfiler()
    const instance1 = getPluginProfiler()
    const instance2 = getPluginProfiler()
    expect(instance1).toBe(instance2)
  })
})
