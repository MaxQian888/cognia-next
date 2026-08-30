import { createDbTestFixture } from "./test-fixture"
import {
  appendMemoryAuditEvent,
  bindMemoryGovernanceOutcome,
  claimMemoryJob,
  claimNextMemoryJob,
  cancelMemoryJob,
  completeMemoryJob,
  createMemoryEvidence,
  enqueueMemoryJob,
  failMemoryJob,
  finishMemoryJob,
  heartbeatMemoryJob,
  findEarliestInstrumentedAuditAt,
  getMemoryJob,
  listMemoryAuditEvents,
  listMemoryAuditEventsSince,
  listMemoryEvidence,
  listMemoryJobs,
  pruneMemoryGovernanceData,
  cancelMemoryJobsForSession,
  recordMemoryEvidenceVerdict,
  revokeMemoryEvidenceForMessages,
  revokeMemoryEvidenceForSession,
} from "./memory-governance"
import { createMemory, getMemory } from "./memories"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("memory evidence and audit", () => {
  it("persists source identities without raw source content", async () => {
    const evidence = await createMemoryEvidence({
      id: "e1",
      memoryId: "m1",
      kind: "message",
      sourceId: "message-1",
      sessionId: "session-1",
      excerptHash: "sha256:abc",
      contaminationState: "clean",
      reviewed: false,
    })
    expect(evidence.createdAt).toBeGreaterThan(0)
    expect(await listMemoryEvidence("m1")).toEqual([evidence])
  })

  it("appends structured audit events", async () => {
    const event = await appendMemoryAuditEvent({
      id: "a1",
      action: "recall-denied",
      sessionId: "session-1",
      reason: "external_context",
      metadata: { candidateCount: 2 },
    })
    expect(await listMemoryAuditEvents({ sessionId: "session-1" })).toEqual([event])
  })

  it("binds governance, evidence, and content-free audit in one transaction", async () => {
    await createMemory({
      id: "m-atomic",
      scope: "global",
      type: "semantic",
      text: "fact",
      importance: 5,
      provenance: "user",
      evidenceState: "legacy",
      reviewStatus: "unreviewed",
      contaminationState: "unknown",
      sensitivity: "unknown",
    })
    await bindMemoryGovernanceOutcome({
      memoryId: "m-atomic",
      patch: { evidenceState: "supported", contaminationState: "clean" },
      evidence: {
        id: "e-atomic",
        kind: "message",
        sourceId: "message-1",
        contaminationState: "clean",
        reviewed: false,
      },
      audit: { id: "a-atomic", action: "created", reason: "automatic_learning" },
      now: 10,
    })

    expect(await getMemory("m-atomic")).toMatchObject({
      evidenceState: "supported",
      contaminationState: "clean",
      updatedAt: 10,
    })
    expect(await listMemoryEvidence("m-atomic")).toHaveLength(1)
    expect(await listMemoryAuditEvents({ memoryId: "m-atomic" })).toHaveLength(1)
  })
})

