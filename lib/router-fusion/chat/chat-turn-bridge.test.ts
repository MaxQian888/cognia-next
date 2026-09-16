/** @jest-environment jsdom */
import "fake-indexeddb/auto"

const mockSettings: { current: Record<string, unknown> } = { current: {} }
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => ({ settings: mockSettings.current }) },
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ name: `bridge-test-${(globalThis as { __bridgeDb?: number }).__bridgeDb ?? 0}` }),
}))
jest.mock("@/lib/usage/cost-budget-runtime", () => ({
  readCostBudgetSpend: async () => ({ dayUsd: 0.9, monthUsd: 0.9 }),
}))
jest.mock("@/lib/claude/ipc", () => ({ callReserveDecision: jest.fn(async () => undefined) }))
// The reseal's routing is `route-chat-turn`'s own subject; here we drive its
// outcomes so the bridge's gate check, lane rule, stamp swap and fault handling
// are what actually runs.
const routeMocks = { select: jest.fn(), seal: jest.fn() }
jest.mock("./route-chat-turn", () => ({
  ...jest.requireActual("./route-chat-turn"),
  selectChatDeployment: (...args: unknown[]) => routeMocks.select(...args),
  sealChatRoute: (...args: unknown[]) => routeMocks.seal(...args),
}))
// The English bundle with plain `{name}` interpolation stands in for next-intl here.
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: async (namespace: string) => {
    const bundle = jest.requireActual("@/i18n/messages/en/routerFusion.json") as Record<
      string,
      unknown
    >
    const scope = namespace
      .split(".")
      .slice(1)
      .reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, bundle)
    return (key: string, values: Record<string, string> = {}) =>
      String(scope[key]).replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "")
  },
}))

import { fakeCompiledConfig, fixtureRouteRequest, routeAction } from "@cognia/router-fusion"
import { approve, reject } from "@/lib/runtime/approval-bus"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"

import { __resetBreakerForTesting, getBreakerSnapshot } from "../gate/breaker"
import { RouterFusionInfrastructureError, RouterFusionRefusalError } from "../gate/faults"
import { __resetFusionDbForTesting } from "../db/fusion-db"
import {
  __resetFusionTurnsForTesting,
  fusionTurnBypassOf,
  fusionTurnOf,
} from "../gate/turn-registry"
import { __resetChatRunsForTesting, rememberChatRoute, type PreparedChatRoute } from "./chat-runs"
import {
  ROUTER_FUSION_GRANT_SCOPE,
  abortRouterFusionChatTurn,
  cancelRouterFusionChatTurn,
  finishRouterFusionChatTurn,
  handleRouterFusionSidecarEvent,
  observeRouterFusionSdkMessage,
  requestRouterFusionGrant,
  rerouteRouterFusionTurn,
  resealRouterFusionOptions,
  startRouterFusionChatTurn,
} from "./chat-turn-bridge"
import { __resetFusionStoreForTesting } from "./store-provider"

const config = fakeCompiledConfig()
let db = 0

function prepared(runId: string, capMicrousd = 500_000): PreparedChatRoute {
  const { decision } = routeAction(config, fixtureRouteRequest({ runId, decisionId: `d-${runId}` }))
  const stamp = {
    runId,
    decisionId: decision.decision_id,
    actionId: "direct_baseline",
    mode: "direct" as const,
    ruleId: "R6_baseline",
    deploymentId: "fake-baseline",
    providerId: "fake",
    modelId: "mock/baseline-v1",
    budgetMode: "tracked" as const,
    capMicrousd,
    reserveEstimateMicrousd: 10_000,
    priceKnown: true,
    acceptanceProfile: "text_basic",
    lane: "ai-sdk" as const,
  }
  return {
    stamp,
    ledger: { runId, mode: "per_call", transportAttempts: 2, deploymentId: "fake-baseline" },
    decision,
    config,
    sessionId: "s1",
    dataClass: "internal",
    maxModelCalls: 256,
    deadlineMs: 3_600_000,
    unknownPriceCallReserveMicrousd: 50_000,
    liveRefusal: () => null,
  }
}

function sendOptionsFor(route: PreparedChatRoute) {
  return { routerFusion: route.stamp, ledger: route.ledger } as never
}

