import "fake-indexeddb/auto"

import {
  fakeCompiledConfig,
  fixtureRouteRequest,
  routeAction,
  type RawUsage,
  type UsageSemantics,
} from "@cognia/router-fusion"

import { fusionContentCodec } from "./content-codec"
import { FusionDB } from "./fusion-db"
import {
  CALL_RESULT_WITH_TOOLS_MEDIA_TYPE,
  decodeCommittedCallResult,
  encodeCommittedCallResult,
  FusionLedgerStore,
  ledgerWritesUsageRows,
  persistableText,
  projectedOriginOf,
  WITHHELD_TEXT,
  type CreateRunInput,
} from "./ledger-store"

const USD = 1_000_000
const SEMANTICS: UsageSemantics = {
  inputIncludesCacheRead: true,
  inputIncludesCacheWrite: true,
  outputIncludesReasoning: true,
}
const config = fakeCompiledConfig()

let dbCounter = 0

function harness() {
  const name = `fusion-ledger-test-${++dbCounter}`
  const db = new FusionDB(name)
  const clock = { t: 1_700_000_000_000 }
  let ids = 0
  const store = new FusionLedgerStore({
    db,
    codec: fusionContentCodec(name),
    now: () => clock.t,
    newId: () => `attempt-${++ids}`,
  })
  return { db, store, clock }
}

function runInput(runId: string, overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  const { decision } = routeAction(
    config,
    fixtureRouteRequest({ runId, decisionId: `decision-${runId}` })
  )
  return {
    runId,
    sessionId: null,
    surface: "chat",
    origin: "chat",
    decision,
    actionId: "direct_baseline",
    ruleId: "R6_baseline",
    roleDeployments: { solver: "fake-baseline" },
    config,
    capMicrousd: 1 * USD,
    maxModelCalls: 24,
    deadlineMs: 120_000,
    budgetMode: "tracked",
    tenantLimitRemainingMicrousd: null,
    ...overrides,
  }
}

async function running(
  store: FusionLedgerStore,
  runId: string,
  overrides: Partial<CreateRunInput> = {}
) {
  const created = await store.createRun(runInput(runId, overrides))
  if (!created.ok) throw new Error(`create refused: ${created.code}`)
  const lease = await store.acquireLease(runId, "worker-a", 60_000)
  if (!lease.ok) throw new Error(`lease refused: ${lease.code}`)
  const started = await store.startRun(runId, lease.fencingToken)
  if (!started.ok) throw new Error(`start refused: ${started.code}`)
  return lease.fencingToken
}

async function dispatch(
  store: FusionLedgerStore,
  runId: string,
  token: number,
  reserveMicrousd: number,
  logicalStepId = `step-${Math.random()}`
) {
  const outcome = await store.prepareCall(runId, token, {
    logicalStepId,
    role: "solver",
    deploymentId: "fake-baseline",
    reserveMicrousd,
    requestHash: "hash",
  })
  if (outcome.kind !== "granted") throw new Error(`prepare: ${JSON.stringify(outcome)}`)
  const dispatched = await store.markDispatched(outcome.attemptId, token)
  if (!dispatched.ok) throw new Error(`dispatch: ${dispatched.code}`)
  return outcome.attemptId
}

/** 100k input tokens × $1/M + 50k output × $2/M = $0.20 on fake-baseline. */
function usageCosting(inputTokens: number, outputTokens: number): RawUsage {
  return { inputTokens, outputTokens }
}