describe("durable memory jobs", () => {
  const draft = {
    id: "j1",
    dedupeKey: "turn:session-1:message-2",
    kind: "turn-extraction" as const,
    sessionId: "session-1",
    scope: "global" as const,
    provenance: "user" as const,
    evidenceIds: ["e1"],
  }

  it("deduplicates active work and atomically claims it with a lease", async () => {
    const first = await enqueueMemoryJob(draft)
    const duplicate = await enqueueMemoryJob({ ...draft, id: "j2" })
    expect(duplicate.id).toBe(first.id)

    const claimed = await claimNextMemoryJob("worker-1", 1_000, 500)
    expect(claimed).toMatchObject({ id: "j1", status: "running", leaseOwner: "worker-1" })
    expect(claimed?.leaseExpiresAt).toBe(1_500)
    expect(await claimNextMemoryJob("worker-2", 1_001, 500)).toBeUndefined()
  })

  it("refuses a completion from a worker that no longer owns the job", async () => {
    await enqueueMemoryJob(draft)
    await claimNextMemoryJob("worker-1", 1_000, 50)
    await claimNextMemoryJob("worker-2", 1_100, 50_000)

    // worker-1 finally comes back with a result for a job it lost.
    await expect(
      finishMemoryJob("j1", "succeeded", "memories_applied", 2_000, { workerId: "worker-1" })
    ).resolves.toBe("lost")
    expect(await getMemoryJob("j1")).toMatchObject({
      status: "running",
      leaseOwner: "worker-2",
    })
  })

  it("refuses a completion for a job the user cancelled mid-run", async () => {
    await enqueueMemoryJob(draft)
    await claimNextMemoryJob("worker-1", 1_000, 50_000)
    await cancelMemoryJob("j1", 1_500)

    await expect(
      finishMemoryJob("j1", "succeeded", "memories_applied", 2_000, { workerId: "worker-1" })
    ).resolves.toBe("lost")
    expect(await getMemoryJob("j1")).toMatchObject({ status: "cancelled" })
  })

  it("keeps the unconditional completion for callers that own no lease", async () => {
    await enqueueMemoryJob(draft)
    await claimNextMemoryJob("worker-1", 1_000, 50_000)
    await expect(finishMemoryJob("j1", "succeeded", "done", 2_000)).resolves.toBe("finished")
    expect(await getMemoryJob("j1")).toMatchObject({ status: "succeeded" })
  })

  it("does not resurrect a cancelled job through the failure path", async () => {
    // The losing worker's error handler used to reopen the row as `retry_wait`,
    // so a cancel during a run silently did nothing.
    await enqueueMemoryJob(draft)
    await claimNextMemoryJob("worker-1", 1_000, 50_000)
    await cancelMemoryJob("j1", 1_500)

    await expect(failMemoryJob("j1", "boom", 2_000)).resolves.toBe("cancelled")
    expect(await getMemoryJob("j1")).toMatchObject({ status: "cancelled" })
  })

  it("ignores a failure reported by a worker that lost the lease", async () => {
    await enqueueMemoryJob(draft)
    await claimNextMemoryJob("worker-1", 1_000, 50)
    await claimNextMemoryJob("worker-2", 1_100, 50_000)

    await expect(failMemoryJob("j1", "boom", 2_000, { workerId: "worker-1" })).resolves.toBe(
      "running"
    )
    expect(await getMemoryJob("j1")).toMatchObject({ leaseOwner: "worker-2", status: "running" })
  })

  it("stops reclaiming an expired lease once the attempts are spent", async () => {
    // A job that kills its worker every time used to be re-claimed forever.
    await enqueueMemoryJob({ ...draft, maxAttempts: 2 })
    await claimNextMemoryJob("w1", 1_000, 10)
    await claimNextMemoryJob("w2", 1_100, 10)
    expect(await getMemoryJob("j1")).toMatchObject({ attempt: 2 })

    expect(await claimNextMemoryJob("w3", 1_200, 10)).toBeUndefined()
    expect(await getMemoryJob("j1")).toMatchObject({
      status: "failed",
      errorCode: "lease_expired_max_attempts",
    })
  })

  it("reclaims an expired lease", async () => {
    await enqueueMemoryJob(draft)
    await claimNextMemoryJob("dead-worker", 1_000, 50)
    expect(await claimNextMemoryJob("replacement", 1_051, 50)).toMatchObject({
      id: "j1",
      leaseOwner: "replacement",
    })
  })

  it("claims the oldest eligible row across queued work and expired leases", async () => {
    await enqueueMemoryJob({ ...draft, id: "queued-new", dedupeKey: "queued-new", queuedAt: 200 })
    await enqueueMemoryJob({
      ...draft,
      id: "running-old",
      dedupeKey: "running-old",
      status: "running",
      queuedAt: 100,
      leaseOwner: "dead-worker",
      leaseExpiresAt: 900,
    })

    await expect(claimNextMemoryJob("replacement", 1_000)).resolves.toMatchObject({
      id: "running-old",
      leaseOwner: "replacement",
    })
  })

  it("claims a specific durable job only once", async () => {
    await enqueueMemoryJob(draft)
    expect(await claimMemoryJob("j1", "worker-a", 1_000, 100)).toMatchObject({
      leaseOwner: "worker-a",
    })
    expect(await claimMemoryJob("j1", "worker-b", 1_001, 100)).toBeUndefined()
  })

  it("backs off transient failures and dead-letters exhausted work", async () => {
    await enqueueMemoryJob(draft)
    await claimNextMemoryJob("worker", 1_000, 50)
    expect(await failMemoryJob("j1", "provider_unavailable", 1_100, { maxRetries: 1 })).toBe(
      "retry_wait"
    )
    expect(await claimNextMemoryJob("worker", 1_100)).toBeUndefined()
    expect(await claimNextMemoryJob("worker", 2_100)).toBeDefined()
    expect(await failMemoryJob("j1", "provider_unavailable", 2_200, { maxRetries: 1 })).toBe(
      "failed"
    )
  })

  it("completes a claimed job and permits a later job with the same dedupe key", async () => {
    await enqueueMemoryJob(draft)
    await claimNextMemoryJob("worker", 1_000)
    await completeMemoryJob("j1", 1_100)
    expect(await getMemoryJob("j1")).toMatchObject({ status: "succeeded", completedAt: 1_100 })
    expect((await enqueueMemoryJob({ ...draft, id: "j2" })).id).toBe("j2")
  })

  it("reuses only successful work and replaces a failed dedupe-key job", async () => {
    await enqueueMemoryJob({ ...draft, status: "failed" })
    const retry = await enqueueMemoryJob({ ...draft, id: "j2" }, { reuseCompleted: true })
    expect(retry.id).toBe("j2")
  })

  it("renews the active lease and records no-output and cancellation outcomes", async () => {
    await enqueueMemoryJob(draft)
    await claimNextMemoryJob("worker", 1_000, 100)
    expect(await heartbeatMemoryJob("j1", "other", 1_050, 100)).toBeUndefined()
    expect(await heartbeatMemoryJob("j1", "worker", 1_050, 100)).toMatchObject({
      heartbeatAt: 1_050,
      leaseExpiresAt: 1_150,
    })
    await finishMemoryJob("j1", "no_output", "nothing_durable", 1_100)
    expect(await getMemoryJob("j1")).toMatchObject({
      status: "no_output",
      resultCode: "nothing_durable",
    })

    await enqueueMemoryJob({ ...draft, id: "j2", dedupeKey: "k2" })
    expect(await cancelMemoryJob("j2", 1_200)).toMatchObject({
      status: "cancelled",
      resultCode: "cancelled_by_user",
    })
  })
})