describe("chat turn bridge", () => {
  beforeEach(() => {
    ;(globalThis as { __bridgeDb?: number }).__bridgeDb = ++db
    mockSettings.current = {}
    routeMocks.select.mockReset()
    routeMocks.seal.mockReset()
  })
  afterEach(() => {
    __resetChatRunsForTesting()
    __resetFusionTurnsForTesting()
    __resetFusionStoreForTesting()
    __resetFusionDbForTesting()
    __resetBreakerForTesting()
  })

  it("starts a run, answers the sidecar, books its result and seals the turn", async () => {
    const route = prepared("run-1")
    rememberChatRoute(route)
    const started = await startRouterFusionChatTurn({
      sessionId: "s1",
      options: sendOptionsFor(route),
    })
    expect(started).toEqual({ kind: "started", runId: "run-1" })
    expect(fusionTurnOf("s1")).toBe("run-1")

    const decide = jest.fn(async () => undefined)
    await handleRouterFusionSidecarEvent(
      {
        type: "call_reserve_request",
        sessionId: "s1",
        runId: "run-1",
        requestId: "req-1",
        kind: "call",
        logicalStepId: "leg:0",
        deploymentId: "fake-baseline",
        estimatedInputTokens: 1_000,
        maxOutputTokens: 1_000,
      },
      { decide }
    )
    const answer = (decide.mock.calls[0] as unknown[])[2] as { decision: string; attemptId: string }
    expect(answer.decision).toBe("granted")

    await handleRouterFusionSidecarEvent({
      type: "call_attempt_result",
      sessionId: "s1",
      runId: "run-1",
      attemptId: answer.attemptId,
      logicalStepId: "leg:0",
      status: "succeeded",
      usage: { inputTokens: 1_000, outputTokens: 100 },
      semantics: {
        inputIncludesCacheRead: true,
        inputIncludesCacheWrite: true,
        outputIncludesReasoning: true,
      },
      providerRequestId: "resp-1",
    })
    const summary = await finishRouterFusionChatTurn("s1", { status: "succeeded" })
    expect(summary).toMatchObject({
      runId: "run-1",
      status: "succeeded",
      spentMicrousd: 1_000 + 200,
      modelCalls: 1,
      costStatus: "actual",
      refusalCode: null,
      bypass: null,
    })
    expect(fusionTurnOf("s1")).toBeUndefined()
  })

  it("asks for a one-run grant (D35) when the cost budget cannot cover the cap, and runs on approval", async () => {
    mockSettings.current = { costBudget: { dailyUsd: 1 } }
    const route = prepared("run-1", 500_000)
    rememberChatRoute(route)
    const requestGrant = jest.fn(async () => true)
    const started = await startRouterFusionChatTurn({
      sessionId: "s1",
      options: sendOptionsFor(route),
      requestGrant,
    })
    expect(started.kind).toBe("started")
    // $1 budget, $0.90 spent: $0.10 available for a $0.50 cap.
    expect(requestGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        capMicrousd: 500_000,
        availableMicrousd: 100_000,
        shortfallMicrousd: 400_000,
      }),
      undefined
    )
  })

  it("does not run when the grant is declined", async () => {
    mockSettings.current = { costBudget: { dailyUsd: 1 } }
    const route = prepared("run-1", 500_000)
    rememberChatRoute(route)
    const started = await startRouterFusionChatTurn({
      sessionId: "s1",
      options: sendOptionsFor(route),
      requestGrant: async () => false,
    })
    expect(started).toEqual({ kind: "declined", code: "TENANT_BUDGET_EXHAUSTED" })
    expect(fusionTurnOf("s1")).toBeUndefined()
  })

  it("opens the grant as a budget gate and reads approve and reject from it", async () => {
    const request = {
      runId: "run-9",
      capMicrousd: 500_000,
      availableMicrousd: 100_000,
      shortfallMicrousd: 400_000,
      binding: null,
    }
    const approved = requestRouterFusionGrant(request)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const gate = usePendingGatesStore
      .getState()
      .gates.find((g) => g.key.scope === ROUTER_FUSION_GRANT_SCOPE)
    expect(gate).toMatchObject({ gateType: "budget", runId: "run-9" })
    expect(gate?.body).toContain("$0.40")
    approve({ scope: ROUTER_FUSION_GRANT_SCOPE, id: "run-9" })
    await expect(approved).resolves.toBe(true)
    expect(usePendingGatesStore.getState().gates.some((g) => g.key.id === "run-9")).toBe(false)

    const rejected = requestRouterFusionGrant({ ...request, runId: "run-10" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    reject({ scope: ROUTER_FUSION_GRANT_SCOPE, id: "run-10" })
    await expect(rejected).resolves.toBe(false)
  })

  it("[ACC:ISO-01] turns a ledger the sidecar gave up on into the turn's notice and a breaker fault", async () => {
    const route = prepared("run-1")
    rememberChatRoute(route)
    await startRouterFusionChatTurn({ sessionId: "s1", options: sendOptionsFor(route) })
    await handleRouterFusionSidecarEvent({
      type: "ledger_bypassed",
      sessionId: "s1",
      runId: "run-1",
      reason: "renderer_unanswered",
    })
    expect(fusionTurnBypassOf("s1")).toEqual({ code: "sidecar_unanswered", justTripped: false })
    expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(1)
    const summary = await finishRouterFusionChatTurn("s1", { status: "succeeded" })
    expect(summary?.bypass).toEqual({ code: "sidecar_unanswered", justTripped: false })
  })

  describe("reseal and reroute", () => {
    const on = { routerFusion: { enabled: true, surfaces: { chat: true } } }
    const cached = (extra: Record<string, unknown> = {}) =>
      ({
        provider: "openai",
        model: "gpt-5",
        fallbackModel: "gpt-5-mini",
        routerFusion: { runId: "sealed-run" },
        ledger: { runId: "sealed-run", mode: "per_call" },
        ...extra,
      }) as never

    /** Make the next reseal hand back `route` as a freshly sealed run. */
    const sealAs = (route: PreparedChatRoute, maxOutputTokens = 4_096) => {
      routeMocks.select.mockResolvedValue({ kind: "selected" })
      routeMocks.seal.mockReturnValue({
        kind: "stamped",
        stamp: route.stamp,
        ledger: route.ledger,
        prepared: route,
        maxOutputTokens,
        decision: route.decision,
      })
    }

    it("[ACC:OFF-02] drops a stale stamp rather than resending it when the switch is off", async () => {
      const outcome = await resealRouterFusionOptions({
        sessionId: "s1",
        options: cached(),
        workspaceId: null,
      })
      expect(outcome).toEqual({
        kind: "bypassed",
        options: { provider: "openai", model: "gpt-5", fallbackModel: "gpt-5-mini" },
      })
      expect(routeMocks.select).not.toHaveBeenCalled()
    })

    it("leaves a resend this build does not ledger on the original path", async () => {
      mockSettings.current = on
      const otherLane = await resealRouterFusionOptions({
        sessionId: "s1",
        options: cached({ execution: { runtimeAdapter: "codex" } }),
        workspaceId: null,
      })
      expect(otherLane.kind).toBe("bypassed")
      const noModel = await resealRouterFusionOptions({
        sessionId: "s1",
        options: cached({ model: undefined }),
        workspaceId: null,
      })
      expect(noModel.kind).toBe("bypassed")
      expect(routeMocks.select).not.toHaveBeenCalled()
    })

    it("routes a cached send again as a NEW run, without the silent fallback", async () => {
      mockSettings.current = on
      const route = prepared("resealed-1")
      sealAs(route)
      const outcome = await resealRouterFusionOptions({
        sessionId: "s1",
        options: cached(),
        workspaceId: "p1",
      })
      expect(outcome.kind).toBe("sealed")
      const options = (outcome as unknown as { options: Record<string, unknown> }).options
      expect(options.routerFusion).toBe(route.stamp)
      expect(options.ledger).toBe(route.ledger)
      // D5: a ledgered turn never switches model behind the user's back.
      expect(options).not.toHaveProperty("fallbackModel")
      // The AI SDK lane pins the output bound every call was reserved for.
      expect(options.modelParams).toEqual({ maxOutputTokens: 4_096 })
      expect(routeMocks.select).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ workspaceId: "p1", hints: { workspaceBound: true } })
      )
      // The route was remembered, so the run can actually be created from it.
      await expect(
        startRouterFusionChatTurn({ sessionId: "s1", options: options as never })
      ).resolves.toEqual({ kind: "started", runId: "resealed-1" })
    })

    it("passes a refusal through from either the selection or the seal", async () => {
      mockSettings.current = on
      routeMocks.select.mockResolvedValue({
        kind: "refused",
        code: "ROUTE_NO_SOLUTION",
        reasons: ["NO_CANDIDATES:manual"],
      })
      await expect(
        resealRouterFusionOptions({ sessionId: "s1", options: cached(), workspaceId: null })
      ).resolves.toEqual({
        kind: "refused",
        code: "ROUTE_NO_SOLUTION",
        reasons: ["NO_CANDIDATES:manual"],
      })

      routeMocks.select.mockResolvedValue({ kind: "selected" })
      routeMocks.seal.mockReturnValue({
        kind: "refused",
        code: "RUN_BUDGET_EXHAUSTED",
        reasons: [],
      })
      await expect(
        resealRouterFusionOptions({ sessionId: "s1", options: cached(), workspaceId: null })
      ).resolves.toEqual({ kind: "refused", code: "RUN_BUDGET_EXHAUSTED", reasons: [] })
    })

    it("[ACC:ISO-01] sends the resend on the original path when the reseal itself faults", async () => {
      mockSettings.current = on
      routeMocks.select.mockRejectedValue(
        new RouterFusionInfrastructureError("db_unavailable", "fusion database will not open")
      )
      const outcome = await resealRouterFusionOptions({
        sessionId: "s1",
        options: cached(),
        workspaceId: null,
      })
      expect(outcome).toEqual({
        kind: "bypassed",
        options: {
          provider: "openai",
          model: "gpt-5",
          fallbackModel: "gpt-5-mini",
          routerFusionBypass: { code: "db_unavailable", justTripped: false },
        },
      })
      expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(1)
    })

    it("[ACC:ISO-04] never bypasses a refusal, even one that arrives as a throw", async () => {
      mockSettings.current = on
      routeMocks.select.mockRejectedValue(
        new RouterFusionRefusalError("RUN_BUDGET_EXHAUSTED", "over the run cap")
      )
      await expect(
        resealRouterFusionOptions({ sessionId: "s1", options: cached(), workspaceId: null })
      ).rejects.toThrow("over the run cap")
      expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(0)
    })

    it("reroutes a failed turn into a run of its own before anything is sent", async () => {
      mockSettings.current = on
      const route = prepared("reroute-1")
      sealAs(route)
      const outcome = await rerouteRouterFusionTurn({
        sessionId: "s1",
        options: cached(),
        workspaceId: null,
      })
      expect(outcome.kind).toBe("started")
      expect(fusionTurnOf("s1")).toBe("reroute-1")
      expect((outcome as { options: { routerFusion: unknown } }).options.routerFusion).toBe(
        route.stamp
      )
    })

    it("does not send a reroute that was refused, bypassed, or could not take the session", async () => {
      const off = await rerouteRouterFusionTurn({
        sessionId: "s1",
        options: cached(),
        workspaceId: null,
      })
      expect(off.kind).toBe("bypassed")

      mockSettings.current = on
      routeMocks.select.mockResolvedValue({
        kind: "refused",
        code: "ROUTE_NO_SOLUTION",
        reasons: [],
      })
      await expect(
        rerouteRouterFusionTurn({ sessionId: "s1", options: cached(), workspaceId: null })
      ).resolves.toEqual({ kind: "refused", code: "ROUTE_NO_SOLUTION" })

      // A second run on a session that already holds one is refused, not queued.
      sealAs(prepared("reroute-2"))
      await rerouteRouterFusionTurn({ sessionId: "s1", options: cached(), workspaceId: null })
      sealAs(prepared("reroute-3"))
      const busy = await rerouteRouterFusionTurn({
        sessionId: "s1",
        options: cached(),
        workspaceId: null,
      })
      expect(busy.kind).toBe("refused")
    })

    it("only hands a real SDK message to the envelope observer", async () => {
      await expect(observeRouterFusionSdkMessage("s1", null)).resolves.toBeUndefined()
      await expect(observeRouterFusionSdkMessage("s1", "assistant")).resolves.toBeUndefined()
      // No turn is running, so an object message is observed and ignored.
      await expect(
        observeRouterFusionSdkMessage("s1", { type: "assistant", message: { id: "msg-1" } })
      ).resolves.toBeUndefined()
    })
  })

  it("cancels an interrupted run and releases a run whose dispatch failed", async () => {
    const route = prepared("run-1")
    rememberChatRoute(route)
    await startRouterFusionChatTurn({ sessionId: "s1", options: sendOptionsFor(route) })
    await cancelRouterFusionChatTurn("s1")
    const summary = await finishRouterFusionChatTurn("s1", { status: "cancelled" })
    expect(summary?.status).toBe("cancelled")

    const second = prepared("run-2")
    rememberChatRoute(second)
    await startRouterFusionChatTurn({ sessionId: "s1", options: sendOptionsFor(second) })
    await abortRouterFusionChatTurn("s1", "ipc down")
    expect(fusionTurnOf("s1")).toBeUndefined()
    expect(await finishRouterFusionChatTurn("s1", { status: "failed" })).toBeNull()
  })
})
