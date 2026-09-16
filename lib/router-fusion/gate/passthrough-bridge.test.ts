import { __resetBreakerForTesting, getBreakerSnapshot } from "./breaker"
import { RouterFusionInfrastructureError } from "./faults"
import type { RouterFusionHost } from "./load-engine"
import {
  dispatchRouterFusionPassthroughCommand,
  isRouterFusionPassthroughCommand,
  ROUTER_FUSION_PASSTHROUGH_COMMANDS,
} from "./passthrough-bridge"

const ON = { routerFusion: { enabled: true, surfaces: { gatewayPassthroughLedger: true } } }
const OFF = { routerFusion: { enabled: false, surfaces: { gatewayPassthroughLedger: true } } }
const TRIPPED = {
  routerFusion: {
    enabled: true,
    surfaces: { gatewayPassthroughLedger: true },
    trippedSurfaces: { gatewayPassthroughLedger: { trippedAt: 1 } },
  },
}

const RESERVE_PAYLOAD = {
  requestId: "req-1",
  attempt: 0,
  providerId: "openai",
  modelId: "gpt-5-mini",
  requestedModel: "fast",
  keyId: "key-a",
  keyName: "CI robot",
  estimatedInputTokens: 800,
}

function fakeHost(overrides: Record<string, unknown> = {}) {
  const seen: { name: string; input: unknown }[] = []
  const host = {
    reservePassthroughCall: (input: unknown) => {
      seen.push({ name: "reserve", input })
      return Promise.resolve({ kind: "reserved", runId: "gwpt:req-1", attemptId: "attempt-1" })
    },
    settlePassthroughCall: (input: unknown) => {
      seen.push({ name: "settle", input })
      return Promise.resolve({ sealed: true })
    },
    ...overrides,
  } as unknown as RouterFusionHost
  return { host, seen }
}

beforeEach(() => __resetBreakerForTesting())

describe("isRouterFusionPassthroughCommand", () => {
  it("names the two commands Rust sends and nothing else", () => {
    expect(ROUTER_FUSION_PASSTHROUGH_COMMANDS).toHaveLength(2)
    for (const command of ROUTER_FUSION_PASSTHROUGH_COMMANDS) {
      expect(isRouterFusionPassthroughCommand(command)).toBe(true)
    }
    // The Run API family is a different bridge with the opposite failure rule.
    expect(isRouterFusionPassthroughCommand("router_fusion_run_create")).toBe(false)
  })
})