describe("insight readers", () => {
  it("returns only audit events newer than the cutoff", async () => {
    await appendMemoryAuditEvent({
      id: "a1",
      action: "invalidated",
      reason: "idle",
      createdAt: 100,
    })
    await appendMemoryAuditEvent({
      id: "a2",
      action: "invalidated",
      reason: "idle",
      createdAt: 300,
    })
    await appendMemoryAuditEvent({ id: "a3", action: "created", reason: "user", createdAt: 400 })

    const rows = await listMemoryAuditEventsSince(200)
    expect(rows.map((r) => r.id).sort()).toEqual(["a2", "a3"])
  })

  it("finds the earliest event carrying an instrumented reason", async () => {
    await appendMemoryAuditEvent({ id: "b1", action: "created", reason: "user", createdAt: 50 })
    await appendMemoryAuditEvent({
      id: "b2",
      action: "invalidated",
      reason: "capacity",
      createdAt: 200,
    })
    await appendMemoryAuditEvent({
      id: "b3",
      action: "invalidated",
      reason: "idle",
      createdAt: 900,
    })

    await expect(findEarliestInstrumentedAuditAt(["idle", "capacity"])).resolves.toBe(200)
  })

  it("returns undefined when instrumentation never produced anything", async () => {
    await appendMemoryAuditEvent({ id: "c1", action: "created", reason: "user", createdAt: 50 })
    await expect(findEarliestInstrumentedAuditAt(["idle", "capacity"])).resolves.toBeUndefined()
  })

  it("lists jobs newest-queued first, including completed rows", async () => {
    const base = {
      kind: "turn-extraction" as const,
      scope: "global" as const,
      provenance: "user" as const,
      evidenceIds: [],
    }
    await enqueueMemoryJob({ ...base, id: "j-old", dedupeKey: "k1", queuedAt: 100 })
    await enqueueMemoryJob({ ...base, id: "j-new", dedupeKey: "k2", queuedAt: 900 })
    await completeMemoryJob("j-old", 150)

    const jobs = await listMemoryJobs()
    expect(jobs.map((j) => j.id)).toEqual(["j-new", "j-old"])
    // Completed jobs are retained, which is what makes "last run" reportable.
    expect(jobs[1]).toMatchObject({ status: "succeeded", completedAt: 150 })
  })

  it("enforces job and content-free audit retention", async () => {
    const now = 200 * 24 * 60 * 60 * 1000
    const base = {
      kind: "turn-extraction" as const,
      scope: "global" as const,
      provenance: "user" as const,
      evidenceIds: [],
    }
    await enqueueMemoryJob({
      ...base,
      id: "old-success",
      dedupeKey: "old-success",
      status: "succeeded",
      queuedAt: 1,
    })
    await appendMemoryAuditEvent({
      id: "old-audit",
      action: "deleted",
      reason: "user_requested",
      createdAt: 1,
    })
    await expect(pruneMemoryGovernanceData(now)).resolves.toEqual({
      jobsDeleted: 1,
      auditsDeleted: 1,
    })
  })
})

