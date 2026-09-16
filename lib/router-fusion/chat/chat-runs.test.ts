import "fake-indexeddb/auto"

import { fakeCompiledConfig, fixtureRouteRequest, routeAction } from "@cognia/router-fusion"
import type { CallAttemptResultEvent, CallReserveRequestEvent } from "@cognia/agent-config-types"

import { fusionContentCodec } from "../db/content-codec"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore } from "../db/ledger-store"
import type { OutboxAppliers } from "../db/outbox"
import {
  __resetChatRunsForTesting,
  abortChatRunBeforeDispatch,
  activeChatRunId,
  answerCallReserve,
  apiRetryErrorClass,
  beginChatRun,
  callReserveFor,
  cancelChatRun,
  finalizeChatRun,
  MAX_PREPARED_CHAT_ROUTES,
  observeEnvelopeMessage,
  preparedChatRoute,
  rawUsageFromAnthropic,
  recordCallAttemptResult,
  recoverStaleFusionRuns,
  rememberChatRoute,
  roleCallErrorClassOf,
  type ChatRunDeps,
  type PreparedChatRoute,
} from "./chat-runs"

const USD = 1_000_000
const config = fakeCompiledConfig()
let dbCounter = 0

function harness(
  options: { leaseOwner?: string; store?: FusionLedgerStore; clock?: { t: number } } = {}
) {
  const clock = options.clock ?? { t: 1_700_000_000_000 }
  let store = options.store
  if (!store) {
    const name = `chat-runs-test-${++dbCounter}`
    let ids = 0
    store = new FusionLedgerStore({
      db: new FusionDB(name),
      codec: fusionContentCodec(name),
      now: () => clock.t,
      newId: () => `attempt-${++ids}`,
    })
  }
  const applied: string[] = []
  const appliers: OutboxAppliers = {
    usage_row: async (row) => {
      applied.push(row.effectId)
      return "applied"
    },
    execution_run_milestone: async (row) => {
      applied.push(row.effectId)
      return "applied"
    },
    execution_run_projection: async (row) => {
      applied.push(row.effectId)
      return "applied"
    },
    session_message: async (row) => {
      applied.push(row.effectId)
      return "applied"
    },
  }
  const faults: string[] = []
  const deps: ChatRunDeps = {
    store: async () => store,
    appliers,
    leaseOwner: options.leaseOwner ?? "window-a",
    now: () => clock.t,
    onFault: (fault) => faults.push(fault.code),
  }
  return { store, deps, clock, applied, faults }
}

function route(
  runId: string,
  overrides: Partial<PreparedChatRoute> & { mode?: "per_call" | "envelope" } = {}
): PreparedChatRoute {
  const { decision } = routeAction(
    config,
    fixtureRouteRequest({ runId, decisionId: `decision-${runId}` })
  )
  const mode = overrides.mode ?? "per_call"
  return {
    stamp: {
      runId,
      decisionId: decision.decision_id,
      actionId: "direct_baseline",
      mode: "direct",
      ruleId: "R6_baseline",
      deploymentId: "fake-baseline",
      providerId: "fake",
      modelId: "mock/baseline-v1",
      budgetMode: "tracked",
      capMicrousd: 1 * USD,
      reserveEstimateMicrousd: 50_000,
      priceKnown: true,
      acceptanceProfile: "text_basic",
      lane: mode === "envelope" ? "claude-agent-sdk" : "ai-sdk",
    },
    ledger: { runId, mode, transportAttempts: 2, deploymentId: "fake-baseline" },
    decision,
    config,
    sessionId: "session-1",
    dataClass: "internal",
    maxModelCalls: 256,
    deadlineMs: 3_600_000,
    unknownPriceCallReserveMicrousd: 200_000,
    liveRefusal: () => null,
    ...overrides,
  }
}

function reserveRequest(
  runId: string,
  overrides: Partial<CallReserveRequestEvent> = {}
): CallReserveRequestEvent {
  return {
    type: "call_reserve_request",
    sessionId: "session-1",
    runId,
    requestId: "req-1",
    kind: "call",
    logicalStepId: "leg:0",
    deploymentId: "fake-baseline",
    estimatedInputTokens: 10_000,
    maxOutputTokens: 1_000,
    ...overrides,
  }
}

