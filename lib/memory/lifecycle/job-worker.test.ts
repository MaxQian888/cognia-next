import type { MemoryJob } from "@/types/memory/governance"

const mockGetSettings = jest.fn()
const mockGetSession = jest.fn()
const mockListMessages = jest.fn()
const mockAppendAudit = jest.fn()
const mockCreateEvidence = jest.fn()
const mockListMemories = jest.fn()
const mockUpdateMemory = jest.fn()
const mockBuildExtractionDeps = jest.fn()
const mockRunExtraction = jest.fn()
const mockBuildMaintenanceDeps = jest.fn()
const mockRunMaintenance = jest.fn()
const mockTryBuildVectorSink = jest.fn()

jest.mock("@/lib/db/settings", () => ({ getSettings: () => mockGetSettings() }))
jest.mock("@/lib/db/sessions", () => ({ getSession: () => mockGetSession() }))
jest.mock("@/lib/db/messages", () => ({ listMessages: () => mockListMessages() }))
jest.mock("@/lib/db/memory-governance", () => ({
  appendMemoryAuditEvent: (...args: unknown[]) => mockAppendAudit(...args),
  claimNextMemoryJob: jest.fn(),
  completeMemoryJob: jest.fn(),
  createMemoryEvidence: (...args: unknown[]) => mockCreateEvidence(...args),
  failMemoryJob: jest.fn(),
}))
jest.mock("@/lib/db/memories", () => ({
  listMemories: (...args: unknown[]) => mockListMemories(...args),
  updateMemory: (...args: unknown[]) => mockUpdateMemory(...args),
}))
jest.mock("@/lib/memory/write/run-memory-extraction", () => ({
  buildAutoExtractionDeps: (...args: unknown[]) => mockBuildExtractionDeps(...args),
  runMemoryExtraction: (...args: unknown[]) => mockRunExtraction(...args),
}))
jest.mock("@/lib/memory/lifecycle/build-maintenance-deps", () => ({
  buildEpisodicMaintenanceDeps: (...args: unknown[]) => mockBuildMaintenanceDeps(...args),
}))
jest.mock("@/lib/memory/lifecycle/maintenance", () => ({
  runMemoryMaintenance: (...args: unknown[]) => mockRunMaintenance(...args),
}))
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryVectorSink: (...args: unknown[]) => mockTryBuildVectorSink(...args),
}))

import {
  drainMemoryJobs,
  processMemoryJob,
  startMemoryJobWorker,
  type MemoryJobWorkerDeps,
} from "./job-worker"

function job(id: string): MemoryJob {
  return {
    id,
    dedupeKey: "turn-extraction:s1:turn:2",
    kind: "turn-extraction",
    status: "running",
    scope: "global",
    provenance: "user",
    evidenceIds: [],
    queuedAt: 1,
    retryCount: 0,
  }
}

function deps(
  queue: MemoryJob[],
  process: MemoryJobWorkerDeps["process"] = jest.fn(async () => undefined)
): MemoryJobWorkerDeps {
  return {
    claimNext: jest.fn(async () => queue.shift()),
    complete: jest.fn(async () => undefined),
    fail: jest.fn(async () => "queued"),
    process,
  }
}