describe("dispatchRouterFusionPassthroughCommand", () => {
  it("[ACC:OFF-03] bypasses while the surface is off, loading nothing", async () => {
    const loadHost = jest.fn()
    const outcome = await dispatchRouterFusionPassthroughCommand(
      "router_fusion_passthrough_reserve",
      RESERVE_PAYLOAD,
      { settings: OFF, loadHost: loadHost as unknown as () => Promise<RouterFusionHost> }
    )
    expect(outcome).toEqual({ status: "bypassed", code: "surface_off" })
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("reserves through the ledger and hands back the run the request bills to", async () => {
    const { host, seen } = fakeHost()
    const outcome = await dispatchRouterFusionPassthroughCommand(
      "router_fusion_passthrough_reserve",
      RESERVE_PAYLOAD,
      { settings: ON, loadHost: async () => host }
    )
    expect(outcome).toEqual({ status: "ledgered", runId: "gwpt:req-1", attemptId: "attempt-1" })
    expect(seen[0].input).toMatchObject({ requestId: "req-1", attempt: 0, keyId: "key-a" })
  })

  it("carries a real refusal back instead of bypassing it", async () => {
    // Budget and hard filters are answers, not faults: proxying anyway would
    // spend money the user said no to.
    const { host } = fakeHost({
      reservePassthroughCall: async () => ({ kind: "refused", code: "BUDGET_EXCEEDED" }),
    })
    const outcome = await dispatchRouterFusionPassthroughCommand(
      "router_fusion_passthrough_reserve",
      RESERVE_PAYLOAD,
      { settings: ON, loadHost: async () => host }
    )
    expect(outcome).toEqual({ status: "refused", code: "BUDGET_EXCEEDED" })
    expect(getBreakerSnapshot("gatewayPassthroughLedger").consecutiveFaults).toBe(0)
  })

  it("[ACC:ISO-01] bypasses an infrastructure fault and counts it", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const outcome = await dispatchRouterFusionPassthroughCommand(
      "router_fusion_passthrough_reserve",
      RESERVE_PAYLOAD,
      {
        settings: ON,
        loadHost: async () => {
          throw new RouterFusionInfrastructureError("db_unavailable", "the fusion database is gone")
        },
      }
    )
    expect(outcome).toEqual({ status: "bypassed", code: "ledger_unavailable" })
    expect(getBreakerSnapshot("gatewayPassthroughLedger").consecutiveFaults).toBe(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("[ACC:ISO-02] stops asking once the breaker is open, and still lets traffic through", async () => {
    const loadHost = jest.fn()
    const outcome = await dispatchRouterFusionPassthroughCommand(
      "router_fusion_passthrough_settle",
      { runId: "gwpt:req-1", attemptId: "attempt-1", outcome: "succeeded", final: true },
      { settings: TRIPPED, loadHost: loadHost as unknown as () => Promise<RouterFusionHost> }
    )
    expect(outcome).toEqual({ status: "bypassed", code: "breaker_tripped" })
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("normalizes the usage the gateway sniffed, and never invents a zero", async () => {
    const { host, seen } = fakeHost()
    const deps = { settings: ON, loadHost: async () => host }
    await dispatchRouterFusionPassthroughCommand(
      "router_fusion_passthrough_settle",
      {
        runId: "gwpt:req-1",
        attemptId: "attempt-1",
        outcome: "succeeded",
        usage: { inputTokens: 800, outputTokens: 120, cacheReadTokens: 64 },
        final: true,
      },
      deps
    )
    expect(seen[0].input).toMatchObject({
      outcome: "succeeded",
      usage: { inputTokens: 800, outputTokens: 120, cacheReadTokens: 64 },
      final: true,
    })

    // An upstream that reported nothing leaves usage absent: a zero would be a
    // claim about the bill that nothing supports.
    await dispatchRouterFusionPassthroughCommand(
      "router_fusion_passthrough_settle",
      { runId: "gwpt:req-1", attemptId: "attempt-2", outcome: "unknown", final: false },
      deps
    )
    expect((seen[1].input as { usage: unknown }).usage).toBeNull()
  })

  it("keeps the gateway's failure class, and drops one it does not recognise", async () => {
    const { host, seen } = fakeHost()
    const deps = { settings: ON, loadHost: async () => host }
    const failed = { runId: "gwpt:req-1", attemptId: "a1", outcome: "failed", final: false }
    await dispatchRouterFusionPassthroughCommand(
      "router_fusion_passthrough_settle",
      { ...failed, errorClass: "rate_limited" },
      deps
    )
    await dispatchRouterFusionPassthroughCommand(
      "router_fusion_passthrough_settle",
      { ...failed, errorClass: "made_up" },
      deps
    )
    expect(seen[0].input).toMatchObject({ outcome: "failed", errorClass: "rate_limited" })
    expect(seen[1].input).not.toHaveProperty("errorClass")
  })

  it("treats an outcome it cannot read as the one that keeps the money held", async () => {
    // Guessing "succeeded" would release a reservation for a call whose bill
    // nobody read.
    const { host, seen } = fakeHost()
    await dispatchRouterFusionPassthroughCommand(
      "router_fusion_passthrough_settle",
      { runId: "gwpt:req-1", attemptId: "a1", outcome: "finished-ish", final: true },
      { settings: ON, loadHost: async () => host }
    )
    expect(seen[0].input).toMatchObject({ outcome: "unknown" })
  })
})
