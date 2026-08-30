import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@/types/memory/memory"
import type { Memory } from "@/types/memory/memory"

const mockBuildDeps = jest.fn()
const mockEnqueueJob = jest.fn()
const mockClaimJob = jest.fn()
const mockCompleteJob = jest.fn()
const mockFailJob = jest.fn()
const mockDrainAfterTurn = jest.fn()
jest.mock("./job-worker", () => ({
  drainMemoryJobsAfterTurn: (...a: unknown[]) => mockDrainAfterTurn(...a),
}))
jest.mock("./build-maintenance-deps", () => ({
  buildEpisodicMaintenanceDeps: (...a: unknown[]) => mockBuildDeps(...a),
}))
jest.mock("@/lib/db/memory-governance", () => ({
  enqueueMemoryJob: (...a: unknown[]) => mockEnqueueJob(...a),
  claimMemoryJob: (...a: unknown[]) => mockClaimJob(...a),
  finishMemoryJob: (...a: unknown[]) => mockCompleteJob(...a),
  failMemoryJob: (...a: unknown[]) => mockFailJob(...a),
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

  it("audits what decay removed, split by capacity vs idle", async () => {
    // Without this, `deps.invalidate` writes no audit event and a user who set
    // maxIdleDays has no way to tell whether it ever fired.
    const records: unknown[] = []
    const now = 1_700_000_000_000
    const rows = [
      // Over the cap AND stale — capacity evicts the lowest-scored one first,
      // then idle expiry sweeps whatever is still active and untouched.
      mem({ id: "old", importance: 1, lastAccessedAt: now - 60 * 24 * 60 * 60 * 1000 }),
      mem({ id: "alsoOld", importance: 9, lastAccessedAt: now - 60 * 24 * 60 * 60 * 1000 }),
    ]
    const invalidated = new Set<string>()
    const deps: MemoryMaintenanceDeps = {
      distillDeps: { distill: async () => [], consolidate: async () => ({ applied: [] }) },
      decayDeps: {
        listActive: async () => rows.filter((m) => !invalidated.has(m.id)),
        invalidate: async (id) => {
          invalidated.add(id)
        },
      },
      recordDecay: async (record) => {
        records.push(record)
      },
    }

    await runMemoryMaintenance(
      {
        transcript,
        scope: "global",
        provenance: "user",
        source: { sessionId: "s1" },
        config: cfg({ maxActivePerScope: 1, maxIdleDays: 30 }),
        now,
      },
      deps
    )

    expect(records).toEqual([
      { reason: "capacity", memoryIds: ["old"], sessionId: "s1" },
      { reason: "idle", memoryIds: ["alsoOld"], sessionId: "s1" },
    ])
  })

  it("does not record a decay pass that removed nothing", async () => {
    const records: unknown[] = []
    const deps: MemoryMaintenanceDeps = {
      distillDeps: { distill: async () => [], consolidate: async () => ({ applied: [] }) },
      decayDeps: { listActive: async () => [], invalidate: async () => undefined },
      recordDecay: async (record) => {
        records.push(record)
      },
    }
    await runMemoryMaintenance(
      { transcript, scope: "global", provenance: "user", config: cfg({ maxIdleDays: 30 }) },
      deps
    )
    expect(records).toEqual([])
  })

  it("stays functional when no recordDecay dep is wired", async () => {
    const invalidated: string[] = []
    const deps: MemoryMaintenanceDeps = {
      distillDeps: { distill: async () => [], consolidate: async () => ({ applied: [] }) },
      decayDeps: {
        listActive: async () => [mem({ id: "a", importance: 1 }), mem({ id: "b", importance: 9 })],
        invalidate: async (id) => {
          invalidated.push(id)
        },
      },
    }
    await runMemoryMaintenance(
      { transcript, scope: "global", provenance: "user", config: cfg({ maxActivePerScope: 1 }) },
      deps
    )
    expect(invalidated).toEqual(["a"])
  })

  it("evicts global-scope overflow even when the session carries a characterId", async () => {
    // Regression: global memories are stored with characterId: undefined, so a
    // realistic listActive (mirroring listMemories) honors the characterId
    // filter. Before the fix, maintenance passed the session's characterId into
    // decay while the scope was global → the filter matched nothing → eviction
    // silently no-oped and the per-scope cap was never enforced.
    const invalidated: string[] = []
    const globalRows = [
      mem({ id: "a", scope: "global", importance: 1, lastAccessedAt: 1 }),
      mem({ id: "b", scope: "global", importance: 9 }),
    ]
    const deps: MemoryMaintenanceDeps = {
      distillDeps: { distill: async () => [], consolidate: async () => ({ applied: [] }) },
      decayDeps: {
        listActive: async (scope, namespace) =>
          globalRows.filter((m) => m.scope === scope && m.characterId === namespace?.characterId),
        invalidate: async (id) => {
          invalidated.push(id)
        },
      },
    }
    await runMemoryMaintenance(
      {
        transcript,
        scope: "global",
        characterId: "char-1", // a session bound to a character
        provenance: "user",
        config: cfg({ maxActivePerScope: 1 }),
      },
      deps
    )
    expect(invalidated).toEqual(["a"]) // lowest-scored evicted to reach cap 1
  })

  it("scopes decay to the character id for character-scope maintenance", async () => {
    const invalidated: string[] = []
    const rows = [
      mem({ id: "g", scope: "global", importance: 1, lastAccessedAt: 1 }),
      mem({
        id: "c1",
        scope: "character",
        characterId: "char-1",
        importance: 1,
        lastAccessedAt: 1,
      }),
      mem({ id: "c2", scope: "character", characterId: "char-1", importance: 9 }),
    ]
    const deps: MemoryMaintenanceDeps = {
      distillDeps: { distill: async () => [], consolidate: async () => ({ applied: [] }) },
      decayDeps: {
        listActive: async (scope, namespace) =>
          rows.filter((m) => m.scope === scope && m.characterId === namespace?.characterId),
        invalidate: async (id) => {
          invalidated.push(id)
        },
      },
    }
    await runMemoryMaintenance(
      {
        transcript,
        scope: "character",
        characterId: "char-1",
        provenance: "user",
        config: cfg({ maxActivePerScope: 1 }),
      },
      deps
    )
    expect(invalidated).toEqual(["c1"]) // only the character's overflow is touched
  })

  it("isolates workspace decay by the complete project namespace", async () => {
    const seen: unknown[] = []
    const deps: MemoryMaintenanceDeps = {
      distillDeps: { distill: async () => [], consolidate: async () => ({ applied: [] }) },
      decayDeps: {
        listActive: async (_scope, namespace) => {
          seen.push(namespace)
          return []
        },
        invalidate: async () => undefined,
      },
    }

    await runMemoryMaintenance(
      {
        transcript,
        scope: "workspace",
        projectId: "project-1",
        branch: "feature/memory",
        pathPattern: "lib/memory",
        provenance: "user",
        config: cfg(),
      },
      deps
    )

    expect(seen).toEqual([
      {
        characterId: undefined,
        projectId: "project-1",
        agentId: undefined,
        branch: "feature/memory",
        pathPattern: "lib/memory",
      },
    ])
  })

  it("expires stale non-pinned memories when maxIdleDays is set (access-time forgetting)", async () => {
    const NOW = 1_700_000_000_000
    const DAY = 24 * 60 * 60 * 1000
    const invalidated: string[] = []
    const deps: MemoryMaintenanceDeps = {
      distillDeps: {
        distill: async () => [],
        consolidate: async () => ({ applied: [] }),
      },
      decayDeps: {
        listActive: async () => [
          mem({ id: "fresh", lastAccessedAt: NOW }),
          mem({ id: "stale", lastAccessedAt: NOW - 40 * DAY }),
          mem({ id: "pinned-stale", pinned: true, lastAccessedAt: NOW - 99 * DAY }),
        ],
        invalidate: async (id) => {
          invalidated.push(id)
        },
      },
    }
    await runMemoryMaintenance(
      {
        transcript,
        scope: "global",
        provenance: "user",
        // High cap → no overflow eviction; isolate expireStale.
        config: cfg({ maxActivePerScope: 9999, maxIdleDays: 30 }),
        now: NOW,
      },
      deps
    )
    expect(invalidated).toContain("stale")
    expect(invalidated).not.toContain("fresh")
    expect(invalidated).not.toContain("pinned-stale")
  })

  it("does not expire anything when maxIdleDays is 0 (default)", async () => {
    const invalidated: string[] = []
    const deps: MemoryMaintenanceDeps = {
      distillDeps: { distill: async () => [], consolidate: async () => ({ applied: [] }) },
      decayDeps: {
        listActive: async () => [mem({ id: "old", lastAccessedAt: 1 })],
        invalidate: async (id) => {
          invalidated.push(id)
        },
      },
    }
    await runMemoryMaintenance(
      { transcript, scope: "global", provenance: "user", config: cfg({ maxActivePerScope: 9999 }) },
      deps
    )
    expect(invalidated).toEqual([])
  })
})

describe("scheduleMemoryMaintenance", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEnqueueJob.mockReset()
    mockClaimJob.mockReset()
    mockCompleteJob.mockReset()
    mockFailJob.mockReset()
    mockDrainAfterTurn.mockReset()
    mockDrainAfterTurn.mockResolvedValue(1)
    __resetMaintenanceGuard()
    jest.useFakeTimers()
    mockBuildDeps.mockResolvedValue({
      distillDeps: { distill: async () => [], consolidate: async () => ({ applied: [] }) },
      decayDeps: { listActive: async () => [], invalidate: async () => {} },
    })
    mockEnqueueJob.mockResolvedValue({ id: "job-1" })
    mockClaimJob.mockResolvedValueOnce({ id: "job-1" })
    mockCompleteJob.mockResolvedValue(undefined)
    mockFailJob.mockResolvedValue("queued")
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
    scheduleMemoryMaintenance({ ...base, config: cfg({ learnFromChats: false }) })
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

  it("queues a maintenance pass and asks the drain to pick it up on idle", async () => {
    scheduleMemoryMaintenance({ ...base, config: cfg() })
    await jest.runAllTimersAsync()
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "session-distill" }),
      { reuseCompleted: true }
    )
    expect(mockDrainAfterTurn).toHaveBeenCalledTimes(1)
  })

  it("dedupes a repeated schedule onto one durable job", async () => {
    // The guard is the durable dedupe key, not process-local state, so a second
    // schedule for the same transcript resolves to the same queued row.
    scheduleMemoryMaintenance({ ...base, config: cfg() })
    scheduleMemoryMaintenance({ ...base, config: cfg() })
    await jest.runAllTimersAsync()
    const distillKeys = mockEnqueueJob.mock.calls
      .map(([draft]) => draft as { kind: string; dedupeKey: string })
      .filter((draft) => draft.kind === "session-distill")
      .map((draft) => draft.dedupeKey)
    expect(distillKeys).toHaveLength(2)
    expect(new Set(distillKeys).size).toBe(1)
  })

  // Distillation itself is the worker's job now, so the scheduler no longer
  // builds deps, claims the row it just queued, or reports its outcome.
  it("never claims the job it queued", async () => {
    scheduleMemoryMaintenance({ ...base, config: cfg() })
    await jest.runAllTimersAsync()
    expect(mockClaimJob).not.toHaveBeenCalled()
    expect(mockCompleteJob).not.toHaveBeenCalled()
    expect(mockFailJob).not.toHaveBeenCalled()
  })

  it("arms the claim re-check backstop only when mining is on", async () => {
    scheduleMemoryMaintenance({ ...base, config: cfg() })
    await jest.runAllTimersAsync()
    expect(
      mockEnqueueJob.mock.calls.filter(([draft]) => draft.kind === "project-claim-revalidate")
    ).toHaveLength(1)

    jest.clearAllMocks()
    mockEnqueueJob.mockResolvedValue({ id: "job-1" })
    mockClaimJob.mockResolvedValueOnce({ id: "job-1" })
    __resetMaintenanceGuard()
    scheduleMemoryMaintenance({
      ...base,
      sessionId: "s2",
      config: cfg({ mineProjectContext: false }),
    })
    await jest.runAllTimersAsync()
    expect(
      mockEnqueueJob.mock.calls.filter(([draft]) => draft.kind === "project-claim-revalidate")
    ).toEqual([])
  })

  it("flushes the trailing mining window that the live turn path held back", async () => {
    // 26 salient messages: the live path queues the closed windows, this queues
    // the last one — without it a session that simply stops is never mined.
    const projectTranscript = Array.from({ length: 26 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text:
        index % 2 === 0
          ? "why does pnpm build fail in packages/memory/src/index.ts"
          : "it must be in SERVER_ONLY_PACKAGES, because the static export breaks otherwise",
    }))
    scheduleMemoryMaintenance({
      ...base,
      session: { id: "s1", projectId: "p1", transcriptRevision: 5 } as never,
      transcript: projectTranscript,
      config: cfg(),
    })
    await jest.runAllTimersAsync()

    const mining = mockEnqueueJob.mock.calls
      .map(([draft]) => draft)
      .filter((draft) => draft.kind === "project-mining")
    expect(mining.length).toBeGreaterThan(0)
    expect(mining.some((draft) => draft.checkpoint.lastMessageId === "m25")).toBe(true)
  })

  it("does not queue mining for a session with no workspace", async () => {
    scheduleMemoryMaintenance({ ...base, config: cfg() })
    await jest.runAllTimersAsync()
    expect(mockEnqueueJob.mock.calls.filter(([draft]) => draft.kind === "project-mining")).toEqual(
      []
    )
  })

  it("pins the distill job to a message-id checkpoint when the transcript carries ids", async () => {
    const withIds = transcript.map((entry, index) => ({ ...entry, id: `m${index + 1}` }))
    scheduleMemoryMaintenance({
      ...base,
      session: { id: "s1", transcriptRevision: 3 } as never,
      transcript: withIds,
      config: cfg(),
    })
    await jest.runAllTimersAsync()
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "session-distill",
        dedupeKey: `session-distill:s1:m${withIds.length}:${withIds.length}`,
        checkpoint: {
          transcriptRevision: 3,
          firstMessageId: "m1",
          lastMessageId: `m${withIds.length}`,
          messageCount: withIds.length,
        },
      }),
      { reuseCompleted: true }
    )
  })

  it("keeps the legacy `session-distill:<session>:<count>` key without ids", async () => {
    // Distillation ships a different fallback shape than turn extraction. A
    // shared shape would orphan every in-flight job of one of the two kinds.
    scheduleMemoryMaintenance({ ...base, config: cfg() })
    await jest.runAllTimersAsync()
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: `session-distill:s1:${transcript.length}`,
        checkpoint: undefined,
      }),
      { reuseCompleted: true }
    )
  })

  it("enqueues the durable session-distill job with a checkpointed identity", async () => {
    scheduleMemoryMaintenance({ ...base, config: cfg() })
    await jest.runAllTimersAsync()
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "session-distill",
        dedupeKey: expect.stringMatching(/^session-distill:s1:\d+$/),
      }),
      { reuseCompleted: true }
    )
  })

  it("piggybacks a day-bucketed vector-reconcile enqueue on the maintenance tick", async () => {
    scheduleMemoryMaintenance({ ...base, config: cfg() })
    await jest.runAllTimersAsync()
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "vector-reconcile",
        dedupeKey: expect.stringMatching(/^vector-reconcile:\d{4}-\d{2}-\d{2}$/),
      }),
      { reuseCompleted: true }
    )
  })
})