function result(
  runId: string,
  attemptId: string,
  overrides: Partial<CallAttemptResultEvent> = {}
): CallAttemptResultEvent {
  return {
    type: "call_attempt_result",
    sessionId: "session-1",
    runId,
    attemptId,
    logicalStepId: "leg:0",
    status: "succeeded",
    usage: { inputTokens: 10_000, outputTokens: 500 },
    semantics: {
      inputIncludesCacheRead: true,
      inputIncludesCacheWrite: true,
      outputIncludesReasoning: true,
    },
    providerRequestId: "resp-1",
    ...overrides,
  }
}

async function started(
  runId: string,
  h: ReturnType<typeof harness>,
  overrides: Parameters<typeof route>[1] = {}
) {
  rememberChatRoute(route(runId, overrides))
  const outcome = await beginChatRun(runId, { tenantLimitRemainingMicrousd: null }, h.deps)
  if (outcome.kind !== "started") throw new Error(`begin refused: ${outcome.code}`)
  return outcome.run
}

describe("chat runs", () => {
  afterEach(() => {
    __resetChatRunsForTesting()
  })

  it("reserves, books and seals an AI SDK turn with the ledger's cost", async () => {
    const h = harness()
    await started("run-1", h)
    expect(activeChatRunId("session-1")).toBe("run-1")

    const granted = await answerCallReserve(reserveRequest("run-1"), h.deps)
    expect(granted).toEqual({
      answer: { decision: "granted", attemptId: "attempt-1", attemptNo: 1 },
      fault: null,
    })
    // 10k input at the highest input tier ($1/M) + 1k output at $2/M.
    expect((await h.store.runSummary("run-1"))?.reservedMicrousd).toBe(10_000 + 2_000)

    await recordCallAttemptResult(result("run-1", "attempt-1"), h.deps)
    const seal = await finalizeChatRun("session-1", { status: "succeeded" }, h.deps)
    expect(seal?.run).toMatchObject({ status: "succeeded", costStatus: "actual" })
    expect(seal?.run.budget.spentMicrousd).toBe(10_000 + 1_000)
    expect((await h.store.getAccount()).activeHoldsMicrousd).toBe(0)
    expect(activeChatRunId("session-1")).toBeUndefined()
    expect(h.faults).toEqual([])
  })

  it("bounds sealed routes a send never started, and treats a lost one as a fault", async () => {
    const h = harness()
    for (let i = 0; i <= MAX_PREPARED_CHAT_ROUTES; i += 1) rememberChatRoute(route(`run-${i}`))
    // The oldest route was pushed out; the newest ones are kept.
    expect(preparedChatRoute("run-0")).toBeUndefined()
    expect(preparedChatRoute("run-1")).toBeDefined()
    expect(preparedChatRoute(`run-${MAX_PREPARED_CHAT_ROUTES}`)).toBeDefined()
    // Re-sealing a route moves it to the back instead of counting it twice.
    rememberChatRoute(route("run-1"))
    rememberChatRoute(route("run-extra"))
    expect(preparedChatRoute("run-1")).toBeDefined()
    expect(preparedChatRoute("run-2")).toBeUndefined()
    await expect(
      beginChatRun("run-0", { tenantLimitRemainingMicrousd: null }, h.deps)
    ).rejects.toMatchObject({ name: "RouterFusionInfrastructureError", code: "internal" })
  })

  it("seals a turn failed when its last model call failed behind a clean result", async () => {
    const h = harness()
    await started("run-1", h)
    await answerCallReserve(reserveRequest("run-1"), h.deps)
    // Leg 0 failed pre-stream and its retry succeeded: the turn is fine so far.
    await recordCallAttemptResult(
      result("run-1", "attempt-1", {
        status: "failed",
        usage: undefined,
        errorClass: "rate_limited",
      }),
      h.deps
    )
    await answerCallReserve(reserveRequest("run-1", { requestId: "req-2" }), h.deps)
    await recordCallAttemptResult(result("run-1", "attempt-2"), h.deps)
    // Leg 1 broke mid-stream; the AI SDK lane still closes with a success result.
    await answerCallReserve(
      reserveRequest("run-1", { requestId: "req-3", logicalStepId: "leg:1" }),
      h.deps
    )
    await recordCallAttemptResult(
      result("run-1", "attempt-3", {
        logicalStepId: "leg:1",
        status: "failed",
        errorClass: "server_error",
      }),
      h.deps
    )
    // A side call after it does not decide the turn's outcome.
    await answerCallReserve(
      reserveRequest("run-1", { requestId: "req-4", logicalStepId: "compact:1" }),
      h.deps
    )
    await recordCallAttemptResult(
      result("run-1", "attempt-4", { logicalStepId: "compact:1" }),
      h.deps
    )
    const seal = await finalizeChatRun("session-1", { status: "succeeded" }, h.deps)
    expect(seal?.run.status).toBe("failed")
    // The stored row keeps the code; free text is withheld (the class is on the attempt).
    expect(seal?.run.error).toEqual({ code: "CALL_FAILED", message: "withheld" })
  })

  it("uses the action's output bound when the call names none", () => {
    const prepared = route("run-x")
    const bound = config.actions.direct_baseline.extension.role_output_tokens
    const withBound = callReserveFor(prepared, {
      deploymentId: "fake-baseline",
      estimatedInputTokens: 1,
    })
    expect(withBound).toEqual({
      kind: "granted",
      // 1 input token at $1/M ceils to 1 µ$; the output bound is capped at the deployment's 4096.
      microusd: 1 + Math.min(bound, 4096) * 2,
      priceKnown: true,
    })
  })

  it("holds a side call on a deployment outside the snapshot conservatively, and strict refuses it", () => {
    const tracked = route("run-x")
    expect(callReserveFor(tracked, { deploymentId: "anthropic::claude-haiku" })).toEqual({
      kind: "granted",
      microusd: 200_000,
      priceKnown: false,
    })
    const strict = route("run-y", { stamp: { ...tracked.stamp, budgetMode: "strict" } })
    expect(callReserveFor(strict, { deploymentId: "anthropic::claude-haiku" })).toEqual({
      kind: "refused",
      code: "DEPLOYMENT_NOT_IN_SNAPSHOT",
    })
    const restricted = route("run-z", { dataClass: "restricted" })
    expect(callReserveFor(restricted, { deploymentId: "anthropic::claude-haiku" })).toEqual({
      kind: "refused",
      code: "DATA_CLASS_NOT_ALLOWED",
    })
  })

  it("[ACC:AUTH-07] refuses a call to a deployment revoked after routing", async () => {
    const h = harness()
    let revoked = false
    await started("run-1", h, { liveRefusal: () => (revoked ? "PROVIDER_DISABLED" : null) })
    expect((await answerCallReserve(reserveRequest("run-1"), h.deps)).answer.decision).toBe(
      "granted"
    )
    revoked = true
    expect(
      (await answerCallReserve(reserveRequest("run-1", { logicalStepId: "leg:1" }), h.deps)).answer
    ).toEqual({ decision: "refused", code: "PROVIDER_DISABLED" })
    // The host closes a refused turn cleanly with what it had; the run still failed.
    const seal = await finalizeChatRun("session-1", { status: "succeeded" }, h.deps)
    expect(seal?.refusal?.code).toBe("PROVIDER_DISABLED")
    expect(seal?.run.status).toBe("failed")
    expect(seal?.run.error?.code).toBe("PROVIDER_DISABLED")
  })

  it("refuses a call the run cannot afford without sending it", async () => {
    const h = harness()
    await started("run-1", h, {
      stamp: { ...route("run-1").stamp, capMicrousd: 5_000 },
    })
    const refused = await answerCallReserve(reserveRequest("run-1"), h.deps)
    expect(refused.answer).toEqual({ decision: "refused", code: "RUN_BUDGET_EXHAUSTED" })
    expect((await h.store.runSummary("run-1"))?.attempts).toEqual([])
  })

  it("[ACC:ISO-01] answers bypass with a fault when the ledger fails mid-turn", async () => {
    const h = harness()
    await started("run-1", h)
    const broken: ChatRunDeps = {
      ...h.deps,
      store: async () => {
        throw Object.assign(new Error("gone"), { name: "DatabaseClosedError" })
      },
    }
    const outcome = await answerCallReserve(reserveRequest("run-1"), broken)
    expect(outcome.answer).toEqual({ decision: "bypass", code: "db_unavailable" })
    expect(outcome.fault?.code).toBe("db_unavailable")
  })

  it("[ACC:ISO-04] refuses restricted data from the sealed route even while the ledger is down", async () => {
    const h = harness()
    let revoked = false
    await started("run-1", h, {
      dataClass: "restricted",
      liveRefusal: () => (revoked ? "RESTRICTED_NOT_GRANTED" : null),
    })
    const store = jest.fn(async (): Promise<FusionLedgerStore> => {
      throw Object.assign(new Error("gone"), { name: "DatabaseClosedError" })
    })
    const broken: ChatRunDeps = { ...h.deps, store }
    // A side call to a deployment nobody vetted for restricted data.
    const unvetted = await answerCallReserve(
      reserveRequest("run-1", { deploymentId: "anthropic::claude-haiku" }),
      broken
    )
    expect(unvetted).toEqual({
      answer: { decision: "refused", code: "DATA_CLASS_NOT_ALLOWED" },
      fault: null,
    })
    revoked = true
    const withdrawn = await answerCallReserve(
      reserveRequest("run-1", { logicalStepId: "leg:1" }),
      broken
    )
    expect(withdrawn.answer).toEqual({ decision: "refused", code: "RESTRICTED_NOT_GRANTED" })
    // Neither answer needed the store, so the fault could not turn them into a bypass.
    expect(store).not.toHaveBeenCalled()
  })

  it("books a call's error class, not its raw error message, as the UNKNOWN reason", async () => {
    const h = harness()
    await started("run-1", h)
    const first = await answerCallReserve(reserveRequest("run-1"), h.deps)
    const second = await answerCallReserve(
      reserveRequest("run-1", { logicalStepId: "leg:1" }),
      h.deps
    )
    const firstId = first.answer.decision === "granted" ? first.answer.attemptId! : ""
    const secondId = second.answer.decision === "granted" ? second.answer.attemptId! : ""
    await recordCallAttemptResult(
      result("run-1", firstId, {
        status: "unknown",
        usage: undefined,
        errorClass: "network",
        reason: 'Invalid JSON: {"text": "part of the answer"',
      }),
      h.deps
    )
    await recordCallAttemptResult(
      result("run-1", secondId, {
        status: "unknown",
        usage: undefined,
        reason: "cancelled_mid_stream",
      }),
      h.deps
    )
    const attempts = (await h.store.runSummary("run-1"))?.attempts ?? []
    expect(Object.fromEntries(attempts.map((a) => [a.attemptId, a.unknownReason]))).toEqual({
      [firstId]: "network",
      [secondId]: "cancelled_mid_stream",
    })
  })

  it("answers bypass for a run this window does not know", async () => {
    const h = harness()
    const outcome = await answerCallReserve(reserveRequest("run-unknown"), h.deps)
    expect(outcome.answer).toEqual({ decision: "bypass", code: "run_state_lost" })
    expect(outcome.fault?.code).toBe("internal")
  })

  it("keeps a sent call without a bill UNKNOWN and held at seal", async () => {
    const h = harness()
    await started("run-1", h)
    await answerCallReserve(reserveRequest("run-1"), h.deps)
    await recordCallAttemptResult(
      result("run-1", "attempt-1", {
        status: "unknown",
        usage: undefined,
        reason: "socket hang up",
      }),
      h.deps
    )
    const seal = await finalizeChatRun("session-1", { status: "failed" }, h.deps)
    expect(seal?.run.costStatus).toBe("pending")
    expect((await h.store.getAccount()).activeHoldsMicrousd).toBe(12_000)
  })

  it("books a late result for a run the window already sealed", async () => {
    const h = harness()
    await started("run-1", h)
    await answerCallReserve(reserveRequest("run-1"), h.deps)
    await finalizeChatRun("session-1", { status: "cancelled" }, h.deps)
    await recordCallAttemptResult(result("run-1", "attempt-1"), h.deps)
    const summary = await h.store.runSummary("run-1")
    expect(summary?.run.budget.spentMicrousd).toBe(11_000)
    expect(h.faults).toEqual([])
  })

  it("moves an interrupted run to cancelling and seals it cancelled", async () => {
    const h = harness()
    await started("run-1", h)
    await cancelChatRun("session-1", h.deps)
    expect((await h.store.getRun("run-1"))?.status).toBe("cancelling")
    const seal = await finalizeChatRun("session-1", { status: "cancelled" }, h.deps)
    expect(seal?.run.status).toBe("cancelled")
  })

  it("releases everything when the dispatch never happened", async () => {
    const h = harness()
    await started("run-1", h)
    await abortChatRunBeforeDispatch("session-1", "ipc down", h.deps)
    const run = await h.store.getRun("run-1")
    expect(run).toMatchObject({ status: "failed", error: { code: "DISPATCH_FAILED" } })
    expect((await h.store.getAccount()).activeHoldsMicrousd).toBe(0)
  })

  it("refuses a busy session held by another window's live turn", async () => {
    const shared = harness()
    await started("run-1", shared)
    __resetChatRunsForTesting()
    const other = harness({ leaseOwner: "window-b", store: shared.store, clock: shared.clock })
    rememberChatRoute(route("run-2"))
    const outcome = await beginChatRun("run-2", { tenantLimitRemainingMicrousd: null }, other.deps)
    expect(outcome).toMatchObject({ kind: "refused", code: "SESSION_BUSY" })
  })

  it("seals a session holder whose window went away and starts the new turn", async () => {
    const shared = harness()
    await started("run-1", shared)
    __resetChatRunsForTesting()
    shared.clock.t += 61_000
    const other = harness({ leaseOwner: "window-b", store: shared.store, clock: shared.clock })
    rememberChatRoute(route("run-2"))
    const outcome = await beginChatRun("run-2", { tenantLimitRemainingMicrousd: null }, other.deps)
    expect(outcome.kind).toBe("started")
    expect(await shared.store.getRun("run-1")).toMatchObject({
      status: "failed",
      error: { code: "RUN_LOST" },
    })
  })

  it("sweeps lapsed chat runs at boot", async () => {
    const shared = harness()
    await started("run-1", shared)
    __resetChatRunsForTesting()
    shared.clock.t += 61_000
    const boot = harness({ leaseOwner: "window-c", store: shared.store, clock: shared.clock })
    expect(await recoverStaleFusionRuns(boot.deps)).toBe(1)
    expect((await shared.store.getAccount()).activeHoldsMicrousd).toBe(0)
    expect(await recoverStaleFusionRuns(boot.deps)).toBe(0)
  })

  it("[ACC:REC-03] hands a lapsed orchestrated run to its resumer and seals it only when refused", async () => {
    const shared = harness()
    for (const runId of ["run-api-1", "run-api-2"]) {
      const { decision } = routeAction(
        config,
        fixtureRouteRequest({ runId, decisionId: `decision-${runId}` })
      )
      const created = await shared.store.createRun({
        runId,
        sessionId: null,
        surface: "gatewayRuns",
        origin: "gateway",
        decision,
        actionId: "direct_baseline",
        ruleId: "R6_baseline",
        roleDeployments: { solver: "fake-baseline" },
        config,
        capMicrousd: 1 * USD,
        maxModelCalls: 24,
        deadlineMs: 600_000,
        budgetMode: "tracked",
        tenantLimitRemainingMicrousd: null,
        driver: "orchestrator",
      })
      if (!created.ok) throw new Error(created.code)
      const lease = await shared.store.acquireLease(runId, "window-a", 60_000)
      if (!lease.ok) throw new Error(lease.code)
      await shared.store.startRun(runId, lease.fencingToken)
    }
    shared.clock.t += 61_000
    const boot = harness({ leaseOwner: "window-c", store: shared.store, clock: shared.clock })
    const offered: string[] = []
    const recovered = await recoverStaleFusionRuns({
      ...boot.deps,
      resumeOrchestrated: (run) => {
        offered.push(run.runId)
        return run.runId === "run-api-1"
      },
    })
    expect(recovered).toBe(2)
    expect(offered.sort()).toEqual(["run-api-1", "run-api-2"])
    // Carried on: nothing sealed it, and the lease is the resumer's to take.
    expect(await shared.store.getRun("run-api-1")).toMatchObject({ status: "running", error: null })
    expect(await shared.store.getRun("run-api-2")).toMatchObject({
      status: "failed",
      error: { code: "RUN_LOST" },
    })
    // Without a resumer (a chat send finding the holder) the run is sealed like any other.
    expect(await recoverStaleFusionRuns(boot.deps)).toBe(1)
    expect(await shared.store.getRun("run-api-1")).toMatchObject({ status: "failed" })
  })

  it("returns a tenant budget refusal as a value and holds nothing", async () => {
    const h = harness()
    rememberChatRoute(route("run-1"))
    const outcome = await beginChatRun("run-1", { tenantLimitRemainingMicrousd: 100_000 }, h.deps)
    expect(outcome).toMatchObject({
      kind: "refused",
      code: "TENANT_BUDGET_EXHAUSTED",
      capMicrousd: 1 * USD,
    })
    expect(await h.store.getRun("run-1")).toBeUndefined()
  })

  describe("envelope (Claude Agent SDK)", () => {
    const assistant = (id: string, usage: Record<string, number>, model = "mock/baseline-v1") => ({
      type: "assistant",
      message: { id, model, usage },
    })

    it("books each message once from its last usage snapshot and reconciles the SDK totals", async () => {
      const h = harness()
      await started("run-1", h, { mode: "envelope" })
      // Two snapshots of message A, then message B.
      void observeEnvelopeMessage(
        "session-1",
        assistant("msg_a", { input_tokens: 1000, output_tokens: 10 }),
        h.deps
      )
      void observeEnvelopeMessage(
        "session-1",
        assistant("msg_a", { input_tokens: 1000, output_tokens: 400 }),
        h.deps
      )
      void observeEnvelopeMessage(
        "session-1",
        assistant("msg_b", {
          input_tokens: 2000,
          output_tokens: 100,
          cache_read_input_tokens: 1000,
        }),
        h.deps
      )
      // Totals exceed what the stream showed by 500 input tokens (a subagent's call).
      await observeEnvelopeMessage(
        "session-1",
        {
          type: "result",
          usage: { input_tokens: 3500, output_tokens: 500, cache_read_input_tokens: 1000 },
        },
        h.deps
      )
      const seal = await finalizeChatRun("session-1", { status: "succeeded" }, h.deps)
      const summary = await h.store.runSummary("run-1")
      const steps = summary?.attempts.map((a) => a.logicalStepId).sort()
      expect(steps).toEqual(["msg:msg_a", "msg:msg_b", "msg:reconcile-run-1-1"])
      // 1000×$1 + 400×$2 | 2000×$1 + 100×$2 + 1000×$0 | 500×$1
      expect(seal?.run.budget.spentMicrousd).toBe(1_800 + 2_200 + 500)
      expect(seal?.run.budget.modelCalls).toBe(3)
      expect((await h.store.getAccount()).activeHoldsMicrousd).toBe(0)
    })

    it("stops the SDK at the next tool once observed spend froze the run", async () => {
      const h = harness()
      await started("run-1", h, {
        mode: "envelope",
        stamp: { ...route("run-1").stamp, capMicrousd: 2_000 },
      })
      const check = () =>
        answerCallReserve(
          reserveRequest("run-1", { kind: "envelope_check", logicalStepId: "tool:1" }),
          h.deps
        )
      expect((await check()).answer).toEqual({ decision: "granted" })
      await observeEnvelopeMessage(
        "session-1",
        assistant("msg_a", { input_tokens: 1500, output_tokens: 400 }),
        h.deps
      )
      await observeEnvelopeMessage(
        "session-1",
        assistant("msg_b", { input_tokens: 10, output_tokens: 10 }),
        h.deps
      )
      expect((await check()).answer).toEqual({ decision: "refused", code: "BUDGET_FROZEN" })
      const seal = await finalizeChatRun("session-1", { status: "failed" }, h.deps)
      // msg_a (2,300 µ$) overran the 2,000 µ$ cap by 300; msg_b, booked at seal, is all overspend (30).
      expect(seal?.run.budget.overspendMicrousd).toBe(330)
    })

    it("books an api_retry: an explicit 429 costs nothing, a broken transport is estimated", async () => {
      const h = harness()
      await started("run-1", h, { mode: "envelope" })
      await observeEnvelopeMessage(
        "session-1",
        { type: "system", subtype: "api_retry", uuid: "u1", error_status: 429 },
        h.deps
      )
      await observeEnvelopeMessage(
        "session-1",
        { type: "system", subtype: "api_retry", uuid: "u2", error_status: null },
        h.deps
      )
      const seal = await finalizeChatRun("session-1", { status: "succeeded" }, h.deps)
      expect(seal?.run.budget.spentMicrousd).toBe(50_000)
      expect(seal?.run.costStatus).toBe("estimated")
      const attempts = (await h.store.runSummary("run-1"))?.attempts ?? []
      expect(attempts.map((a) => [a.logicalStepId, a.state, a.errorClass]).sort()).toEqual([
        ["retry:u1", "FAILED", "rate_limited"],
        ["retry:u2", "FAILED", "timeout_after_send"],
      ])
    })

    it("attributes a message from another model to that model's deployment", async () => {
      const h = harness()
      await started("run-1", h, { mode: "envelope" })
      await observeEnvelopeMessage(
        "session-1",
        assistant("msg_a", { input_tokens: 10, output_tokens: 10 }, "mock/other"),
        h.deps
      )
      await finalizeChatRun("session-1", { status: "succeeded" }, h.deps)
      const attempts = (await h.store.runSummary("run-1"))?.attempts ?? []
      expect(attempts[0]).toMatchObject({
        deploymentId: "fake::mock/other",
        costStatus: "estimated",
      })
    })

    it("ignores messages of a session without an envelope run", async () => {
      const h = harness()
      await started("run-1", h)
      await observeEnvelopeMessage(
        "session-1",
        assistant("msg_a", { input_tokens: 10, output_tokens: 10 }),
        h.deps
      )
      await observeEnvelopeMessage(
        "session-2",
        assistant("msg_a", { input_tokens: 10, output_tokens: 10 }),
        h.deps
      )
      expect((await h.store.runSummary("run-1"))?.attempts).toEqual([])
    })
  })

  describe("pure helpers", () => {
    it("reads Anthropic usage with the TTL split when reported", () => {
      expect(
        rawUsageFromAnthropic({
          input_tokens: 5,
          output_tokens: 7,
          cache_read_input_tokens: 3,
          cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 1 },
        })
      ).toEqual({
        inputTokens: 5,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWrite5mTokens: 2,
        cacheWrite1hTokens: 1,
      })
      expect(rawUsageFromAnthropic({ input_tokens: 5, cache_creation_input_tokens: 4 })).toEqual({
        inputTokens: 5,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 4,
      })
      expect(rawUsageFromAnthropic(null)).toBeNull()
    })

    it("classifies api_retry statuses and sidecar error classes", () => {
      expect(apiRetryErrorClass(529)).toBe("rate_limited")
      expect(apiRetryErrorClass(503)).toBe("server_error")
      expect(apiRetryErrorClass(401)).toBe("auth")
      expect(apiRetryErrorClass(400)).toBe("invalid_request")
      expect(apiRetryErrorClass(null)).toBe("timeout_after_send")
      expect(roleCallErrorClassOf("cancelled")).toBe("cancelled")
      expect(roleCallErrorClassOf("teapot")).toBeUndefined()
      expect(roleCallErrorClassOf(undefined)).toBeUndefined()
    })
  })
})