describe("evidence revocation", () => {
  async function seed() {
    const claim = await createMemory({
      scope: "workspace",
      type: "semantic",
      text: "The repo pins Rust to 1.77.2",
      importance: 7,
      provenance: "user",
      projectId: "p1",
      projectMemoryKind: "constraint",
    })
    const cited = await createMemoryEvidence({
      memoryId: claim.id,
      kind: "message",
      sourceId: "m1",
      sessionId: "s1",
      messageId: "m1",
      contaminationState: "clean",
      reviewed: false,
      validationStrategy: "message-presence",
    })
    const turnLevel = await createMemoryEvidence({
      memoryId: claim.id,
      kind: "message",
      sourceId: "s1:turn:2",
      sessionId: "s1",
      contaminationState: "clean",
      reviewed: false,
    })
    const elsewhere = await createMemoryEvidence({
      memoryId: claim.id,
      kind: "message",
      sourceId: "m9",
      sessionId: "s2",
      messageId: "m9",
      contaminationState: "clean",
      reviewed: false,
    })
    return { claim, cited, turnLevel, elsewhere }
  }

  it("revokes only the citations that name a deleted message", async () => {
    const { claim, cited, elsewhere } = await seed()
    expect(await revokeMemoryEvidenceForMessages(["m1"], 5_000)).toEqual([claim.id])
    const rows = await listMemoryEvidence(claim.id)
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(cited.id)).toMatchObject({ validationState: "revoked", validatedAt: 5_000 })
    expect(byId.get(elsewhere.id)?.validationState).toBeUndefined()
  })

  it("reaches turn-level citations only through the session form", async () => {
    // Those rows carry a sessionId and no messageId, so an id sweep leaves them
    // behind pointing at a conversation that no longer exists.
    const { claim, turnLevel } = await seed()
    await revokeMemoryEvidenceForMessages(["m1"])
    expect(
      (await listMemoryEvidence(claim.id)).find((row) => row.id === turnLevel.id)?.validationState
    ).toBeUndefined()

    await revokeMemoryEvidenceForSession("s1")
    expect(
      (await listMemoryEvidence(claim.id)).find((row) => row.id === turnLevel.id)?.validationState
    ).toBe("revoked")
  })

  it("leaves another session's citations alone", async () => {
    const { claim, elsewhere } = await seed()
    await revokeMemoryEvidenceForSession("s1")
    expect(
      (await listMemoryEvidence(claim.id)).find((row) => row.id === elsewhere.id)?.validationState
    ).toBeUndefined()
  })

  it("returns nothing to re-check when no citation names the deleted rows", async () => {
    await seed()
    expect(await revokeMemoryEvidenceForMessages(["nope"])).toEqual([])
    expect(await revokeMemoryEvidenceForSession("no-such-session")).toEqual([])
    expect(await revokeMemoryEvidenceForMessages([])).toEqual([])
  })

  it("records a verdict without letting it rewrite what the next check compares", async () => {
    // Widening this to a general patch would let a re-check overwrite
    // `sourceId` / `messageId` / `excerptHash` — the very fields the NEXT check
    // reads, which would make the check self-confirming.
    const { claim, cited } = await seed()
    await recordMemoryEvidenceVerdict(cited.id, { validationState: "valid", validatedAt: 9_000 })
    const row = (await listMemoryEvidence(claim.id)).find((item) => item.id === cited.id)
    expect(row).toMatchObject({
      validationState: "valid",
      validatedAt: 9_000,
      sourceId: "m1",
      messageId: "m1",
    })
  })
})

describe("cancelMemoryJobsForSession", () => {
  it("cancels pending work and leaves finished rows untouched", async () => {
    const queued = await enqueueMemoryJob({
      dedupeKey: "turn-extraction:s1:a",
      kind: "turn-extraction",
      sessionId: "s1",
      scope: "workspace",
      provenance: "user",
      evidenceIds: [],
    })
    const done = await enqueueMemoryJob({
      dedupeKey: "turn-extraction:s1:b",
      kind: "turn-extraction",
      sessionId: "s1",
      scope: "workspace",
      provenance: "user",
      evidenceIds: [],
    })
    await finishMemoryJob(done.id, "succeeded", "memories_applied")
    const other = await enqueueMemoryJob({
      dedupeKey: "turn-extraction:s2:a",
      kind: "turn-extraction",
      sessionId: "s2",
      scope: "workspace",
      provenance: "user",
      evidenceIds: [],
    })

    expect(await cancelMemoryJobsForSession("s1")).toBe(1)
    expect((await getMemoryJob(queued.id))?.status).toBe("cancelled")
    expect((await getMemoryJob(done.id))?.status).toBe("succeeded")
    expect((await getMemoryJob(other.id))?.status).toBe("queued")
  })

  it("no-ops on an empty session id", async () => {
    expect(await cancelMemoryJobsForSession("")).toBe(0)
  })
})
