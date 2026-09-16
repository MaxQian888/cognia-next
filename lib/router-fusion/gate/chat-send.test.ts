jest.mock("@/lib/router-fusion/gate/load-engine", () => ({
  loadRouterFusionHost: jest.fn(() => {
    throw new Error("the default loader must not be used in these tests")
  }),
}))

import type { SendOptions } from "@cognia/agent-config-types"

import { __resetBreakerForTesting, getBreakerSnapshot } from "./breaker"
import { RouterFusionInfrastructureError } from "./faults"
import { loadRouterFusionHost, type RouterFusionHost } from "./load-engine"
import {
  abortRouterFusionSend,
  MAX_LEDGERED_REROUTES,
  prepareRouterFusionSend,
  rerouteRouterFusionSend,
} from "./chat-send"

const STAMP = { runId: "run-1", providerId: "openai" } as SendOptions["routerFusion"]
const stamped: SendOptions = {
  provider: "openai",
  model: "gpt-5",
  routerFusion: STAMP,
  ledger: { runId: "run-1", mode: "per_call", transportAttempts: 2, deploymentId: "openai::gpt-5" },
}

function host(overrides: Partial<RouterFusionHost>): () => Promise<RouterFusionHost> {
  return async () => overrides as RouterFusionHost
}

const base = { sessionId: "s1", reused: false, workspaceId: null, settings: undefined }

describe("prepareRouterFusionSend", () => {
  afterEach(() => __resetBreakerForTesting())

  it("[ACC:OFF-03] passes an unstamped send through without loading anything", async () => {
    const options: SendOptions = { provider: "anthropic", model: "claude" }
    const outcome = await prepareRouterFusionSend({ ...base, options })
    expect(outcome).toEqual({ kind: "send", options })
    expect(outcome.kind === "send" && outcome.options).toBe(options)
    expect(loadRouterFusionHost).not.toHaveBeenCalled()
  })

  it("creates the run of a stamped send before dispatch", async () => {
    const startRouterFusionChatTurn = jest
      .fn()
      .mockResolvedValue({ kind: "started", runId: "run-1" })
    const outcome = await prepareRouterFusionSend({
      ...base,
      options: stamped,
      loadHost: host({ startRouterFusionChatTurn }),
    })
    expect(outcome).toEqual({ kind: "send", options: stamped })
    expect(startRouterFusionChatTurn).toHaveBeenCalledWith({ sessionId: "s1", options: stamped })
  })

  it("routes reused options again before creating the new run", async () => {
    const resealed = { ...stamped, routerFusion: { ...STAMP, runId: "run-2" } } as SendOptions
    const resealRouterFusionOptions = jest
      .fn()
      .mockResolvedValue({ kind: "sealed", options: resealed })
    const startRouterFusionChatTurn = jest
      .fn()
      .mockResolvedValue({ kind: "started", runId: "run-2" })
    const outcome = await prepareRouterFusionSend({
      ...base,
      reused: true,
      options: stamped,
      loadHost: host({ resealRouterFusionOptions, startRouterFusionChatTurn }),
    })
    expect(outcome).toEqual({ kind: "send", options: resealed })
    expect(startRouterFusionChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ options: resealed })
    )
  })

  it("[ACC:ISO-04] returns a refusal or a declined grant as a refusal, not a bypass", async () => {
    const refused = await prepareRouterFusionSend({
      ...base,
      options: stamped,
      loadHost: host({
        startRouterFusionChatTurn: jest
          .fn()
          .mockResolvedValue({ kind: "refused", code: "SESSION_BUSY" }),
      }),
    })
    expect(refused).toEqual({ kind: "refused", code: "SESSION_BUSY" })
    const declined = await prepareRouterFusionSend({
      ...base,
      options: stamped,
      loadHost: host({
        startRouterFusionChatTurn: jest
          .fn()
          .mockResolvedValue({ kind: "declined", code: "TENANT_BUDGET_EXHAUSTED" }),
      }),
    })
    expect(declined).toEqual({ kind: "refused", code: "DECLINED_GRANT" })
    expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(0)
  })

  it("[ACC:ISO-01] sends unledgered with a notice when the run cannot be created", async () => {
    const outcome = await prepareRouterFusionSend({
      ...base,
      options: stamped,
      loadHost: host({
        startRouterFusionChatTurn: jest
          .fn()
          .mockRejectedValue(new RouterFusionInfrastructureError("db_unavailable", "blocked")),
      }),
    })
    expect(outcome).toEqual({
      kind: "send",
      options: {
        provider: "openai",
        model: "gpt-5",
        routerFusionBypass: { code: "db_unavailable", justTripped: false },
      },
    })
    expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(1)
  })

  it("sends unledgered when the host fails to load", async () => {
    const outcome = await prepareRouterFusionSend({
      ...base,
      options: stamped,
      loadHost: async () => {
        throw new RouterFusionInfrastructureError("import_failed", "chunk")
      },
    })
    expect(outcome.kind === "send" && outcome.options.routerFusionBypass).toEqual({
      code: "import_failed",
      justTripped: false,
    })
  })

  it("[ACC:ISO-02] counts only consecutive faults: a started run resets the streak, three in a row trip", async () => {
    const faulty = host({
      startRouterFusionChatTurn: jest
        .fn()
        .mockRejectedValue(new RouterFusionInfrastructureError("db_unavailable", "blocked")),
    })
    const healthy = host({
      startRouterFusionChatTurn: jest.fn().mockResolvedValue({ kind: "started" }),
    })
    await prepareRouterFusionSend({ ...base, options: stamped, loadHost: faulty })
    await prepareRouterFusionSend({ ...base, options: stamped, loadHost: faulty })
    await prepareRouterFusionSend({ ...base, options: stamped, loadHost: healthy })
    expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(0)

    await prepareRouterFusionSend({ ...base, options: stamped, loadHost: faulty })
    await prepareRouterFusionSend({ ...base, options: stamped, loadHost: faulty })
    const third = await prepareRouterFusionSend({ ...base, options: stamped, loadHost: faulty })
    expect(third.kind === "send" && third.options.routerFusionBypass).toEqual({
      code: "db_unavailable",
      justTripped: true,
    })
    expect(getBreakerSnapshot("chat").trip?.reason).toBe("db_unavailable")
  })
})

