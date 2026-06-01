import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@/types/memory/memory"
import type { Memory } from "@/types/memory/memory"

const mockBuildDeps = jest.fn()
jest.mock("./build-maintenance-deps", () => ({
  buildEpisodicMaintenanceDeps: (...a: unknown[]) => mockBuildDeps(...a),
}))

import {
  runMemoryMaintenance,
  scheduleMemoryMaintenance,
  __resetMaintenanceGuard,
  type MemoryMaintenanceDeps,
} from "./maintenance"

function cfg(over: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...over }
}

function mem(over: Partial<Memory> = {}): Memory {
  const now = 1_700_000_000_000
  return {
    id: "m1",
    scope: "global",
    type: "semantic",
    text: "x",
    tags: [],
    importance: 5,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

const transcript = [
  { role: "user", text: "u1" },
  { role: "assistant", text: "a1" },
  { role: "user", text: "u2" },
  { role: "assistant", text: "a2" },
]

describe("runMemoryMaintenance", () => {
  it("distills episodes then evicts scope overflow (real composition)", async () => {
    const consolidated: unknown[] = []
    const invalidated: string[] = []
    const deps: MemoryMaintenanceDeps = {
      distillDeps: {
        distill: async () => [{ type: "episodic", text: "Decided X", importance: 7 }],
        consolidate: async (ci) => {
          consolidated.push(ci)
          return { applied: [] }
        },
      },
      decayDeps: {
        listActive: async () => [
          mem({ id: "a", importance: 1, lastAccessedAt: 1 }),
          mem({ id: "b", importance: 9 }),
        ],
        invalidate: async (id) => {
          invalidated.push(id)
        },
      },
    }
    await runMemoryMaintenance(
      { transcript, scope: "global", provenance: "user", config: cfg({ maxActivePerScope: 1 }) },
      deps
    )
    expect(consolidated).toHaveLength(1)
    expect(invalidated).toEqual(["a"]) // lowest-scored evicted to reach cap 1
  })
})

describe("scheduleMemoryMaintenance", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetMaintenanceGuard()
    jest.useFakeTimers()
    mockBuildDeps.mockResolvedValue({
      distillDeps: { distill: async () => [], consolidate: async () => ({ applied: [] }) },
      decayDeps: { listActive: async () => [], invalidate: async () => {} },
    })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  const base = {
    sessionId: "s1",
    session: { id: "s1" } as never,
    appSettings: null,
    transcript,
    provenance: "user" as const,
  }

  it("no-ops when memory disabled / temporary / inbound", () => {
    scheduleMemoryMaintenance({ ...base, config: cfg({ enabled: false }) })
    scheduleMemoryMaintenance({ ...base, config: cfg({ temporary: true }) })
    scheduleMemoryMaintenance({ ...base, provenance: "inbound", config: cfg() })
    jest.runAllTimers()
    expect(mockBuildDeps).not.toHaveBeenCalled()
  })

  it("no-ops for a too-short conversation", () => {
    scheduleMemoryMaintenance({
      ...base,
      transcript: [{ role: "assistant", text: "a1" }], // 1 < min 2
      config: cfg(),
    })
    jest.runAllTimers()
    expect(mockBuildDeps).not.toHaveBeenCalled()
  })

  it("schedules a maintenance pass and runs it on idle", async () => {
    scheduleMemoryMaintenance({ ...base, config: cfg() })
    await jest.runAllTimersAsync()
    expect(mockBuildDeps).toHaveBeenCalledTimes(1)
  })

  it("runs at most once per session per app run", async () => {
    scheduleMemoryMaintenance({ ...base, config: cfg() })
    scheduleMemoryMaintenance({ ...base, config: cfg() })
    await jest.runAllTimersAsync()
    expect(mockBuildDeps).toHaveBeenCalledTimes(1)
  })

  it("releases the guard for retry when deps cannot be built", async () => {
    mockBuildDeps.mockResolvedValueOnce(null)
    scheduleMemoryMaintenance({ ...base, config: cfg() })
    await jest.runAllTimersAsync()
    // guard released → a second schedule will try again
    scheduleMemoryMaintenance({ ...base, config: cfg() })
    await jest.runAllTimersAsync()
    expect(mockBuildDeps).toHaveBeenCalledTimes(2)
  })
})
