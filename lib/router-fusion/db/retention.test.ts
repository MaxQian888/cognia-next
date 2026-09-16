import "fake-indexeddb/auto"

import {
  ROUTER_FUSION_ARTIFACT_CONTENT_DAYS,
  ROUTER_FUSION_EVENT_HISTORY_DAYS,
  ROUTER_FUSION_IDEMPOTENCY_DAYS,
  ROUTER_FUSION_RUN_TRAIL_DAYS,
} from "@/lib/data-governance/router-fusion-catalog"

import { FusionDB } from "./fusion-db"
import {
  ARTIFACT_CONTENT_TTL_MS,
  EVENT_HISTORY_RETENTION_MS,
  IDEMPOTENCY_TTL_MS,
  RUN_TRAIL_RETENTION_MS,
  pruneFusionDatabase,
} from "./retention"
import type {
  FusionAttemptState,
  FusionCallAttemptRow,
  FusionOutboxRow,
  FusionReservationRow,
  FusionReservationState,
  FusionRunRow,
} from "./types"

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const OLD = NOW - RUN_TRAIL_RETENTION_MS - DAY
let dbCounter = 0

function freshDb(): FusionDB {
  return new FusionDB(`fusion-retention-test-${++dbCounter}`)
}

function run(runId: string, overrides: Partial<FusionRunRow> = {}): FusionRunRow {
  return {
    runId,
    sessionId: `session-${runId}`,
    surface: "chat",
    origin: "chat",
    mode: "direct",
    actionId: "direct_baseline",
    actionHash: "hash",
    ruleId: null,
    decisionId: `decision-${runId}`,
    configDigest: "digest-current",
    status: "succeeded",
    budget: {},
    budgetMode: "tracked",
    grantMicrousd: 0,
    roleDeployments: {},
    deadlineAt: OLD + DAY,
    leaseOwner: null,
    leaseExpiresAt: 0,
    fencingToken: 1,
    lastSeq: 2,
    costStatus: "actual",
    resultArtifactId: null,
    error: null,
    sessionVersion: null,
    createdAt: OLD,
    updatedAt: OLD,
    terminalAt: OLD,
    ...overrides,
  } as unknown as FusionRunRow
}

function attempt(runId: string, state: FusionAttemptState): FusionCallAttemptRow {
  return {
    attemptId: `attempt-${runId}-${state}`,
    runId,
    logicalStepId: "leg:1",
    attemptNo: 1,
    role: "baseline",
    deploymentId: "dep",
    state,
    reservationId: `reservation-${runId}`,
    requestHash: "h",
    fencingToken: 1,
    resultArtifactId: null,
    resultFinishReason: null,
    providerRequestId: null,
    createdAt: OLD,
  } as unknown as FusionCallAttemptRow
}

function reservation(runId: string, state: FusionReservationState): FusionReservationRow {
  return {
    reservationId: `reservation-${runId}-${state}`,
    runId,
    kind: "call",
    amountMicrousd: 1000,
    state,
    stageId: null,
    attemptId: null,
    createdAt: OLD,
    updatedAt: OLD,
  }
}

function effect(runId: string, status: FusionOutboxRow["status"]): FusionOutboxRow {
  return {
    effectId: `effect-${runId}-${status}`,
    runId,
    kind: "usage_row",
    payload: {},
    status,
    attempts: 0,
    lastError: null,
    createdAt: OLD,
    appliedAt: status === "pending" ? null : OLD,
  }
}

async function seedTrail(db: FusionDB, row: FusionRunRow): Promise<void> {
  await db.fusionRuns.put(row)
  await db.fusionRunEvents.bulkPut([
    { runId: row.runId, seq: 1, type: "run.created", payload: {}, createdAt: OLD },
    { runId: row.runId, seq: 2, type: "run.succeeded", payload: {}, createdAt: OLD },
  ])
  await db.fusionCallAttempts.put(attempt(row.runId, "SUCCEEDED"))
  await db.fusionReservations.put(reservation(row.runId, "settled"))
  await db.fusionRouteDecisions.put({
    decisionId: row.decisionId,
    runId: row.runId,
    decision: {} as never,
    createdAt: OLD,
  })
  await db.fusionOutbox.put(effect(row.runId, "applied"))
  await db.fusionLedger.put({
    dedupeKey: `settle:attempt-${row.runId}`,
    runId: row.runId,
    attemptId: `attempt-${row.runId}-SUCCEEDED`,
    kind: "settle",
    amountMicrousd: 1000,
    createdAt: OLD,
  })
}

