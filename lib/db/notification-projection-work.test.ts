/**
 * Tests for lib/db/notification-projection-work.ts — the durable dirty-marker
 * the Run Journal touches and the projector claims. Covers the subjectKey
 * cursor, the lease, the contiguous-commit CAS, the blocked/retry backoff,
 * the reconciler's due-work sweep, and the generation bump that forces a
 * reprojection.
 *
 * Dexie runs on fake-indexeddb via createDbTestFixture (jsdom project).
 */

import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  runSubjectKey,
  touchNotificationProjectionInTransaction,
  claimProjectionWork,
  commitProjectionCursor,
  commitProjectionCursorInsideTransaction,
  blockProjectionWork,
  listDueProjectionWork,
  bumpProjectionGeneration,
} from "./notification-projection-work"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const SCOPE = "scope-A"
const RUN = "run-1"
const SUBJECT = runSubjectKey(RUN)

async function touch(desiredRunSeq: number, extra: { desiredResultRevision?: number } = {}) {
  const db = getDb()
  await db.transaction("rw", db.notificationProjectionWork, async (tx) => {
    await touchNotificationProjectionInTransaction(tx as never, {
      runId: RUN,
      scopeKey: SCOPE,
      desiredRunSeq,
      ...extra,
    })
  })
}

async function getRow() {
  return getDb().notificationProjectionWork.where("subjectKey").equals(SUBJECT).first()
}

describe("runSubjectKey", () => {
  it("namespaces the subject as run:{id}", () => {
    expect(runSubjectKey("r9")).toBe("run:r9")
  })
})

describe("touchNotificationProjectionInTransaction", () => {
  it("creates a pending work row on first touch", async () => {
    await touch(3)
    const row = await getRow()
    expect(row).toBeDefined()
    expect(row!.state).toBe("pending")
    expect(row!.desiredRunSeq).toBe(3)
    expect(row!.processedRunSeq).toBe(0)
    expect(row!.subjectKey).toBe(SUBJECT)
    expect(row!.runId).toBe(RUN)
    expect(row!.scopeKey).toBe(SCOPE)
  })

  it("raises desiredRunSeq monotonically, never regresses", async () => {
    await touch(5)
    await touch(2) // a stale lower seq must not rewind desired
    const row = await getRow()
    expect(row!.desiredRunSeq).toBe(5)
  })

  it("re-opens a done row only when genuinely new work arrives", async () => {
    await touch(4)
    // Consume it fully.
    await claimProjectionWork(SUBJECT, "host-1")
    await commitProjectionCursor(SUBJECT, {
      generation: 0,
      leaseOwner: "host-1",
      processedRunSeq: 4,
      processedResultRevision: 0,
    })
    expect((await getRow())!.state).toBe("done")
    // A no-op touch at the same seq must NOT resurrect it.
    await touch(4)
    expect((await getRow())!.state).toBe("done")
    // A higher seq does.
    await touch(6)
    expect((await getRow())!.state).toBe("pending")
  })
})

describe("claimProjectionWork", () => {
  it("claims a pending row and stamps the lease", async () => {
    await touch(3)
    const claimed = await claimProjectionWork(SUBJECT, "host-1")
    expect(claimed).toBeDefined()
    expect(claimed!.state).toBe("processing")
    expect(claimed!.leaseOwner).toBe("host-1")
    expect(claimed!.leaseExpiresAt).toBeGreaterThan(Date.now())
  })

  it("refuses a second owner while the lease is live", async () => {
    await touch(3)
    await claimProjectionWork(SUBJECT, "host-1")
    const second = await claimProjectionWork(SUBJECT, "host-2")
    expect(second).toBeUndefined()
  })

  it("lets a different owner steal after the lease expires", async () => {
    await touch(3)
    await claimProjectionWork(SUBJECT, "host-1")
    // Force-expire the lease.
    const db = getDb()
    const row = (await getRow())!
    await db.notificationProjectionWork.put({ ...row, leaseExpiresAt: Date.now() - 1 })
    const stolen = await claimProjectionWork(SUBJECT, "host-2")
    expect(stolen).toBeDefined()
    expect(stolen!.leaseOwner).toBe("host-2")
  })

  it("returns undefined when nothing is claimable", async () => {
    expect(await claimProjectionWork("run:none", "h")).toBeUndefined()
  })
})