describe("memory job worker", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, learnFromChats: true } })
    mockGetSession.mockResolvedValue({ id: "s1", projectId: "p1" })
    mockListMessages.mockResolvedValue([
      { role: "user", parts: [{ type: "text", text: "I always use pnpm" }] },
      { role: "assistant", parts: [{ type: "text", text: "Noted." }] },
    ])
    mockBuildExtractionDeps.mockResolvedValue({ consolidate: jest.fn() })
    mockRunExtraction.mockResolvedValue({
      applied: [
        {
          op: "ADD",
          memory: { id: "m1" },
          candidate: { type: "semantic", text: "Uses pnpm", importance: 5 },
        },
      ],
    })
    mockBuildMaintenanceDeps.mockResolvedValue({})
    mockRunMaintenance.mockResolvedValue(undefined)
    mockAppendAudit.mockResolvedValue({})
    mockCreateEvidence.mockResolvedValue({})
    mockUpdateMemory.mockResolvedValue(undefined)
  })

  it("drains eligible jobs serially and completes them", async () => {
    const d = deps([job("a"), job("b")])
    await expect(drainMemoryJobs({ workerId: "test" }, d)).resolves.toBe(2)
    expect(d.process).toHaveBeenCalledTimes(2)
    expect(d.complete).toHaveBeenCalledWith("a")
    expect(d.complete).toHaveBeenCalledWith("b")
  })

  it("fails a job and continues draining later work", async () => {
    const process = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined)
    const d = deps([job("a"), job("b")], process)
    await drainMemoryJobs({}, d)
    expect(d.fail).toHaveBeenCalledWith("a", "memory_job_processing_failed")
    expect(d.complete).toHaveBeenCalledWith("b")
  })

  it("starts immediately and returns a teardown for the periodic timer", async () => {
    jest.useFakeTimers()
    const d = deps([])
    const stop = startMemoryJobWorker({ deps: d, intervalMs: 1_000 })
    await Promise.resolve()
    expect(d.claimNext).toHaveBeenCalled()
    stop()
    jest.useRealTimers()
  })

  it("reconstructs and processes turn-extraction work after a restart", async () => {
    mockListMessages.mockResolvedValue([
      { id: "u1", role: "user", parts: [{ type: "text", text: "I always use pnpm" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Noted." }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "My newer preference is npm" }] },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "Updated." }] },
    ])
    await processMemoryJob({ ...job("turn"), sessionId: "s1", projectId: "p1" })
    expect(mockRunExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        newPair: { userText: "I always use pnpm", assistantText: "Noted." },
        recentMessages: [
          { id: "u1", role: "user", text: "I always use pnpm", parts: expect.any(Array) },
          { id: "a1", role: "assistant", text: "Noted.", parts: expect.any(Array) },
        ],
        projectId: "p1",
        // Recovery must re-stamp the assistant message id so chat chips still
        // attribute recovered learnings to the originating reply.
        source: { sessionId: "s1", messageId: "a1" },
      }),
      expect.anything()
    )
    expect(mockUpdateMemory).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ evidenceState: "supported" })
    )
    expect(mockCreateEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: "m1", kind: "checkpoint" })
    )
  })

  it("processes session distillation and vector reconciliation jobs", async () => {
    await processMemoryJob({
      ...job("distill"),
      dedupeKey: "session-distill:s1:2",
      kind: "session-distill",
      sessionId: "s1",
      projectId: "p1",
    })
    expect(mockRunMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { sessionId: "s1" },
        projectId: "p1",
        transcript: [
          { role: "user", text: "I always use pnpm", parts: expect.any(Array) },
          { role: "assistant", text: "Noted.", parts: expect.any(Array) },
        ],
      }),
      {}
    )

    const upsert = jest.fn(async () => undefined)
    mockTryBuildVectorSink.mockResolvedValue({ upsert })
    mockListMemories.mockResolvedValue([
      { id: "safe", text: "Uses pnpm" },
      { id: "unsafe", text: "Email bob@example.com" },
      { id: "done", text: "Already indexed", vectorDocId: "done" },
    ])
    await processMemoryJob({ ...job("vector"), kind: "vector-reconcile" })
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenCalledWith("safe", "Uses pnpm")
    expect(mockUpdateMemory).toHaveBeenCalledWith("safe", { vectorDocId: "safe" })
  })

  it("backs off when the durable transcript checkpoint is unavailable", async () => {
    const d = deps([{ ...job("missing"), sessionId: "s1", dedupeKey: "invalid" }], processMemoryJob)
    await drainMemoryJobs({}, d)
    expect(d.fail).toHaveBeenCalledWith("missing", "transcript_checkpoint_unavailable")
  })
})