describe("FusionLedgerStore (fake-indexeddb)", () => {
  it("[ACC:BUD-01] admits exactly one of two concurrent runs that need the same tenant money", async () => {
    const { store } = harness()
    const results = await Promise.all([
      store.createRun(runInput("run-a", { tenantLimitRemainingMicrousd: 1 * USD })),
      store.createRun(runInput("run-b", { tenantLimitRemainingMicrousd: 1 * USD })),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "TENANT_BUDGET_EXHAUSTED" })
    expect((await store.getAccount()).activeHoldsMicrousd).toBe(1 * USD)
  })

  it("[ACC:API-03] creates one active run per session version and releases the lock on seal", async () => {
    const { store } = harness()
    const session = { sessionId: "session-1", expectedSessionVersion: 5, currentSessionVersion: 5 }
    const results = await Promise.all([
      store.createRun(runInput("run-a", session)),
      store.createRun(runInput("run-b", session)),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const loser = results.find((r) => !r.ok)
    expect(loser).toMatchObject({ code: "SESSION_BUSY" })
    expect(
      await store.createRun(
        runInput("run-c", {
          sessionId: "session-2",
          expectedSessionVersion: 4,
          currentSessionVersion: 5,
        })
      )
    ).toEqual({ ok: false, code: "SESSION_VERSION_CONFLICT" })

    const winner = results.find((r) => r.ok) as {
      ok: true
      run: { runId: string; fencingToken: number }
    }
    await store.finalizeRun(winner.run.runId, winner.run.fencingToken, { status: "cancelled" })
    expect((await store.createRun(runInput("run-d", session))).ok).toBe(true)
  })

  it("[ACC:BUD-03] books a repeatedly delivered usage exactly once", async () => {
    const { store, db } = harness()
    const token = await running(store, "run-1", { origin: "utility", surface: "utilityLedger" })
    const attemptId = await dispatch(store, "run-1", token, 300_000)
    const settle = () =>
      store.settleCall(attemptId, {
        status: "succeeded",
        usage: usageCosting(100_000, 50_000),
        semantics: SEMANTICS,
        providerRequestId: "req-1",
      })
    const outcomes = await Promise.all([settle(), settle(), settle()])
    expect(outcomes.map((o) => o.actualMicrousd)).toEqual([200_000, 200_000, 200_000])
    expect((await store.getRun("run-1"))?.budget.spentMicrousd).toBe(200_000)
    expect(await db.fusionLedger.where("kind").equals("settle").count()).toBe(1)
    expect(await db.fusionOutbox.where("kind").equals("usage_row").count()).toBe(1)
  })

  it("leaves a chat turn's usage row to the chat path", async () => {
    const { store, db } = harness()
    const token = await running(store, "run-1")
    const attemptId = await dispatch(store, "run-1", token, 300_000)
    await store.settleCall(attemptId, {
      status: "succeeded",
      usage: usageCosting(1_000, 1_000),
      semantics: SEMANTICS,
      providerRequestId: "r",
    })
    expect(await db.fusionOutbox.where("kind").equals("usage_row").count()).toBe(0)
  })

  it("books and projects a chat cascade or panel, which no sidecar turn records", async () => {
    const { store, db } = harness()
    const token = await running(store, "chat-fusion-1", { driver: "orchestrator" })
    const attemptId = await dispatch(store, "chat-fusion-1", token, 300_000)
    await store.settleCall(attemptId, {
      status: "succeeded",
      usage: usageCosting(1_000, 1_000),
      semantics: SEMANTICS,
      providerRequestId: "r",
    })
    const usage = await db.fusionOutbox.where("kind").equals("usage_row").toArray()
    expect(usage).toHaveLength(1)
    expect(usage[0].payload).toMatchObject({ runId: "chat-fusion-1", origin: "chat" })
    const projections = await db.fusionOutbox
      .where("kind")
      .equals("execution_run_projection")
      .toArray()
    expect(projections.map((row) => row.payload)).toEqual(
      expect.arrayContaining([expect.objectContaining({ runId: "chat-fusion-1", origin: "local" })])
    )
    // A direct chat turn still projects nothing: its turn owns an execution run.
    expect(projectedOriginOf({ origin: "chat" })).toBeNull()
    expect(projectedOriginOf({ origin: "chat", driver: "orchestrator" })).toBe("local")
    expect(projectedOriginOf({ origin: "gateway", driver: "orchestrator" })).toBe("gateway-api")
    expect(ledgerWritesUsageRows({ origin: "chat" })).toBe(false)
    expect(ledgerWritesUsageRows({ origin: "chat", driver: "orchestrator" })).toBe(true)
  })

  it("[ACC:BUD-06] keeps a timed-out call UNKNOWN with its money held, never free", async () => {
    const { store, clock } = harness()
    const token = await running(store, "run-1")
    const attemptId = await dispatch(store, "run-1", token, 250_000)
    await store.markUnknown(attemptId, "timeout_after_send")
    const finalized = await store.finalizeRun("run-1", token, { status: "failed" })
    expect(finalized.ok && finalized.run.costStatus).toBe("pending")
    const summary = await store.runSummary("run-1")
    expect(summary?.attempts[0].state).toBe("UNKNOWN")
    expect(summary?.uncertainMicrousd).toBe(250_000)
    expect(summary?.run.budget.spentMicrousd).toBe(0)
    // The terminal release keeps the uncertain amount on the tenant.
    expect((await store.getAccount()).activeHoldsMicrousd).toBe(250_000)

    clock.t += 25 * 60 * 60 * 1000
    expect(await store.reconcileExpiredUnknown(24 * 60 * 60 * 1000)).toBe(1)
    const reconciled = await store.runSummary("run-1")
    expect(reconciled?.attempts[0]).toMatchObject({
      state: "RECONCILED",
      actualMicrousd: 250_000,
      costStatus: "estimated",
    })
    expect(reconciled?.run.budget.spentMicrousd).toBe(250_000)
    expect((await store.getAccount()).activeHoldsMicrousd).toBe(0)
  })

  it("[ACC:REC-03] never prepares a step again once one of its attempts went out unanswered", async () => {
    const { store, clock } = harness()
    const token = await running(store, "run-1", {
      driver: "orchestrator",
      deadlineMs: 2 * 86_400_000,
    })
    const sent = await dispatch(store, "run-1", token, 100_000, "panel:member:panel_b:1")
    const prepareAgain = (fencingToken: number) =>
      store.prepareCall("run-1", fencingToken, {
        logicalStepId: "panel:member:panel_b:1",
        role: "panel_b",
        deploymentId: "fake-baseline",
        reserveMicrousd: 100_000,
        requestHash: "hash",
      })
    await store.markUnknown(sent, "timeout_after_send")
    await expect(prepareAgain(token)).resolves.toEqual({
      kind: "refused",
      code: "STEP_OUTCOME_UNKNOWN",
    })
    // Reconciled means billed, not answered: the step still is not sent twice.
    clock.t += 25 * 60 * 60 * 1000
    expect(await store.reconcileExpiredUnknown(24 * 60 * 60 * 1000)).toBe(1)
    const reopened = await store.acquireLease("run-1", "worker-b", 60_000)
    if (!reopened.ok) throw new Error(reopened.code)
    await expect(prepareAgain(reopened.fencingToken)).resolves.toEqual({
      kind: "refused",
      code: "STEP_OUTCOME_UNKNOWN",
    })
    expect((await store.getRun("run-1"))?.driver).toBe("orchestrator")
  })

  it("[ACC:REC-03] settles what a lapsed lease holder left in flight before the new holder sends", async () => {
    const { store, clock } = harness()
    const token = await running(store, "run-1", { driver: "orchestrator" })
    const done = await dispatch(store, "run-1", token, 100_000, "panel:member:panel_a:1")
    await store.settleCall(done, {
      status: "succeeded",
      usage: usageCosting(1_000, 1_000),
      semantics: SEMANTICS,
      providerRequestId: "r-a",
      result: { text: "candidate A", providerRequestId: "r-a", finishReason: "stop" },
    })
    const inFlight = await dispatch(store, "run-1", token, 100_000, "panel:member:panel_b:1")
    const neverSent = await store.prepareCall("run-1", token, {
      logicalStepId: "panel:judge:1",
      role: "judge",
      deploymentId: "fake-baseline",
      reserveMicrousd: 150_000,
      requestHash: "hash",
    })
    if (neverSent.kind !== "granted") throw new Error("judge not granted")
    const before = (await store.getRun("run-1"))!.budget

    clock.t += 61_000
    const takeover = await store.acquireLease("run-1", "worker-b", 60_000)
    if (!takeover.ok) throw new Error(takeover.code)
    expect(takeover).toMatchObject({ takeover: true, fencingToken: token + 1 })
    // The old holder can no longer send what it prepared.
    await expect(store.markDispatched(neverSent.attemptId, token)).resolves.toMatchObject({
      ok: false,
    })
    expect(await store.settleOrphanedAttempts("run-1", takeover.fencingToken)).toEqual({
      abandoned: 1,
      unknown: 1,
    })
    // Idempotent: a second worker's sweep finds nothing left.
    expect(await store.settleOrphanedAttempts("run-1", takeover.fencingToken)).toEqual({
      abandoned: 0,
      unknown: 0,
    })
    const summary = await store.runSummary("run-1")
    const states = Object.fromEntries(summary!.attempts.map((a) => [a.logicalStepId, a.state]))
    expect(states).toEqual({
      "panel:member:panel_a:1": "SUCCEEDED",
      "panel:member:panel_b:1": "UNKNOWN",
      "panel:judge:1": "ABANDONED",
    })
    expect(summary!.uncertainMicrousd).toBe(100_000)
    // The abandoned judge gave its money and its call slot back.
    const after = summary!.run.budget
    expect(after.activeReservationsMicrousd).toBe(before.activeReservationsMicrousd - 150_000)
    expect(after.modelCalls).toBe(before.modelCalls - 1)

    const next = (logicalStepId: string) =>
      store.prepareCall("run-1", takeover.fencingToken, {
        logicalStepId,
        role: "panel",
        deploymentId: "fake-baseline",
        reserveMicrousd: 100_000,
        requestHash: "hash",
      })
    await expect(next("panel:member:panel_a:1")).resolves.toMatchObject({ kind: "replay" })
    await expect(next("panel:member:panel_b:1")).resolves.toEqual({
      kind: "refused",
      code: "STEP_OUTCOME_UNKNOWN",
    })
    await expect(next("panel:judge:1")).resolves.toMatchObject({ kind: "granted", attemptNo: 2 })
    expect(inFlight).not.toBe(done)
  })

  it("[ACC:BUD-07] books late usage after cancel without reopening the run", async () => {
    const { store, db } = harness()
    const token = await running(store, "run-1")
    const attemptId = await dispatch(store, "run-1", token, 300_000)
    await store.cancelRun("run-1")
    const sealed = await store.finalizeRun("run-1", token, { status: "cancelled" })
    expect(sealed.ok && sealed.run.status).toBe("cancelled")

    await store.settleCall(attemptId, {
      status: "succeeded",
      usage: usageCosting(100_000, 50_000),
      semantics: SEMANTICS,
      providerRequestId: "late",
    })
    const run = await store.getRun("run-1")
    expect(run?.status).toBe("cancelled")
    expect(run?.budget.spentMicrousd).toBe(200_000)
    expect(run?.costStatus).toBe("actual")
    expect(run?.resultArtifactId).toBeNull()
    const events = await store.listEvents("run-1")
    expect(events.filter((e) => e.type === "run.cancelled")).toHaveLength(1)
    expect(events.some((e) => e.type === "answer.completed")).toBe(false)
    expect((await store.getAccount()).activeHoldsMicrousd).toBe(0)
    expect((await db.fusionCallAttempts.get(attemptId))?.state).toBe("RECONCILED")
  })

  it("[ACC:BUD-09] records the full overrun, freezes the run and refuses the next call", async () => {
    const { store, db } = harness()
    const token = await running(store, "run-1")
    const attemptId = await dispatch(store, "run-1", token, 100_000)
    const outcome = await store.settleCall(attemptId, {
      status: "succeeded",
      usage: usageCosting(100_000, 50_000),
      semantics: SEMANTICS,
      providerRequestId: "r",
    })
    expect(outcome).toMatchObject({ actualMicrousd: 200_000, frozen: true })
    const run = await store.getRun("run-1")
    expect(run?.budget).toMatchObject({
      spentMicrousd: 200_000,
      overspendMicrousd: 100_000,
      frozen: true,
    })
    expect((await db.fusionLedger.get(`overspend:${attemptId}`))?.amountMicrousd).toBe(100_000)
    await expect(
      store.prepareCall("run-1", token, {
        logicalStepId: "next",
        role: "solver",
        deploymentId: "fake-baseline",
        reserveMicrousd: 1,
        requestHash: "h",
      })
    ).resolves.toEqual({ kind: "refused", code: "BUDGET_FROZEN" })
  })

  it("[ACC:BUD-10] admits at most one more call when 23 of 24 are used, even concurrently", async () => {
    const { store } = harness()
    const token = await running(store, "run-1", { maxModelCalls: 24 })
    for (let i = 0; i < 23; i += 1) {
      await store.prepareCall("run-1", token, {
        logicalStepId: `s${i}`,
        role: "solver",
        deploymentId: "fake-baseline",
        reserveMicrousd: 1,
        requestHash: "h",
      })
    }
    const prepare = (step: string) =>
      store.prepareCall("run-1", token, {
        logicalStepId: step,
        role: "solver",
        deploymentId: "fake-baseline",
        reserveMicrousd: 1,
        requestHash: "h",
      })
    const results = await Promise.all([prepare("x"), prepare("y")])
    expect(results.filter((r) => r.kind === "granted")).toHaveLength(1)
    expect(results.find((r) => r.kind === "refused")).toEqual({
      kind: "refused",
      code: "MAX_MODEL_CALLS",
    })
    expect((await store.getRun("run-1"))?.budget.modelCalls).toBe(24)
  })

  it("[ACC:BUD-11] slices the run cap without charging the tenant twice", async () => {
    const { store } = harness()
    const token = await running(store, "run-1", { capMicrousd: 1 * USD })
    const a = await dispatch(store, "run-1", token, 200_000)
    await dispatch(store, "run-1", token, 300_000)
    // 50k input × $1/M + 25k output × $2/M = $0.10
    await store.settleCall(a, {
      status: "succeeded",
      usage: usageCosting(50_000, 25_000),
      semantics: SEMANTICS,
      providerRequestId: "a",
    })
    const run = await store.getRun("run-1")
    expect(store.runAvailable(run!)).toBe(600_000)
    expect(run?.budget.tenantHoldMicrousd).toBe(900_000)
    expect((await store.getAccount()).activeHoldsMicrousd).toBe(900_000)
  })

  it("[ACC:BUD-12] converts a held stage into the real call instead of reserving again", async () => {
    const { store, db } = harness()
    const token = await running(store, "run-1", { capMicrousd: 1 * USD })
    expect(await store.reserveStage("run-1", token, "judge", 500_000)).toEqual({ kind: "granted" })
    const before = await store.getRun("run-1")
    expect(before?.budget.activeReservationsMicrousd).toBe(500_000)
    const outcome = await store.prepareCall("run-1", token, {
      logicalStepId: "judge-call",
      role: "judge",
      deploymentId: "fake-baseline",
      reserveMicrousd: 400_000,
      fromStageId: "judge",
      requestHash: "h",
    })
    expect(outcome.kind).toBe("granted")
    const after = await store.getRun("run-1")
    expect(after?.budget.activeReservationsMicrousd).toBe(500_000)
    const stage = await db.fusionReservations.get("stage:run-1:judge")
    expect(stage).toMatchObject({ amountMicrousd: 100_000, state: "held" })
    expect(await db.fusionLedger.where("kind").equals("stage_convert").count()).toBe(1)
  })

  it("[ACC:REC-01] replays a committed call result instead of calling again", async () => {
    const { store, db } = harness()
    const token = await running(store, "run-1")
    const attemptId = await dispatch(store, "run-1", token, 300_000, "solver:1")
    await store.settleCall(attemptId, {
      status: "succeeded",
      usage: usageCosting(1_000, 1_000),
      semantics: SEMANTICS,
      providerRequestId: "req-committed",
      result: {
        text: "the committed answer",
        providerRequestId: "req-committed",
        finishReason: "stop",
      },
    })
    const again = await store.prepareCall("run-1", token, {
      logicalStepId: "solver:1",
      role: "solver",
      deploymentId: "fake-baseline",
      reserveMicrousd: 300_000,
      requestHash: "hash",
    })
    expect(again).toEqual({
      kind: "replay",
      result: {
        text: "the committed answer",
        providerRequestId: "req-committed",
        finishReason: "stop",
      },
    })
    expect(await db.fusionCallAttempts.count()).toBe(1)
  })

  it("[ACC:REC-03] replays a tool round's requests, not just its text", async () => {
    const { store, db } = harness()
    const token = await running(store, "run-1")
    const attemptId = await dispatch(store, "run-1", token, 300_000, "panel:member:panel_a:1")
    const toolCalls = [
      { id: "call_1", name: "web_fetch", arguments: { url: "https://example.com/tariffs" } },
    ]
    await store.settleCall(attemptId, {
      status: "succeeded",
      usage: usageCosting(1_000, 100),
      semantics: SEMANTICS,
      providerRequestId: "req-tools",
      result: { text: "", providerRequestId: "req-tools", finishReason: "tool_calls", toolCalls },
    })
    const again = await store.prepareCall("run-1", token, {
      logicalStepId: "panel:member:panel_a:1",
      role: "panel_a",
      deploymentId: "fake-baseline",
      reserveMicrousd: 300_000,
      requestHash: "hash",
    })
    // Without the requests a resumed panel sees a tool-call step with no calls
    // and throws the candidate away.
    expect(again).toEqual({
      kind: "replay",
      result: {
        text: "",
        providerRequestId: "req-tools",
        finishReason: "tool_calls",
        toolCalls,
      },
    })
    // The requests live inside the committed result's own artifact: no new
    // table, no new column, nothing in the journal.
    const artifact = await db.fusionArtifacts
      .where("runId")
      .equals("run-1")
      .filter((row) => row.namespace === `call:${attemptId}`)
      .first()
    expect(artifact?.mediaType).toBe(CALL_RESULT_WITH_TOOLS_MEDIA_TYPE)
    expect(await db.fusionCallAttempts.count()).toBe(1)
  })

  it("keeps reading a committed result stored before tool calls were part of it", async () => {
    const { store } = harness()
    const token = await running(store, "run-1")
    const attemptId = await dispatch(store, "run-1", token, 300_000, "solver:1")
    await store.settleCall(attemptId, {
      status: "succeeded",
      usage: usageCosting(1_000, 1_000),
      semantics: SEMANTICS,
      providerRequestId: "req-plain",
      result: { text: "plain text", providerRequestId: "req-plain", finishReason: "stop" },
    })
    const again = await store.prepareCall("run-1", token, {
      logicalStepId: "solver:1",
      role: "solver",
      deploymentId: "fake-baseline",
      reserveMicrousd: 300_000,
      requestHash: "hash",
    })
    expect(again).toEqual({
      kind: "replay",
      result: { text: "plain text", providerRequestId: "req-plain", finishReason: "stop" },
    })
  })

  it("[ACC:REC-02] fences a stale worker but still books the bill it observed", async () => {
    const { store, clock } = harness()
    const oldToken = await running(store, "run-1")
    const attemptId = await dispatch(store, "run-1", oldToken, 300_000)
    clock.t += 61_000
    const takeover = await store.acquireLease("run-1", "worker-b", 60_000)
    expect(takeover).toMatchObject({ ok: true, takeover: true })
    const newToken = (takeover as { fencingToken: number }).fencingToken
    expect(newToken).toBeGreaterThan(oldToken)

    await expect(
      store.prepareCall("run-1", oldToken, {
        logicalStepId: "late",
        role: "solver",
        deploymentId: "fake-baseline",
        reserveMicrousd: 1,
        requestHash: "h",
      })
    ).resolves.toEqual({ kind: "refused", code: "FENCED" })
    expect(await store.finalizeRun("run-1", oldToken, { status: "succeeded" })).toEqual({
      ok: false,
      code: "FENCED",
    })
    await store.settleCall(attemptId, {
      status: "succeeded",
      usage: usageCosting(100_000, 50_000),
      semantics: SEMANTICS,
      providerRequestId: "old-worker",
    })
    expect((await store.getRun("run-1"))?.budget.spentMicrousd).toBe(200_000)
    expect((await store.getRun("run-1"))?.status).toBe("running")
  })

  it("[ACC:REC-04] lets exactly one of a concurrent finalize and cancel win", async () => {
    const { store, db } = harness()
    const token = await running(store, "run-1", { sessionId: "s1" })
    const [finalized] = await Promise.all([
      store.finalizeRun("run-1", token, { status: "succeeded" }),
      store
        .cancelRun("run-1")
        .then(() => store.finalizeRun("run-1", token, { status: "cancelled" })),
    ])
    expect(finalized.ok).toBe(true)
    const events = await store.listEvents("run-1")
    const terminal = events.filter((e) =>
      ["run.completed", "run.cancelled", "run.failed"].includes(e.type)
    )
    expect(terminal).toHaveLength(1)
    const run = await store.getRun("run-1")
    expect(["succeeded", "cancelled"]).toContain(run?.status)
    expect(await db.fusionOutbox.where("kind").equals("execution_run_milestone").count()).toBe(1)
    expect(await db.fusionSessionLocks.get("s1")).toBeUndefined()
    // Event sequence numbers are contiguous.
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
  })

  it("[ACC:REC-05] keeps the original deadline across a resume and stops calls after it", async () => {
    const { store, clock } = harness()
    const token = await running(store, "run-1", { deadlineMs: 10_000 })
    const deadlineAt = (await store.getRun("run-1"))!.deadlineAt
    expect(await store.pauseRun("run-1", token, "waiting_for_input")).toEqual({ ok: true })
    clock.t += 9_000
    const resumed = await store.resumeRun("run-1")
    expect(resumed.ok && resumed.run.deadlineAt).toBe(deadlineAt)
    await store.startRun("run-1", token)
    clock.t += 2_000
    await expect(
      store.prepareCall("run-1", token, {
        logicalStepId: "after-deadline",
        role: "solver",
        deploymentId: "fake-baseline",
        reserveMicrousd: 1,
        requestHash: "h",
      })
    ).resolves.toEqual({ kind: "refused", code: "DEADLINE_EXCEEDED" })
    await store.pauseRun("run-1", token, "waiting_for_input")
    expect(await store.resumeRun("run-1")).toEqual({ ok: false, code: "DEADLINE_EXCEEDED" })
  })

  it("[ACC:API-07] refuses to resume a run that is running normally", async () => {
    const { store } = harness()
    await running(store, "run-1")
    expect(await store.resumeRun("run-1")).toEqual({ ok: false, code: "RUN_NOT_WAITING" })
  })

  it("[ACC:AUTH-07] stops new calls to a deployment revoked after the run pinned its config", async () => {
    const { store } = harness()
    const token = await running(store, "run-1")
    await store.setRevokedDeployments(["fake-baseline"])
    await expect(
      store.prepareCall("run-1", token, {
        logicalStepId: "after-revoke",
        role: "solver",
        deploymentId: "fake-baseline",
        reserveMicrousd: 1,
        requestHash: "h",
      })
    ).resolves.toEqual({ kind: "refused", code: "REVOKED" })
    await store.setRevokedDeployments([])
    expect(
      (
        await store.prepareCall("run-1", token, {
          logicalStepId: "after-restore",
          role: "solver",
          deploymentId: "fake-baseline",
          reserveMicrousd: 1,
          requestHash: "h",
        })
      ).kind
    ).toBe("granted")
  })

  it("abandons an attempt whose run stopped between prepare and dispatch", async () => {
    const { store, db } = harness()
    const token = await running(store, "run-1")
    const prepared = await store.prepareCall("run-1", token, {
      logicalStepId: "s",
      role: "solver",
      deploymentId: "fake-baseline",
      reserveMicrousd: 100,
      requestHash: "h",
    })
    if (prepared.kind !== "granted") throw new Error("expected grant")
    await store.cancelRun("run-1")
    expect(await store.markDispatched(prepared.attemptId, token)).toEqual({
      ok: false,
      code: "RUN_NOT_RUNNING",
    })
    expect((await db.fusionCallAttempts.get(prepared.attemptId))?.state).toBe("ABANDONED")
    const run = await store.getRun("run-1")
    expect(run?.budget).toMatchObject({ modelCalls: 0, activeReservationsMicrousd: 0 })
  })

  it("limits transport attempts per logical step and books success without usage as an estimate", async () => {
    const { store } = harness()
    const token = await running(store, "run-1")
    const first = await dispatch(store, "run-1", token, 1_000, "leg:1")
    await store.settleCall(first, {
      status: "failed",
      usage: null,
      semantics: null,
      providerRequestId: null,
      errorClass: "rate_limited",
    })
    const second = await dispatch(store, "run-1", token, 2_000, "leg:1")
    const settled = await store.settleCall(second, {
      status: "succeeded",
      usage: null,
      semantics: null,
      providerRequestId: "no-usage",
    })
    expect(settled).toMatchObject({ actualMicrousd: 2_000, costStatus: "estimated" })
    const summary = await store.runSummary("run-1")
    expect(summary?.run.costStatus).toBe("estimated")
    await expect(
      store.prepareCall("run-1", token, {
        logicalStepId: "leg:2",
        role: "solver",
        deploymentId: "fake-baseline",
        reserveMicrousd: 1,
        requestHash: "h",
      })
    ).resolves.toMatchObject({ kind: "granted" })
  })

  it("downgrades a success that still has an unknown call to failed", async () => {
    const { store } = harness()
    const token = await running(store, "run-1")
    await dispatch(store, "run-1", token, 1_000)
    const sealed = await store.finalizeRun("run-1", token, { status: "succeeded" })
    expect(sealed.ok && sealed.run.status).toBe("failed")
    expect(sealed.ok && sealed.run.error?.code).toBe("CALL_OUTCOME_UNKNOWN")
  })

  it("books observed envelope calls from the stage, then overspends and freezes past it", async () => {
    const { store, db } = harness()
    const token = await running(store, "run-1", { capMicrousd: 1 * USD })
    await store.reserveStage("run-1", token, "envelope", 300_000)
    const observe = (step: string) =>
      store.recordObservedCall("run-1", {
        logicalStepId: step,
        role: "solver",
        deploymentId: "fake-baseline",
        stageId: "envelope",
        status: "succeeded",
        // $0.20 each on fake-baseline
        usage: usageCosting(100_000, 50_000),
        semantics: SEMANTICS,
        providerRequestId: step,
        conservativeMicrousd: 50_000,
      })
    const first = await observe("msg_1")
    expect(first).toMatchObject({ actualMicrousd: 200_000, frozen: false, duplicate: false })
    expect(await observe("msg_1")).toMatchObject({ duplicate: true, attemptId: first.attemptId })
    let run = await store.getRun("run-1")
    expect(run?.budget).toMatchObject({
      spentMicrousd: 200_000,
      activeReservationsMicrousd: 100_000,
    })

    const second = await observe("msg_2")
    expect(second.frozen).toBe(true)
    run = await store.getRun("run-1")
    expect(run?.budget).toMatchObject({
      spentMicrousd: 400_000,
      overspendMicrousd: 100_000,
      activeReservationsMicrousd: 0,
      frozen: true,
      modelCalls: 2,
    })
    expect(await db.fusionLedger.where("kind").equals("settle").count()).toBe(2)
    // A frozen run admits nothing else, but the tenant hold never went negative.
    expect(run?.budget.tenantHoldMicrousd).toBe(600_000)
    expect((await store.getAccount()).activeHoldsMicrousd).toBe(600_000)
  })

  it("books an observed call without a bill at its conservative estimate", async () => {
    const { store } = harness()
    await running(store, "run-1")
    const booked = await store.recordObservedCall("run-1", {
      logicalStepId: "msg_x",
      role: "solver",
      deploymentId: "fake-baseline",
      stageId: "envelope",
      status: "succeeded",
      usage: null,
      semantics: null,
      providerRequestId: null,
      conservativeMicrousd: 70_000,
    })
    expect(booked.actualMicrousd).toBe(70_000)
    expect((await store.getRun("run-1"))?.costStatus).toBe("estimated")
  })

  it("verifies artifact integrity on read", async () => {
    const { store, db } = harness()
    const artifacts = store.artifactStore("run-1")
    const stored = await artifacts.put("hello", "text/plain", "answer")
    expect((await artifacts.get(stored.artifactId))?.content).toBe("hello")
    await db.fusionArtifacts.update(stored.artifactId, { content: "tampered" })
    await expect(artifacts.get(stored.artifactId)).rejects.toThrow(/integrity/)
  })

  it("keeps machine codes and withholds free text that could quote a prompt or an answer", async () => {
    expect(persistableText("timeout_after_send")).toBe("timeout_after_send")
    expect(persistableText("HTTP_429:rate-limit.v2")).toBe("HTTP_429:rate-limit.v2")
    expect(persistableText('Unexpected token in JSON: {"answer": "the secret"')).toBe(WITHHELD_TEXT)
    expect(persistableText("")).toBe(WITHHELD_TEXT)

    const { store, db } = harness()
    const token = await running(store, "run-1")
    const attemptId = await dispatch(store, "run-1", token, 100_000)
    await store.markUnknown(attemptId, "Failed to parse stream chunk: my private prompt")
    const finalized = await store.finalizeRun("run-1", token, {
      status: "failed",
      error: { code: "TURN_ERROR", message: "Model output was: my private answer" },
    })
    expect(finalized.ok && finalized.run.error).toEqual({
      code: "TURN_ERROR",
      message: WITHHELD_TEXT,
    })
    expect((await db.fusionCallAttempts.get(attemptId))?.unknownReason).toBe(WITHHELD_TEXT)
    const everything = JSON.stringify([
      await db.fusionRuns.toArray(),
      await db.fusionRunEvents.toArray(),
      await db.fusionCallAttempts.toArray(),
    ])
    expect(everything).not.toContain("private")
  })

  it("remembers the phase a graph announced, for the run snapshot", async () => {
    const { store } = harness()
    const token = await running(store, "phase-1")
    await store.appendWorkflowEvent("phase-1", token, "phase.changed", {
      phase: "judge",
      candidates: 2,
    })
    expect((await store.getRun("phase-1"))?.phase).toBe("judge")
    // A status transition is not a graph phase.
    await store.appendWorkflowEvent("phase-1", token, "call.started", { phase: "ignored" })
    expect((await store.getRun("phase-1"))?.phase).toBe("judge")
  })

  it("commits the answer's delivery events with the seal, before anything says it succeeded", async () => {
    const { store } = harness()
    const token = await running(store, "deliver-1")
    await store.finalizeRun("deliver-1", token, {
      status: "succeeded",
      events: [
        { type: "answer.delta", payload: { index: 0 } },
        { type: "answer.completed", payload: { chunks: 1 } },
      ],
    })
    const types = (await store.listEvents("deliver-1")).map((event) => event.type)
    expect(types.slice(-5)).toEqual([
      "answer.delta",
      "answer.completed",
      "phase.changed",
      "billing.updated",
      "run.completed",
    ])
  })

  it("never delivers an answer for a run that did not succeed", async () => {
    const { store } = harness()
    const token = await running(store, "deliver-2")
    await store.finalizeRun("deliver-2", token, {
      status: "failed",
      error: { code: "VERIFICATION_FAILED", message: "no" },
      events: [{ type: "answer.completed", payload: {} }],
    })
    const types = (await store.listEvents("deliver-2")).map((event) => event.type)
    expect(types).not.toContain("answer.completed")
    expect(types.at(-1)).toBe("run.failed")
  })

  it("writes only a chat fusion turn's answer, with its run summary, and nothing when it fails", async () => {
    const { store, db } = harness()
    const session = { sessionId: "chat-1", expectedSessionVersion: 0, currentSessionVersion: 0 }
    const answerRun = async (runId: string) =>
      running(store, runId, {
        ...session,
        actionId: "panel_review",
        roleDeployments: {
          panel_a: "fake-economy",
          panel_b: "fake-independent",
          judge: "fake-baseline",
          synthesizer: "fake-baseline",
        },
        writesSessionAnswer: true,
        inputArtifactId: "input-1",
      })
    const token = await answerRun("chat-run-1")
    // The chat path wrote the person's message itself: no input effect.
    expect(await db.fusionOutbox.where("kind").equals("session_message").count()).toBe(0)
    await store.appendWorkflowEvent("chat-run-1", token, "phase.changed", {
      phase: "prepare",
      members: 2,
    })
    const answer = await store
      .artifactStore("chat-run-1")
      .put("the answer", "text/plain", "runs/chat-run-1/answer")
    await store.finalizeRun("chat-run-1", token, {
      status: "succeeded",
      resultArtifactId: answer.artifactId,
      events: [
        {
          type: "answer.completed",
          payload: {
            quality_status: "accepted",
            verification_status: "passed",
            verification_level: "mixed",
          },
        },
      ],
    })
    const effects = await db.fusionOutbox.where("kind").equals("session_message").toArray()
    expect(effects.map((row) => row.effectId)).toEqual(["session:chat-run-1:answer"])
    expect(effects[0].payload).toMatchObject({
      phase: "answer",
      origin: "chat",
      sessionId: "chat-1",
      answerArtifactId: answer.artifactId,
      mode: "panel",
      summary: {
        runId: "chat-run-1",
        mode: "panel",
        actionId: "panel_review",
        status: "succeeded",
        qualityStatus: "accepted",
        timeline: {
          candidates: { members: 2 },
          verification: { status: "passed", level: "mixed" },
        },
      },
    })
    // The session stays busy until the answer is in it.
    await expect(store.createRun(runInput("chat-run-2", session))).resolves.toMatchObject({
      ok: false,
      code: "SESSION_BUSY",
    })
    await db.fusionOutbox.update("session:chat-run-1:answer", { status: "applied" })

    const failedToken = await answerRun("chat-run-3")
    await store.finalizeRun("chat-run-3", failedToken, {
      status: "failed",
      error: { code: "VERIFICATION_FAILED", message: "no" },
    })
    expect(
      (await db.fusionOutbox.where("kind").equals("session_message").toArray()).map(
        (row) => row.effectId
      )
    ).toEqual(["session:chat-run-1:answer"])
  })

  it("hands an outbox drain the store's decrypted artifacts", async () => {
    const { store } = harness()
    const stored = await store.artifactStore("r").put("secret text", "text/plain", "n")
    const context = store.outboxContext()
    await expect(context.readArtifact(stored.artifactId)).resolves.toBe("secret text")
    await expect(context.readArtifact("00000000-0000-4000-8000-000000000000")).resolves.toBeNull()
  })

  describe("execution run projection", () => {
    it("queues one projection effect per lifecycle phase of a Run API run", async () => {
      const { store, db } = harness()
      const token = await running(store, "run-api-1", {
        surface: "gatewayRuns",
        origin: "gateway",
        actorKeyId: "key-a",
        actorKeyName: "CI robot",
        title: "Summarise the release notes",
      })
      await store.finalizeRun("run-api-1", token, { status: "succeeded" })
      const effects = await db.fusionOutbox.where("runId").equals("run-api-1").toArray()
      const projections = effects.filter((row) => row.kind === "execution_run_projection")
      expect(projections.map((row) => row.effectId).sort()).toEqual([
        "projection:run-api-1:queued",
        "projection:run-api-1:running",
        "projection:run-api-1:terminal",
      ])
      expect(projections[0].payload).toMatchObject({
        origin: "gateway-api",
        title: "Summarise the release notes",
        actorKeyName: "CI robot",
      })
      expect(projections.find((row) => row.effectId.endsWith(":terminal"))?.payload).toMatchObject({
        status: "succeeded",
      })
    })

    it("writes a Run API run's conversation: input on creation, answer on success", async () => {
      const { store, db } = harness()
      const input = await store
        .artifactStore("gw-1")
        .put("[]", "application/json", "runs/gw-1/input")
      const token = await running(store, "gw-1", {
        surface: "gatewayRuns",
        origin: "gateway",
        sessionId: "session-gw",
        inputArtifactId: input.artifactId,
        writesSessionTranscript: true,
        actorKeyName: "CI robot",
      })
      const answer = await store
        .artifactStore("gw-1")
        .put("done", "text/markdown", "runs/gw-1/answer")
      await store.finalizeRun("gw-1", token, {
        status: "succeeded",
        resultArtifactId: answer.artifactId,
      })
      const effects = (
        await db.fusionOutbox.where("kind").equals("session_message").toArray()
      ).sort((a, b) => a.effectId.localeCompare(b.effectId))
      expect(effects.map((row) => [row.effectId, row.payload])).toEqual([
        [
          "session:gw-1:answer",
          {
            phase: "answer",
            runId: "gw-1",
            sessionId: "session-gw",
            answerArtifactId: answer.artifactId,
            mode: "direct",
          },
        ],
        [
          "session:gw-1:input",
          {
            phase: "input",
            runId: "gw-1",
            sessionId: "session-gw",
            inputArtifactId: input.artifactId,
            actorKeyName: "CI robot",
          },
        ],
      ])
      // Ids and codes only: the rows never hold what was said.
      expect(JSON.stringify(effects)).not.toContain("done")
    })

    it("marks a failed Run API run's input and queues no answer", async () => {
      const { store, db } = harness()
      const input = await store
        .artifactStore("gw-2")
        .put("[]", "application/json", "runs/gw-2/input")
      const token = await running(store, "gw-2", {
        surface: "gatewayRuns",
        origin: "gateway",
        sessionId: "session-gw2",
        inputArtifactId: input.artifactId,
        writesSessionTranscript: true,
      })
      await store.finalizeRun("gw-2", token, {
        status: "failed",
        error: { code: "VERIFICATION_FAILED", message: "the synthesis failed" },
      })
      const ids = (await db.fusionOutbox.where("kind").equals("session_message").toArray()).map(
        (r) => r.effectId
      )
      expect(ids.sort()).toEqual(["session:gw-2:input", "session:gw-2:marker"])
      expect((await db.fusionOutbox.get("session:gw-2:marker"))?.payload).toMatchObject({
        status: "failed",
        errorCode: "VERIFICATION_FAILED",
      })
    })

    it("keeps the session busy until the previous run's transcript is written", async () => {
      const { store, db } = harness()
      const input = await store
        .artifactStore("gw-3")
        .put("[]", "application/json", "runs/gw-3/input")
      const token = await running(store, "gw-3", {
        surface: "gatewayRuns",
        origin: "gateway",
        sessionId: "session-gw3",
        inputArtifactId: input.artifactId,
        writesSessionTranscript: true,
      })
      await store.finalizeRun("gw-3", token, {
        status: "succeeded",
        resultArtifactId: input.artifactId,
      })
      // The lock is gone, but the answer is not in the session yet.
      expect(await db.fusionSessionLocks.get("session-gw3")).toBeUndefined()
      await expect(
        store.createRun(runInput("gw-4", { sessionId: "session-gw3" }))
      ).resolves.toMatchObject({
        ok: false,
        code: "SESSION_BUSY",
        activeRunId: "gw-3",
      })
      await db.fusionOutbox.where("kind").equals("session_message").modify({ status: "applied" })
      await expect(
        store.createRun(runInput("gw-4", { sessionId: "session-gw3" }))
      ).resolves.toMatchObject({
        ok: true,
      })
    })

    it("leaves a chat turn's transcript to the chat path", async () => {
      const { store, db } = harness()
      const token = await running(store, "chat-t", { sessionId: "session-chat" })
      await store.finalizeRun("chat-t", token, { status: "succeeded" })
      expect(await db.fusionOutbox.where("kind").equals("session_message").count()).toBe(0)
    })

    it("queues none for work that already owns an execution run", async () => {
      const { store, db } = harness()
      // A routed chat turn is still the chat turn's run; a second row here
      // would double-count one piece of work in every list that reads it.
      const token = await running(store, "chat-1")
      await store.finalizeRun("chat-1", token, { status: "succeeded" })
      const kinds = (await db.fusionOutbox.toArray()).map((row) => row.kind)
      expect(kinds).not.toContain("execution_run_projection")
    })
  })
})

describe("committed call results", () => {
  it("stores bare text when nothing was requested, and an envelope when something was", () => {
    expect(
      encodeCommittedCallResult({ text: "hi", providerRequestId: null, finishReason: "stop" })
    ).toEqual({ content: "hi", mediaType: "text/plain" })
    const withTools = encodeCommittedCallResult({
      text: "",
      providerRequestId: null,
      finishReason: "tool_calls",
      toolCalls: [{ id: "c1", name: "web_fetch", arguments: { url: "u" } }],
    })
    expect(withTools.mediaType).toBe(CALL_RESULT_WITH_TOOLS_MEDIA_TYPE)
    expect(decodeCommittedCallResult(withTools.content, withTools.mediaType)).toEqual({
      text: "",
      toolCalls: [{ id: "c1", name: "web_fetch", arguments: { url: "u" } }],
    })
  })

  it("reads a stored result that is not an envelope, and refuses to invent one", () => {
    expect(decodeCommittedCallResult("plain", "text/plain")).toEqual({ text: "plain" })
    // A corrupted envelope is still a committed step: it replays with no
    // requests rather than being sent a second time.
    expect(decodeCommittedCallResult("{oops", CALL_RESULT_WITH_TOOLS_MEDIA_TYPE)).toEqual({
      text: "",
    })
    expect(
      decodeCommittedCallResult(
        JSON.stringify({ text: "t", tool_calls: [{ id: 1, name: "x" }] }),
        CALL_RESULT_WITH_TOOLS_MEDIA_TYPE
      )
    ).toEqual({ text: "t" })
  })
})