describe("commitProjectionCursor", () => {
  it("advances processed seq and goes done when caught up", async () => {
    await touch(3)
    await claimProjectionWork(SUBJECT, "host-1")
    const committed = await commitProjectionCursor(SUBJECT, {
      generation: 0,
      leaseOwner: "host-1",
      processedRunSeq: 3,
      processedResultRevision: 0,
    })
    expect(committed).toBeDefined()
    expect(committed!.state).toBe("done")
    expect(committed!.processedRunSeq).toBe(3)
    expect(committed!.leaseOwner).toBeUndefined()
  })

  it("stays pending when desired moved ahead during processing", async () => {
    await touch(3)
    await claimProjectionWork(SUBJECT, "host-1")
    // New event lands while we're processing — desired > processed.
    await touch(5)
    const committed = await commitProjectionCursor(SUBJECT, {
      generation: 0,
      leaseOwner: "host-1",
      processedRunSeq: 3,
      processedResultRevision: 0,
    })
    expect(committed!.state).toBe("pending")
    expect(committed!.processedRunSeq).toBe(3)
  })

  it("fails the CAS when the lease owner differs", async () => {
    await touch(3)
    await claimProjectionWork(SUBJECT, "host-1")
    const bad = await commitProjectionCursor(SUBJECT, {
      generation: 0,
      leaseOwner: "host-2", // wrong owner
      processedRunSeq: 3,
      processedResultRevision: 0,
    })
    expect(bad).toBeUndefined()
    expect((await getRow())!.processedRunSeq).toBe(0)
  })

  it("fails the CAS when the generation bumped mid-processing", async () => {
    await touch(3)
    await claimProjectionWork(SUBJECT, "host-1")
    await bumpProjectionGeneration(SCOPE) // generation 0 → 1
    const stale = await commitProjectionCursor(SUBJECT, {
      generation: 0, // stale
      leaseOwner: "host-1",
      processedRunSeq: 3,
      processedResultRevision: 0,
    })
    expect(stale).toBeUndefined()
  })

  it("never regresses the cursor", async () => {
    await touch(5)
    await claimProjectionWork(SUBJECT, "host-1")
    await commitProjectionCursor(SUBJECT, {
      generation: 0,
      leaseOwner: "host-1",
      processedRunSeq: 5,
      processedResultRevision: 0,
    })
    // Re-claim + try to commit a LOWER seq — must not rewind.
    await touch(7)
    await claimProjectionWork(SUBJECT, "host-1")
    const committed = await commitProjectionCursor(SUBJECT, {
      generation: 0,
      leaseOwner: "host-1",
      processedRunSeq: 3,
      processedResultRevision: 0,
    })
    expect(committed!.processedRunSeq).toBe(5)
  })
})

describe("commitProjectionCursorInsideTransaction", () => {
  it("commits the cursor inside the caller's transaction", async () => {
    await touch(3)
    await claimProjectionWork(SUBJECT, "host-1")
    const db = getDb()
    const ok = await db.transaction("rw", db.notificationProjectionWork, async (tx) =>
      commitProjectionCursorInsideTransaction(tx as never, SUBJECT, {
        generation: 0,
        leaseOwner: "host-1",
        processedRunSeq: 3,
        processedResultRevision: 0,
      })
    )
    expect(ok).toBe(true)
    expect((await getRow())!.state).toBe("done")
  })
})

describe("blockProjectionWork", () => {
  it("marks a claimed row blocked with a retry time", async () => {
    await touch(3)
    await claimProjectionWork(SUBJECT, "host-1")
    const retryAt = Date.now() + 60_000
    await blockProjectionWork(SUBJECT, "host-1", "send-failed", retryAt)
    const row = await getRow()
    expect(row!.state).toBe("blocked")
    expect(row!.lastErrorCode).toBe("send-failed")
    expect(row!.retryAt).toBe(retryAt)
    expect(row!.retryCount).toBe(1)
    expect(row!.leaseOwner).toBeUndefined()
  })
})

describe("listDueProjectionWork", () => {
  it("sweeps rows with unprocessed work and no live lease", async () => {
    await touch(3)
    const due = await listDueProjectionWork()
    expect(due.map((r) => r.subjectKey)).toContain(SUBJECT)
  })

  it("excludes a done row and a live-leased row", async () => {
    await touch(3)
    await claimProjectionWork(SUBJECT, "host-1") // leased
    const due = await listDueProjectionWork()
    expect(due.map((r) => r.subjectKey)).not.toContain(SUBJECT)
  })

  it("excludes a blocked row whose retry is not yet due", async () => {
    await touch(3)
    await claimProjectionWork(SUBJECT, "host-1")
    await blockProjectionWork(SUBJECT, "host-1", "err", Date.now() + 60_000)
    const due = await listDueProjectionWork()
    expect(due.map((r) => r.subjectKey)).not.toContain(SUBJECT)
  })
})

describe("bumpProjectionGeneration", () => {
  it("bumps every work row in the scope and re-opens done rows", async () => {
    await touch(3)
    await claimProjectionWork(SUBJECT, "host-1")
    await commitProjectionCursor(SUBJECT, {
      generation: 0,
      leaseOwner: "host-1",
      processedRunSeq: 3,
      processedResultRevision: 0,
    })
    const bumped = await bumpProjectionGeneration(SCOPE)
    expect(bumped).toBe(1)
    const row = await getRow()
    expect(row!.generation).toBe(1)
    expect(row!.state).toBe("pending")
  })
})
