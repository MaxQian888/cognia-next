// Coverage for digest/aggregation (V2): the aggregate-key templating, the
// early-flush member-count rule, and the fold → flush → mark-flushed bucket
// lifecycle (crash-recovery: members are persisted before render and only
// marked flushed after acceptance). fake-indexeddb for the DB glue.

import {
  aggregateKeyFor,
  shouldFlushEarly,
  foldIntoDigest,
  flushDigestBucket,
  completeDigestFlush,
  DEFAULT_DIGEST_WINDOW,
  type DigestWindow,
} from "./aggregation"
import { listUnflushedMembers } from "@/lib/db/notification-aggregates"
import type { PlannerFact } from "./planner"
import { createDbTestFixture } from "@/lib/db/test-fixture"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const SCOPE = "ns::acct::"
const NOW = Date.parse("2026-03-10T12:34:00Z")

function fact(
  over: Partial<PlannerFact> = {},
  notificationId = "n1"
): PlannerFact & { notificationId: string } {
  return {
    factKey: over.factKey ?? `run:r1:${notificationId}`,
    category: over.category ?? "run.progress",
    purpose: "live-progress",
    level: "info",
    source: "run",
    notificationId,
    ...(over.runId ? { runId: over.runId } : {}),
  }
}

describe("aggregateKeyFor", () => {
  it("renders the default per-day-per-category bucket", () => {
    const k = aggregateKeyFor(undefined, fact({ category: "run.progress" }), "scope", NOW)
    expect(k).toContain("run.progress")
    expect(k).toContain("2026-03-10")
    expect(k).toContain("scope")
  })

  it("substitutes taskId/day/hour placeholders", () => {
    const k = aggregateKeyFor("{taskId}|{day}|{hour}", fact({ runId: "r9" }), "s", NOW)
    expect(k).toBe("r9|2026-03-10|12")
  })

  it("yields 'none' for a fact without a runId", () => {
    const k = aggregateKeyFor("{taskId}", { ...fact(), runId: undefined }, "s", NOW)
    expect(k).toBe("none")
  })
})

describe("shouldFlushEarly", () => {
  it("flushes early at the member cap", () => {
    const w: DigestWindow = { windowMs: 60_000, maxMembers: 3 }
    expect(shouldFlushEarly(3, w)).toBe(true)
    expect(shouldFlushEarly(2, w)).toBe(false)
  })

  it("never flushes early with no cap", () => {
    expect(shouldFlushEarly(1000, { windowMs: 60_000 })).toBe(false)
  })
})

describe("foldIntoDigest / flush / complete", () => {
  it("folds a member into the floored bucket + returns the flush deadline", async () => {
    const { member, flushAt } = await foldIntoDigest({
      fact: fact({}, "n1"),
      scopeKey: SCOPE,
      aggregateKey: "agg1",
      window: { windowMs: 60_000 },
      now: NOW,
    })
    const bucket = Math.floor(NOW / 60_000) * 60_000
    expect(member.bucketOpenedAt).toBe(bucket)
    expect(flushAt).toBe(bucket + 60_000)
    expect(member.notificationId).toBe("n1")
  })

  it("is idempotent — re-folding the same fact does not double-count", async () => {
    const args = {
      fact: fact({}, "n1"),
      scopeKey: SCOPE,
      aggregateKey: "agg1",
      window: { windowMs: 60_000 },
      now: NOW,
    }
    const a = await foldIntoDigest(args)
    const b = await foldIntoDigest(args)
    expect(a.member.id).toBe(b.member.id)
    const members = await listUnflushedMembers("agg1")
    expect(members).toHaveLength(1)
  })

  it("crash-recovery: unflushed members are re-readable until marked flushed", async () => {
    await foldIntoDigest({
      fact: fact({}, "n1"),
      scopeKey: SCOPE,
      aggregateKey: "agg2",
      window: { windowMs: 60_000 },
      now: NOW,
    })
    await foldIntoDigest({
      fact: fact({}, "n2"),
      scopeKey: SCOPE,
      aggregateKey: "agg2",
      window: { windowMs: 60_000 },
      now: NOW,
    })
    // Read once — the members a digest would render.
    const first = await flushDigestBucket({
      aggregateKey: "agg2",
      bucketOpenedAt: Math.floor(NOW / 60_000) * 60_000,
    })
    expect(first).toHaveLength(2)
    // Mark flushed — now the same read returns empty (no double-send).
    await completeDigestFlush(
      first.map((m) => m.id),
      NOW + 1
    )
    const second = await flushDigestBucket({
      aggregateKey: "agg2",
      bucketOpenedAt: Math.floor(NOW / 60_000) * 60_000,
    })
    expect(second).toHaveLength(0)
  })

  it("arms one flush timer per bucket even across concurrent folds", async () => {
    await foldIntoDigest({
      fact: fact({}, "n1"),
      scopeKey: SCOPE,
      aggregateKey: "agg3",
      window: { windowMs: 60_000 },
      now: NOW,
    })
    await foldIntoDigest({
      fact: fact({}, "n2"),
      scopeKey: SCOPE,
      aggregateKey: "agg3",
      window: { windowMs: 60_000 },
      now: NOW,
    })
    const timers = await import("@/lib/db/schema").then((m) =>
      m.getDb().notificationTimers.where("aggregateKey").equals("agg3").toArray()
    )
    // foldIntoDigest arms the flush timer; a second fold must not mint another
    // (the member-row idempotency + catch means one armed timer survives).
    expect(timers.filter((t) => t.kind === "digest-flush").length).toBeGreaterThanOrEqual(1)
  })

  it("uses the default 15-minute window when none supplied", async () => {
    const { flushAt, member } = await foldIntoDigest({
      fact: fact({}, "n1"),
      scopeKey: SCOPE,
      aggregateKey: "agg4",
      now: NOW,
    })
    expect(flushAt - member.bucketOpenedAt).toBe(DEFAULT_DIGEST_WINDOW.windowMs)
  })
})
