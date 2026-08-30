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
const mockBuildMiningDeps = jest.fn()
const mockRunMining = jest.fn()
const mockGetProject = jest.fn()

jest.mock("@/lib/db/settings", () => ({ getSettings: () => mockGetSettings() }))
jest.mock("@/lib/db/sessions", () => ({ getSession: () => mockGetSession() }))
jest.mock("@/lib/db/characters", () => ({
  resolveCharacterById: jest.fn(async () => undefined),
}))
jest.mock("@/lib/db/messages", () => ({ listMessages: () => mockListMessages() }))
jest.mock("@/lib/db/memory-governance", () => ({
  appendMemoryAuditEvent: (...args: unknown[]) => mockAppendAudit(...args),
  claimNextMemoryJob: jest.fn(),
  finishMemoryJob: jest.fn(),
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
jest.mock("@/lib/memory/write/run-project-mining", () => ({
  buildProjectMiningDeps: (...args: unknown[]) => mockBuildMiningDeps(...args),
  runProjectMining: (...args: unknown[]) => mockRunMining(...args),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ projects: { get: (...args: unknown[]) => mockGetProject(...args) } }),
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
  process: MemoryJobWorkerDeps["process"] = jest.fn(async () => ({
    status: "succeeded" as const,
    resultCode: "done",
  }))
): MemoryJobWorkerDeps {
  return {
    claimNext: jest.fn(async () => queue.shift()),
    finish: jest.fn(async () => undefined),
    fail: jest.fn(async () => "queued"),
    process,
  }
}

describe("memory job worker", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, learnFromChats: true } })
    mockGetSession.mockResolvedValue({ id: "s1", projectId: "p1" })
    mockGetProject.mockResolvedValue({ id: "p1", name: "Cognia", roots: [] })
    mockBuildMiningDeps.mockResolvedValue({ extract: jest.fn(), consolidate: jest.fn() })
    mockRunMining.mockResolvedValue({ applied: [] })
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
    expect(d.finish).toHaveBeenCalledWith("a", { status: "succeeded", resultCode: "done" })
    expect(d.finish).toHaveBeenCalledWith("b", { status: "succeeded", resultCode: "done" })
  })

  it("fails a job and continues draining later work", async () => {
    const process = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: "succeeded", resultCode: "done" })
    const d = deps([job("a"), job("b")], process)
    await drainMemoryJobs({}, d)
    expect(d.fail).toHaveBeenCalledWith("a", "memory_job_processing_failed")
    expect(d.finish).toHaveBeenCalledWith("b", { status: "succeeded", resultCode: "done" })
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

  it("vector-reconcile heals backend-missing docs and sweeps orphans when the sink can list", async () => {
    const upsert = jest.fn(async () => undefined)
    const del = jest.fn(async () => undefined)
    // Backend holds: "done" (healthy), "orphan" (no active row points at it).
    // It is missing "lost", which an active row claims to have indexed.
    const listIds = jest.fn(async () => ["done", "orphan"])
    mockTryBuildVectorSink.mockResolvedValue({ upsert, delete: del, listIds })
    mockListMemories.mockResolvedValue([
      { id: "done", text: "Already indexed", vectorDocId: "done" },
      { id: "lost", text: "Backend lost me", vectorDocId: "lost" },
      { id: "fresh", text: "Never indexed" },
    ])
    await processMemoryJob({ ...job("vector"), kind: "vector-reconcile" })
    // "lost" re-upserted under its existing doc id; "fresh" indexed anew.
    expect(upsert).toHaveBeenCalledWith("lost", "Backend lost me")
    expect(upsert).toHaveBeenCalledWith("fresh", "Never indexed")
    expect(mockUpdateMemory).toHaveBeenCalledWith("fresh", { vectorDocId: "fresh" })
    // Only the orphan is swept.
    expect(del).toHaveBeenCalledWith(["orphan"])
  })

  describe("project mining dispatch", () => {
    const mined = [
      {
        id: "m1",
        role: "user",
        metadata: { createdAt: 1_000 },
        parts: [{ type: "text", text: "why does the build break" }],
      },
      {
        id: "m2",
        role: "assistant",
        metadata: { createdAt: 2_000 },
        parts: [{ type: "text", text: "pnpm requires SERVER_ONLY_PACKAGES" }],
      },
    ]

    function miningJob(overrides: Partial<MemoryJob> = {}): MemoryJob {
      return {
        ...job("mine"),
        dedupeKey: "project-mining:s1:m1:m2:2",
        kind: "project-mining",
        sessionId: "s1",
        projectId: "p1",
        scope: "workspace",
        checkpoint: {
          transcriptRevision: 1,
          firstMessageId: "m1",
          lastMessageId: "m2",
          messageCount: 2,
        },
        ...overrides,
      }
    }

    it("routes a project-mining job to the miner, not to the vector reconciler", async () => {
      mockListMessages.mockResolvedValue(mined)
      await processMemoryJob(miningJob())
      expect(mockRunMining).toHaveBeenCalledTimes(1)
      expect(mockTryBuildVectorSink).not.toHaveBeenCalled()
    })

    it("carries real source timestamps through so claims can date their evidence", async () => {
      mockListMessages.mockResolvedValue(mined)
      await processMemoryJob(miningJob())
      expect(mockRunMining).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          scope: "workspace",
          messages: [
            expect.objectContaining({ id: "m1", createdAt: 1_000 }),
            expect.objectContaining({ id: "m2", createdAt: 2_000 }),
          ],
        }),
        expect.anything()
      )
    })

    it("writes one evidence row per citation, anchored to the source message", async () => {
      mockListMessages.mockResolvedValue(mined)
      mockRunMining.mockResolvedValue({
        applied: [
          {
            op: "QUARANTINE",
            memory: { id: "mem1" },
            reason: "judge_unavailable",
            candidate: {
              type: "semantic",
              text: "The build needs SERVER_ONLY_PACKAGES.",
              importance: 7,
              projectClaim: {
                projectMemoryKind: "constraint",
                evidence: [
                  { kind: "message", sourceId: "m2" },
                  { kind: "tool-result", sourceId: "m2:3" },
                  { kind: "code-location", sourceId: "next.config.ts" },
                ],
              },
            },
          },
        ],
        redactedExcerpts: new Map([["m2", "redacted body"]]),
      })
      await processMemoryJob(miningJob())

      const kinds = mockCreateEvidence.mock.calls.map(([row]) => row.kind)
      expect(kinds).toEqual(["message", "tool-result", "code-location"])

      const [messageRow] = mockCreateEvidence.mock.calls[0]!
      expect(messageRow).toMatchObject({
        memoryId: "mem1",
        // The messageId is what lets deleting a source message find and revoke
        // the claims that depended on it.
        messageId: "m2",
        sourceRole: "assistant",
        validationStrategy: "message-presence",
      })
      expect(messageRow.excerptHash).toEqual(expect.any(String))

      // A tool citation points at a part of a message, so the anchor is the
      // message id ahead of the colon.
      expect(mockCreateEvidence.mock.calls[1]![0]).toMatchObject({
        messageId: "m2",
        validationStrategy: "tool-result-hash",
      })

      // `code-location` is deliberately dormant: recorded, never validated,
      // contributing no support until a batched native stat exists.
      expect(mockCreateEvidence.mock.calls[2]![0]).toMatchObject({
        messageId: undefined,
        validationStrategy: "none",
      })
    })

    it("reports the miner's skip reason instead of a generic empty result", async () => {
      mockListMessages.mockResolvedValue(mined)
      mockRunMining.mockResolvedValue({ applied: [], skipReason: "not_salient" })
      await expect(processMemoryJob(miningJob())).resolves.toEqual({
        status: "no_output",
        resultCode: "not_salient",
      })
    })

    it("skips — never retries — a mining job with no workspace to mine for", async () => {
      mockListMessages.mockResolvedValue(mined)
      mockGetSession.mockResolvedValue({ id: "s1" })
      const d = deps([miningJob({ projectId: undefined })], processMemoryJob)
      await expect(drainMemoryJobs({}, d)).resolves.toBe(1)
      expect(d.finish).toHaveBeenCalledWith("mine", {
        status: "skipped",
        resultCode: "project_missing",
      })
    })

    it("does not silently run the reconciler for an unimplemented kind", async () => {
      // The dispatch used to fall through to `processVectorReconcile`, so any
      // new kind quietly did the wrong work. It now says so instead.
      await expect(
        processMemoryJob({ ...job("reval"), kind: "project-claim-revalidate" })
      ).resolves.toEqual({
        status: "skipped",
        resultCode: "revalidation_not_implemented",
      })
      expect(mockTryBuildVectorSink).not.toHaveBeenCalled()
    })
  })

  describe("transcript window recovery", () => {
    const windowed = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "I always use pnpm" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "Noted." }] },
      { id: "m3", role: "user", parts: [{ type: "text", text: "and turbo" }] },
    ]

    it("replays the checkpointed id window instead of a prefix of the live transcript", async () => {
      mockListMessages.mockResolvedValue(windowed)
      mockGetSession.mockResolvedValue({ id: "s1", projectId: "p1", transcriptRevision: 4 })
      await processMemoryJob({
        ...job("windowed"),
        dedupeKey: "session-distill:s1:m2:2",
        kind: "session-distill",
        sessionId: "s1",
        checkpoint: {
          transcriptRevision: 4,
          firstMessageId: "m1",
          lastMessageId: "m2",
          messageCount: 2,
        },
      })
      expect(mockRunMaintenance).toHaveBeenCalledWith(
        expect.objectContaining({
          transcript: [
            { id: "m1", role: "user", text: "I always use pnpm", parts: expect.any(Array) },
            { id: "m2", role: "assistant", text: "Noted.", parts: expect.any(Array) },
          ],
        }),
        {}
      )
    })

    it("flags a revision that advanced while the window verified intact", async () => {
      mockListMessages.mockResolvedValue(windowed)
      mockGetSession.mockResolvedValue({ id: "s1", projectId: "p1", transcriptRevision: 9 })
      const outcome = await processMemoryJob({
        ...job("drifted"),
        dedupeKey: "session-distill:s1:m2:2",
        kind: "session-distill",
        sessionId: "s1",
        checkpoint: {
          transcriptRevision: 4,
          firstMessageId: "m1",
          lastMessageId: "m2",
          messageCount: 2,
        },
      })
      expect(outcome).toEqual({
        status: "succeeded",
        resultCode: "maintenance_completed:revision_advanced_window_intact",
      })
    })

    it("skips — never retries — a job whose window messages were deleted", async () => {
      // The messages are gone; replay can never succeed, so burning the retry
      // budget on it is pure waste.
      mockListMessages.mockResolvedValue(windowed)
      const d = deps(
        [
          {
            ...job("gone"),
            dedupeKey: "session-distill:s1:mX:2",
            kind: "session-distill",
            sessionId: "s1",
            checkpoint: {
              transcriptRevision: 1,
              firstMessageId: "mX",
              lastMessageId: "mY",
              messageCount: 2,
            },
          },
        ],
        processMemoryJob
      )
      await expect(drainMemoryJobs({}, d)).resolves.toBe(1)
      expect(d.finish).toHaveBeenCalledWith("gone", {
        status: "skipped",
        resultCode: "source_missing",
      })
      expect(d.fail).not.toHaveBeenCalled()
    })

    it("skips a job whose window no longer spans the recorded message count", async () => {
      mockListMessages.mockResolvedValue(windowed)
      const d = deps(
        [
          {
            ...job("resized"),
            dedupeKey: "session-distill:s1:m3:2",
            kind: "session-distill",
            sessionId: "s1",
            checkpoint: {
              transcriptRevision: 1,
              firstMessageId: "m1",
              lastMessageId: "m3",
              messageCount: 2,
            },
          },
        ],
        processMemoryJob
      )
      await expect(drainMemoryJobs({}, d)).resolves.toBe(1)
      expect(d.finish).toHaveBeenCalledWith("resized", {
        status: "skipped",
        resultCode: "snapshot_changed",
      })
      expect(d.fail).not.toHaveBeenCalled()
    })

    it("loads a checkpointed job whose dedupe key carries no trailing count", async () => {
      // Job kinds added later need not encode a count in their key.
      mockListMessages.mockResolvedValue(windowed)
      const outcome = await processMemoryJob({
        ...job("keyless"),
        dedupeKey: "session-distill:s1:run-a",
        kind: "session-distill",
        sessionId: "s1",
        checkpoint: {
          transcriptRevision: 1,
          firstMessageId: "m1",
          lastMessageId: "m2",
          messageCount: 2,
        },
      })
      expect(outcome.status).toBe("succeeded")
    })
  })

  it("skips (not succeeds or fails) a job that dies with a terminal error", async () => {
    // A turn job without a sessionId is terminally unprocessable — the drain
    // loop completes it instead of retry-failing.
    const d = deps([job("terminal")], processMemoryJob)
    await expect(drainMemoryJobs({}, d)).resolves.toBe(1)
    expect(d.finish).toHaveBeenCalledWith("terminal", {
      status: "skipped",
      resultCode: "session_missing",
    })
    expect(d.fail).not.toHaveBeenCalled()
  })

  it("terminally denies recovery for a session whose policy forbids learning", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, learnFromChats: false } })
    await expect(processMemoryJob({ ...job("turn"), sessionId: "s1" })).rejects.toMatchObject({
      message: expect.stringContaining("learning_denied"),
    })
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "learn-denied", metadata: { recoveredJob: true } })
    )
  })

  it("skips NOOP operations when recording recovered work", async () => {
    mockListMessages.mockResolvedValue([
      { id: "u1", role: "user", parts: [{ type: "text", text: "I always use pnpm" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Noted." }] },
    ])
    mockRunExtraction.mockResolvedValue({
      applied: [
        { op: "NOOP", candidate: { type: "semantic", text: "dupe", importance: 5 } },
        {
          op: "UPDATE",
          targetId: "m-upd",
          candidate: { type: "semantic", text: "Uses pnpm", importance: 5 },
        },
      ],
    })
    await processMemoryJob({ ...job("turn"), sessionId: "s1" })
    expect(mockUpdateMemory).toHaveBeenCalledTimes(1)
    expect(mockUpdateMemory).toHaveBeenCalledWith(
      "m-upd",
      expect.objectContaining({ reviewStatus: "unreviewed" })
    )
  })

  it("fails the turn job when the checkpoint window holds no completed pair", async () => {
    // Assistant reply with no preceding user turn → lastCompletedPair bails.
    mockListMessages.mockResolvedValue([
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "orphan reply" }] },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "another" }] },
    ])
    await expect(processMemoryJob({ ...job("turn"), sessionId: "s1" })).rejects.toMatchObject({
      message: expect.stringContaining("turn_pair_unavailable"),
    })
  })

  it("fails the turn job when the window has no assistant text at all", async () => {
    mockListMessages.mockResolvedValue([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "anyone?" }] },
    ])
    await expect(processMemoryJob({ ...job("turn"), sessionId: "s1" })).rejects.toMatchObject({
      message: expect.stringContaining("turn_pair_unavailable"),
    })
  })

  it("backs off when the durable transcript checkpoint is unavailable", async () => {
    const d = deps([{ ...job("missing"), sessionId: "s1", dedupeKey: "invalid" }], processMemoryJob)
    await drainMemoryJobs({}, d)
    expect(d.fail).toHaveBeenCalledWith("missing", "transcript_checkpoint_unavailable")
  })
})