describe("pruneFusionDatabase", () => {
  it("takes its windows from the governance catalog", () => {
    expect(ARTIFACT_CONTENT_TTL_MS).toBe(ROUTER_FUSION_ARTIFACT_CONTENT_DAYS * DAY)
    expect(EVENT_HISTORY_RETENTION_MS).toBe(ROUTER_FUSION_EVENT_HISTORY_DAYS * DAY)
    expect(RUN_TRAIL_RETENTION_MS).toBe(ROUTER_FUSION_RUN_TRAIL_DAYS * DAY)
    expect(IDEMPOTENCY_TTL_MS).toBe(ROUTER_FUSION_IDEMPOTENCY_DAYS * DAY)
  })

  it("reaps a finished run's whole trail and keeps its ledger rows", async () => {
    const db = freshDb()
    await seedTrail(db, run("old"))

    const report = await pruneFusionDatabase(db, NOW)

    expect(report).toMatchObject({
      runs: 1,
      runEvents: 2,
      callAttempts: 1,
      reservations: 1,
      routeDecisions: 1,
      outbox: 1,
      runsKept: 0,
    })
    expect(await db.fusionRuns.count()).toBe(0)
    expect(await db.fusionRunEvents.count()).toBe(0)
    expect(await db.fusionCallAttempts.count()).toBe(0)
    expect(await db.fusionReservations.count()).toBe(0)
    expect(await db.fusionRouteDecisions.count()).toBe(0)
    expect(await db.fusionOutbox.count()).toBe(0)
    // The money record is append-only.
    expect(await db.fusionLedger.count()).toBe(1)
    db.close()
  })

  it("keeps runs inside the window, and live runs of any age", async () => {
    const db = freshDb()
    const recent = NOW - RUN_TRAIL_RETENTION_MS + DAY
    await seedTrail(db, run("recent", { createdAt: recent, terminalAt: recent }))
    await seedTrail(db, run("stuck", { status: "running", terminalAt: null }))
    // Created long ago, ended recently: the window runs from the end.
    await seedTrail(db, run("long", { terminalAt: recent }))

    const report = await pruneFusionDatabase(db, NOW)

    expect(report.runs).toBe(0)
    expect((await db.fusionRuns.toArray()).map((row) => row.runId).sort()).toEqual([
      "long",
      "recent",
      "stuck",
    ])
    db.close()
  })

  it.each([
    [
      "an attempt still waiting for its usage",
      (db: FusionDB) => db.fusionCallAttempts.put(attempt("pinned", "UNKNOWN")),
    ],
    [
      "an uncertain reservation",
      (db: FusionDB) => db.fusionReservations.put(reservation("pinned", "uncertain")),
    ],
    [
      "a held reservation",
      (db: FusionDB) => db.fusionReservations.put(reservation("pinned", "held")),
    ],
    [
      "an outbox effect not yet applied",
      (db: FusionDB) => db.fusionOutbox.put(effect("pinned", "pending")),
    ],
    [
      "a session lock",
      (db: FusionDB) =>
        db.fusionSessionLocks.put({
          sessionId: "session-pinned",
          runId: "pinned",
          acquiredAt: OLD,
        }),
    ],
  ])("keeps a finished run that still has %s", async (_label, pin) => {
    const db = freshDb()
    await seedTrail(db, run("pinned"))
    await pin(db)

    const report = await pruneFusionDatabase(db, NOW)

    expect(report).toMatchObject({ runs: 0, runsKept: 1 })
    expect(await db.fusionRuns.get("pinned")).toBeDefined()
    expect(await db.fusionCallAttempts.where("runId").equals("pinned").count()).toBeGreaterThan(0)
    // Money pins the run, not its journal: the replay window ended long ago.
    expect(await db.fusionRunEvents.where("runId").equals("pinned").count()).toBe(0)
    db.close()
  })

  it("drops a finished run's journal after the event window and keeps its snapshot", async () => {
    const db = freshDb()
    const pastJournal = NOW - EVENT_HISTORY_RETENTION_MS - DAY
    const withinJournal = NOW - EVENT_HISTORY_RETENTION_MS + DAY
    await seedTrail(db, run("replay-gone", { createdAt: pastJournal, terminalAt: pastJournal }))
    await seedTrail(db, run("replayable", { createdAt: withinJournal, terminalAt: withinJournal }))
    await seedTrail(
      db,
      run("running", { status: "running", terminalAt: null, createdAt: pastJournal })
    )

    const report = await pruneFusionDatabase(db, NOW)

    expect(report).toMatchObject({ runs: 0, runEvents: 2 })
    expect(await db.fusionRuns.get("replay-gone")).toBeDefined()
    expect(await db.fusionCallAttempts.where("runId").equals("replay-gone").count()).toBe(1)
    expect(await db.fusionRunEvents.where("runId").equals("replay-gone").count()).toBe(0)
    expect(await db.fusionRunEvents.where("runId").equals("replayable").count()).toBe(2)
    // A live run's journal is how its client follows it: never reaped.
    expect(await db.fusionRunEvents.where("runId").equals("running").count()).toBe(2)
    db.close()
  })

  it("reaps expired artifact content unless a live run wrote it", async () => {
    const db = freshDb()
    await db.fusionRuns.put(
      run("live", { status: "running", terminalAt: null, createdAt: NOW, updatedAt: NOW })
    )
    const artifact = (artifactId: string, runId: string | null, expiresAt: number) => ({
      artifactId,
      runId,
      namespace: "leg",
      mediaType: "text/plain",
      contentSha256: artifactId,
      sizeBytes: 1,
      content: "x",
      encryptedContent: null,
      createdAt: expiresAt - ARTIFACT_CONTENT_TTL_MS,
      expiresAt,
    })
    await db.fusionArtifacts.bulkPut([
      artifact("expired-finished", "gone", NOW - 1),
      artifact("expired-unowned", null, NOW),
      artifact("expired-live", "live", NOW - 1),
      artifact("fresh", "gone", NOW + DAY),
    ])

    const report = await pruneFusionDatabase(db, NOW)

    expect(report.artifacts).toBe(2)
    expect((await db.fusionArtifacts.toArray()).map((row) => row.artifactId).sort()).toEqual([
      "expired-live",
      "fresh",
    ])
    db.close()
  })

  it("reaps old config snapshots no retained run was compiled from", async () => {
    const db = freshDb()
    await db.fusionRuns.put(
      run("kept", { createdAt: NOW, terminalAt: NOW, configDigest: "digest-in-use" })
    )
    await db.fusionConfigSnapshots.bulkPut([
      { digest: "digest-in-use", config: {} as never, createdAt: OLD },
      { digest: "digest-orphan", config: {} as never, createdAt: OLD },
      { digest: "digest-new", config: {} as never, createdAt: NOW },
    ])

    const report = await pruneFusionDatabase(db, NOW)

    expect(report.configSnapshots).toBe(1)
    expect((await db.fusionConfigSnapshots.toArray()).map((row) => row.digest).sort()).toEqual([
      "digest-in-use",
      "digest-new",
    ])
    db.close()
  })

  it("keeps the snapshot of a run it reaps in the same sweep only if another run still uses it", async () => {
    const db = freshDb()
    await seedTrail(db, run("reaped", { configDigest: "digest-shared" }))
    await db.fusionRuns.put(
      run("fresh", { createdAt: NOW, terminalAt: NOW, configDigest: "digest-shared" })
    )
    await seedTrail(db, run("reaped-alone", { configDigest: "digest-alone" }))
    await db.fusionConfigSnapshots.bulkPut([
      { digest: "digest-shared", config: {} as never, createdAt: OLD },
      { digest: "digest-alone", config: {} as never, createdAt: OLD },
    ])

    await pruneFusionDatabase(db, NOW)

    expect((await db.fusionConfigSnapshots.toArray()).map((row) => row.digest)).toEqual([
      "digest-shared",
    ])
    db.close()
  })

  it("forgets an idempotency key once its own window has passed, whatever the run", async () => {
    const db = freshDb()
    await db.fusionRuns.put(run("live", { status: "running", terminalAt: null, createdAt: NOW }))
    await db.fusionIdempotency.bulkPut([
      {
        scopedKey: "expired",
        requestHash: "h1",
        runId: "live",
        createdAt: NOW - 2 * DAY,
        expiresAt: NOW - DAY,
      },
      {
        scopedKey: "fresh",
        requestHash: "h2",
        runId: "live",
        createdAt: NOW,
        expiresAt: NOW + DAY,
      },
    ])

    const report = await pruneFusionDatabase(db, NOW)

    // The key's window is its own: a live run does not keep an expired key,
    // or a caller's new request would replay a run it did not ask for.
    expect(report.idempotencyKeys).toBe(1)
    expect((await db.fusionIdempotency.toArray()).map((row) => row.scopedKey)).toEqual(["fresh"])
    db.close()
  })

  it("takes a reaped run's feedback with it, and leaves a kept run's alone", async () => {
    const db = freshDb()
    await seedTrail(db, run("old"))
    await db.fusionRuns.put(run("recent", { createdAt: NOW, updatedAt: NOW, terminalAt: NOW }))
    await db.fusionFeedback.bulkPut([
      {
        feedbackId: "f-old",
        runId: "old",
        actorKeyId: "key-a",
        rating: "up",
        commentArtifactId: null,
        createdAt: OLD,
      },
      {
        feedbackId: "f-recent",
        runId: "recent",
        actorKeyId: "key-a",
        rating: "down",
        commentArtifactId: null,
        createdAt: NOW,
      },
    ])

    const report = await pruneFusionDatabase(db, NOW)

    expect(report.feedback).toBe(1)
    expect((await db.fusionFeedback.toArray()).map((row) => row.feedbackId)).toEqual(["f-recent"])
    db.close()
  })

  it("is idempotent", async () => {
    const db = freshDb()
    await seedTrail(db, run("old"))
    await pruneFusionDatabase(db, NOW)
    await expect(pruneFusionDatabase(db, NOW)).resolves.toMatchObject({
      runs: 0,
      runsKept: 0,
      artifacts: 0,
    })
    db.close()
  })
})
