import {
  computeMemoryCorpusInsights,
  estimateRecallBudget,
  summarizeMemoryJobs,
  summarizeMemoryMaintenance,
  INSTRUMENTED_MAINTENANCE_REASONS,
  MEMORY_PII_BLOCK_REASON,
} from "./insights"
import type { Memory } from "@/types/memory/memory"
import type { MemoryAuditEvent, MemoryJob } from "@/types/memory/governance"

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const WINDOW_START = NOW - 7 * DAY

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem_${Math.random().toString(36).slice(2)}`,
    scope: "global",
    type: "semantic",
    text: "the user prefers pnpm",
    tags: [],
    importance: 7,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    lastAccessedAt: NOW - DAY,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...overrides,
  }
}

function job(overrides: Partial<MemoryJob> = {}): MemoryJob {
  return {
    id: `mjob_${Math.random().toString(36).slice(2)}`,
    dedupeKey: "k",
    kind: "turn-extraction",
    status: "queued",
    scope: "global",
    provenance: "user",
    evidenceIds: [],
    queuedAt: NOW,
    retryCount: 0,
    ...overrides,
  }
}

function auditEvent(overrides: Partial<MemoryAuditEvent> = {}): MemoryAuditEvent {
  return {
    id: `mau_${Math.random().toString(36).slice(2)}`,
    action: "invalidated",
    reason: "idle",
    createdAt: NOW - DAY,
    ...overrides,
  }
}

describe("computeMemoryCorpusInsights", () => {
  it("counts active rows per scope and ignores invalidated ones", () => {
    const result = computeMemoryCorpusInsights([
      memory({ scope: "global" }),
      memory({ scope: "global" }),
      memory({ scope: "workspace" }),
      memory({ scope: "character" }),
      memory({ scope: "agent" }),
      memory({ scope: "global", status: "invalidated" }),
    ])

    expect(result.byScope).toEqual({ global: 2, workspace: 1, character: 1, agent: 1 })
    expect(result.stats.active).toBe(5)
    expect(result.stats.total).toBe(6)
  })

  it("reports vector coverage as embedded-over-active", () => {
    const result = computeMemoryCorpusInsights([
      memory({ vectorDocId: "v1" }),
      memory({ vectorDocId: "v2" }),
      memory(),
      memory(),
      // Invalidated rows count for neither numerator nor denominator.
      memory({ status: "invalidated", vectorDocId: "v3" }),
    ])

    expect(result.vector).toEqual({ embedded: 2, active: 4, coverage: 0.5 })
  })

  it("returns zeroes rather than NaN for an empty corpus", () => {
    const result = computeMemoryCorpusInsights([])
    expect(result.vector.coverage).toBe(0)
    expect(result.averageTokens).toBe(0)
  })

  it("estimates average tokens over the same `- text` framing the packer uses", () => {
    // estimateTokens = ceil(len / 4); "- " + 14 chars = 16 chars => 4 tokens.
    const result = computeMemoryCorpusInsights([memory({ text: "abcdefghijklmn" })])
    expect(result.averageTokens).toBe(4)
  })
})

describe("estimateRecallBudget", () => {
  it("caps the line count at what actually exists", () => {
    const result = estimateRecallBudget({
      averageTokens: 60,
      activeCount: 3,
      topK: 8,
      tokenBudget: 900,
    })
    expect(result.lines).toBe(3)
    expect(result.estimatedTokens).toBe(180)
    expect(result.overBudget).toBe(false)
  })

  it("clamps fill to 1 and flags over-budget", () => {
    const result = estimateRecallBudget({
      averageTokens: 200,
      activeCount: 50,
      topK: 8,
      tokenBudget: 900,
    })
    expect(result.estimatedTokens).toBe(1600)
    expect(result.fill).toBe(1)
    expect(result.overBudget).toBe(true)
  })

  it("does not divide by zero when the budget is zero", () => {
    const result = estimateRecallBudget({
      averageTokens: 60,
      activeCount: 5,
      topK: 5,
      tokenBudget: 0,
    })
    expect(Number.isFinite(result.fill)).toBe(true)
    expect(result.fill).toBe(1)
  })
})

describe("summarizeMemoryJobs", () => {
  it("separates a first-attempt queue from a retrying one", () => {
    const [turn] = summarizeMemoryJobs([
      job({ kind: "turn-extraction", status: "queued", retryCount: 0 }),
      job({ kind: "turn-extraction", status: "queued", retryCount: 2, errorCode: "boom" }),
    ])
    expect(turn).toMatchObject({ kind: "turn-extraction", queued: 1, retrying: 1, failed: 0 })
  })

  it("keeps the newest completion timestamp per kind", () => {
    const summaries = summarizeMemoryJobs([
      job({ kind: "session-distill", status: "completed", completedAt: NOW - 5000 }),
      job({ kind: "session-distill", status: "completed", completedAt: NOW - 100 }),
    ])
    const distill = summaries.find((s) => s.kind === "session-distill")
    expect(distill?.lastCompletedAt).toBe(NOW - 100)
  })

  it("always reports all three kinds, even with no rows", () => {
    expect(summarizeMemoryJobs([]).map((s) => s.kind)).toEqual([
      "turn-extraction",
      "session-distill",
      "vector-reconcile",
    ])
  })

  it("surfaces the error code of an exhausted job", () => {
    const summaries = summarizeMemoryJobs([
      job({ kind: "vector-reconcile", status: "failed", retryCount: 4, errorCode: "no_backend" }),
    ])
    const reconcile = summaries.find((s) => s.kind === "vector-reconcile")
    expect(reconcile).toMatchObject({ failed: 1, lastErrorCode: "no_backend" })
  })
})

describe("summarizeMemoryMaintenance", () => {
  it("falls back to the heuristic when nothing was ever instrumented", () => {
    const result = summarizeMemoryMaintenance({
      events: [],
      memories: [
        memory({ status: "invalidated", invalidatedAt: NOW - DAY }),
        memory({ status: "invalidated", invalidatedAt: NOW - 2 * DAY }),
        // Superseded by consolidation — not a decay retirement.
        memory({ status: "invalidated", invalidatedAt: NOW - DAY, supersededById: "mem_x" }),
        // Outside the window.
        memory({ status: "invalidated", invalidatedAt: NOW - 30 * DAY }),
      ],
      windowStart: WINDOW_START,
      preciseSince: undefined,
    })

    expect(result.accounting).toEqual({ kind: "estimated" })
    expect(result.autoInvalidated).toBe(2)
    // The heuristic cannot attribute, so it must not pretend to.
    expect(result).toMatchObject({ idle: 0, capacity: 0 })
  })

  it("reports an exact split once instrumentation predates the window", () => {
    const result = summarizeMemoryMaintenance({
      events: [
        auditEvent({ reason: "idle" }),
        auditEvent({ reason: "idle" }),
        auditEvent({ reason: "capacity" }),
        auditEvent({ action: "learn-denied", reason: MEMORY_PII_BLOCK_REASON }),
        // Outside the window — ignored.
        auditEvent({ reason: "idle", createdAt: WINDOW_START - DAY }),
        // Unrelated action with a decay-shaped reason must not be counted.
        auditEvent({ action: "created", reason: "session_distillation" }),
      ],
      memories: [],
      windowStart: WINDOW_START,
      preciseSince: WINDOW_START - 30 * DAY,
    })

    expect(result.accounting).toEqual({ kind: "exact" })
    expect(result).toMatchObject({ idle: 2, capacity: 1, piiBlocked: 1, autoInvalidated: 3 })
  })

  it("attributes what it can and counts the rest when instrumentation starts mid-window", () => {
    const preciseSince = NOW - 3 * DAY
    const result = summarizeMemoryMaintenance({
      events: [auditEvent({ reason: "idle", createdAt: NOW - DAY })],
      memories: [
        memory({ status: "invalidated", invalidatedAt: NOW - DAY }),
        memory({ status: "invalidated", invalidatedAt: NOW - 5 * DAY }),
        memory({ status: "invalidated", invalidatedAt: NOW - 6 * DAY }),
      ],
      windowStart: WINDOW_START,
      preciseSince,
    })

    expect(result.accounting).toEqual({ kind: "partial", preciseSince, unattributed: 2 })
    expect(result).toMatchObject({ idle: 1, capacity: 0, autoInvalidated: 3 })
  })

  it("never reports negative unattributed rows when the heuristic undercounts", () => {
    const result = summarizeMemoryMaintenance({
      events: [auditEvent({ reason: "idle" }), auditEvent({ reason: "capacity" })],
      memories: [],
      windowStart: WINDOW_START,
      preciseSince: NOW - DAY,
    })
    expect(result.accounting).toMatchObject({ kind: "partial", unattributed: 0 })
    expect(result.autoInvalidated).toBe(2)
  })
})

describe("instrumentation reason constants", () => {
  it("matches the literals the writers emit", () => {
    // `build-maintenance-deps` passes MemoryDecayRecord["reason"] straight through
    // and `store-memory` writes the PII literal; drift here silently empties the
    // maintenance panel, so pin the exact strings.
    expect([...INSTRUMENTED_MAINTENANCE_REASONS]).toEqual(["idle", "capacity", "pii_blocked"])
    expect(MEMORY_PII_BLOCK_REASON).toBe("pii_blocked")
  })
})