describe("rerouteRouterFusionSend", () => {
  afterEach(() => __resetBreakerForTesting())

  const next = { ...stamped, provider: "anthropic", model: "claude-sonnet" } as SendOptions

  it("leaves an unledgered retry alone without loading anything", async () => {
    const options: SendOptions = { provider: "anthropic", model: "claude" }
    const load = jest.fn()
    await expect(rerouteRouterFusionSend({ ...base, options, loadHost: load })).resolves.toEqual({
      kind: "send",
      options,
    })
    expect(load).not.toHaveBeenCalled()
  })

  it("sends the next candidate as a new run, or refuses it", async () => {
    const rerouted = { ...next, routerFusion: { ...STAMP, runId: "run-2" } } as SendOptions
    const rerouteRouterFusionTurn = jest
      .fn()
      .mockResolvedValue({ kind: "started", options: rerouted })
    await expect(
      rerouteRouterFusionSend({
        ...base,
        options: next,
        loadHost: host({ rerouteRouterFusionTurn }),
      })
    ).resolves.toEqual({ kind: "send", options: rerouted })
    expect(rerouteRouterFusionTurn).toHaveBeenCalledWith({
      sessionId: "s1",
      options: next,
      workspaceId: null,
    })

    await expect(
      rerouteRouterFusionSend({
        ...base,
        options: next,
        loadHost: host({
          rerouteRouterFusionTurn: jest
            .fn()
            .mockResolvedValue({ kind: "refused", code: "ROUTE_NO_SOLUTION" }),
        }),
      })
    ).resolves.toEqual({ kind: "refused", code: "ROUTE_NO_SOLUTION" })
  })

  it("[ACC:ISO-01] sends the retry unledgered with a notice when the host faults", async () => {
    const outcome = await rerouteRouterFusionSend({
      ...base,
      options: next,
      loadHost: async () => {
        throw new RouterFusionInfrastructureError("import_failed", "chunk")
      },
    })
    expect(outcome).toEqual({
      kind: "send",
      options: {
        provider: "anthropic",
        model: "claude-sonnet",
        routerFusionBypass: { code: "import_failed", justTripped: false },
      },
    })
    expect(MAX_LEDGERED_REROUTES).toBe(2)
  })
})

describe("abortRouterFusionSend", () => {
  it("releases the run of a failed dispatch and never throws", async () => {
    const abortRouterFusionChatTurn = jest.fn().mockResolvedValue(undefined)
    await abortRouterFusionSend("s1", stamped, "ipc", host({ abortRouterFusionChatTurn }))
    expect(abortRouterFusionChatTurn).toHaveBeenCalledWith("s1", "ipc")
    await expect(
      abortRouterFusionSend("s1", stamped, "ipc", async () => {
        throw new Error("gone")
      })
    ).resolves.toBeUndefined()
    const untouched = jest.fn()
    await abortRouterFusionSend("s1", { provider: "x" }, "ipc", untouched)
    expect(untouched).not.toHaveBeenCalled()
  })
})
