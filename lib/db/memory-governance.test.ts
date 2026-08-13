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
