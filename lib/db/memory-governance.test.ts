/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  appendMemoryAuditEvent,
  claimMemoryJob,
  claimNextMemoryJob,
  completeMemoryJob,
  createMemoryEvidence,
  enqueueMemoryJob,
  failMemoryJob,
  getMemoryJob,
  listMemoryAuditEvents,
  listMemoryEvidence,
} from "./memory-governance"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

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
      "queued"
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
    expect(await getMemoryJob("j1")).toMatchObject({ status: "completed", completedAt: 1_100 })
    expect((await enqueueMemoryJob({ ...draft, id: "j2" })).id).toBe("j2")
  })

  it("reuses only completed work and replaces a failed dedupe-key job", async () => {
    await enqueueMemoryJob({ ...draft, status: "failed" })
    const retry = await enqueueMemoryJob({ ...draft, id: "j2" }, { reuseCompleted: true })
    expect(retry.id).toBe("j2")
  })
})
