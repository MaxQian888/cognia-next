import { __resetBreakerForTesting, getBreakerSnapshot } from "./breaker"
import { RouterFusionInfrastructureError } from "./faults"
import type { RouterFusionHost } from "./load-engine"
import {
  dispatchRouterFusionBridgeCommand,
  isRouterFusionBridgeCommand,
  ROUTER_FUSION_BRIDGE_COMMANDS,
  type BridgeOutcome,
} from "./run-api-bridge"

const ON = { routerFusion: { enabled: true, surfaces: { gatewayRuns: true } } }
const OFF = { routerFusion: { enabled: false, surfaces: { gatewayRuns: true } } }

const ACTOR = {
  keyId: "key-a",
  keyName: "CI robot",
  scopes: ["runs:create", "runs:read", "nonsense"],
}

function fakeHost(overrides: Record<string, unknown> = {}) {
  const seen: { name: string; args: unknown }[] = []
  const record =
    (name: string, answer: unknown = { ok: true, value: { runId: "run-1" } }) =>
    (_deps: unknown, args: unknown) => {
      seen.push({ name, args })
      return Promise.resolve(answer)
    }
  const host = {
    runApiDeps: () => ({ deps: true }),
    isRunApiScope: (scope: string) => scope !== "nonsense",
    createRunFromApi: record("create"),
    getRunFromApi: record("get"),
    listRunEventsFromApi: record("events", {
      ok: true,
      value: { events: [], lastSeq: 0, terminal: false },
    }),
    cancelRunFromApi: record("cancel"),
    resumeRunFromApi: record("resume"),
    submitFeedbackFromApi: record("feedback"),
    getSessionFromApi: record("session"),
    getArtifactFromApi: record("artifact"),
    readArtifactFromApi: record("artifact-read"),
    createChatRunFromApi: record("chat-create"),
    chatResultFromApi: record("chat-result"),
    ...overrides,
  } as unknown as RouterFusionHost
  return { host, seen }
}

beforeEach(() => {
  __resetBreakerForTesting()
})

describe("isRouterFusionBridgeCommand", () => {
  it("names the eleven commands Rust sends and nothing else", () => {
    expect(ROUTER_FUSION_BRIDGE_COMMANDS).toHaveLength(11)
    for (const command of ROUTER_FUSION_BRIDGE_COMMANDS) {
      expect(isRouterFusionBridgeCommand(command)).toBe(true)
    }
    expect(isRouterFusionBridgeCommand("router_fusion_run_delete")).toBe(false)
    expect(isRouterFusionBridgeCommand("execution_run_control")).toBe(false)
  })
})

describe("dispatchRouterFusionBridgeCommand", () => {
  it("[ACC:OFF-01] refuses while the surface is off, loading nothing", async () => {
    const loadHost = jest.fn()
    const outcome = await dispatchRouterFusionBridgeCommand(
      "router_fusion_run_create",
      { actor: ACTOR, body: {} },
      { settings: OFF, loadHost: loadHost as unknown as () => Promise<RouterFusionHost> }
    )
    expect(outcome).toEqual({
      ok: false,
      error: {
        status: 403,
        code: "ROUTER_FUSION_DISABLED",
        message: "Router + Fusion runs are switched off for this host",
      },
    })
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("passes the caller's own body and key through to the Run API", async () => {
    const { host, seen } = fakeHost()
    const outcome = await dispatchRouterFusionBridgeCommand(
      "router_fusion_run_create",
      { actor: ACTOR, body: { mode: "auto" }, idempotencyKey: "k1" },
      { settings: ON, loadHost: async () => host }
    )
    expect(outcome).toEqual({ ok: true, value: { runId: "run-1" } })
    expect(seen[0]).toMatchObject({
      name: "create",
      args: { body: { mode: "auto" }, idempotencyKey: "k1" },
    })
  })

  it("drops a scope this build does not know rather than passing it along", async () => {
    const { host, seen } = fakeHost()
    await dispatchRouterFusionBridgeCommand(
      "router_fusion_run_get",
      { actor: ACTOR, runId: "run-1" },
      { settings: ON, loadHost: async () => host }
    )
    expect((seen[0].args as { actor: { scopes: string[] } }).actor.scopes).toEqual([
      "runs:create",
      "runs:read",
    ])
  })

  it("routes each command to its own verb, carrying the run id", async () => {
    const { host, seen } = fakeHost()
    const deps = { settings: ON, loadHost: async () => host }
    await dispatchRouterFusionBridgeCommand(
      "router_fusion_run_get",
      { actor: ACTOR, runId: "r" },
      deps
    )
    await dispatchRouterFusionBridgeCommand(
      "router_fusion_run_events",
      { actor: ACTOR, runId: "r", afterSeq: 4, limit: 50 },
      deps
    )
    await dispatchRouterFusionBridgeCommand(
      "router_fusion_run_cancel",
      { actor: ACTOR, runId: "r" },
      deps
    )
    await dispatchRouterFusionBridgeCommand(
      "router_fusion_run_resume",
      { actor: ACTOR, runId: "r", body: { kind: "input", messages: [] } },
      deps
    )
    await dispatchRouterFusionBridgeCommand(
      "router_fusion_run_feedback",
      { actor: ACTOR, runId: "r", feedback: { rating: "positive", comment: "good" } },
      deps
    )
    await dispatchRouterFusionBridgeCommand(
      "router_fusion_session_get",
      { actor: ACTOR, sessionId: "s" },
      deps
    )
    await dispatchRouterFusionBridgeCommand(
      "router_fusion_artifact_get",
      { actor: ACTOR, artifactId: "a", baseUrl: "http://127.0.0.1:8787" },
      deps
    )
    await dispatchRouterFusionBridgeCommand(
      "router_fusion_artifact_read",
      { actor: ACTOR, artifactId: "a", token: "t" },
      deps
    )
    await dispatchRouterFusionBridgeCommand(
      "router_fusion_chat_create",
      { actor: ACTOR, body: { model: "cognia/panel" }, idempotencyKey: "k2" },
      deps
    )
    await dispatchRouterFusionBridgeCommand(
      "router_fusion_chat_result",
      { actor: ACTOR, runId: "r", model: "cognia/panel" },
      deps
    )
    expect(seen.map((entry) => entry.name)).toEqual([
      "get",
      "events",
      "cancel",
      "resume",
      "feedback",
      "session",
      "artifact",
      "artifact-read",
      "chat-create",
      "chat-result",
    ])
    expect(seen[8].args).toMatchObject({ body: { model: "cognia/panel" }, idempotencyKey: "k2" })
    expect(seen[9].args).toMatchObject({ runId: "r", model: "cognia/panel" })
    expect(seen[1].args).toMatchObject({ runId: "r", afterSeq: 4, limit: 50 })
    expect(seen[3].args).toMatchObject({ runId: "r", body: { kind: "input", messages: [] } })
    expect(seen[4].args).toMatchObject({ body: { rating: "positive", comment: "good" } })
    expect(seen[5].args).toMatchObject({ sessionId: "s" })
    expect(seen[6].args).toMatchObject({ artifactId: "a", baseUrl: "http://127.0.0.1:8787" })
    expect(seen[7].args).toMatchObject({ artifactId: "a", token: "t" })
  })

  it("carries the Run API's own refusal back with its status and code", async () => {
    const { host } = fakeHost({
      getRunFromApi: async () => ({
        ok: false,
        error: { status: 404, code: "RUN_NOT_FOUND", message: "no such run" },
      }),
    })
    const outcome = await dispatchRouterFusionBridgeCommand(
      "router_fusion_run_get",
      { actor: ACTOR, runId: "run-1" },
      { settings: ON, loadHost: async () => host }
    )
    expect(outcome).toEqual({
      ok: false,
      error: { status: 404, code: "RUN_NOT_FOUND", message: "no such run" },
    })
  })

  it("[ACC:ISO-03] reports an infrastructure fault as unavailable and counts it", async () => {
    const outcome = await dispatchRouterFusionBridgeCommand(
      "router_fusion_run_get",
      { actor: ACTOR, runId: "run-1" },
      {
        settings: ON,
        loadHost: async () => {
          throw new RouterFusionInfrastructureError(
            "db_unavailable",
            "the fusion database will not open"
          )
        },
      }
    )
    expect(outcome).toMatchObject({
      ok: false,
      error: { status: 503, code: "ROUTER_FUSION_UNAVAILABLE" },
    })
    // Explicit fusion work never falls back to the ordinary path, but it does
    // move the breaker: a surface that keeps failing stops being asked.
    expect(getBreakerSnapshot("gatewayRuns").consecutiveFaults).toBe(1)
  })

  it("[ACC:ISO-03] refuses outright once the surface's breaker is open", async () => {
    const loadHost = jest.fn()
    const tripped = {
      routerFusion: {
        enabled: true,
        surfaces: { gatewayRuns: true },
        trippedSurfaces: { gatewayRuns: { trippedAt: 1 } },
      },
    }
    const outcome = (await dispatchRouterFusionBridgeCommand(
      "router_fusion_run_create",
      { actor: ACTOR, body: {} },
      { settings: tripped, loadHost: loadHost as unknown as () => Promise<RouterFusionHost> }
    )) as Extract<BridgeOutcome, { ok: false }>
    expect(outcome.ok).toBe(false)
    expect(outcome.error.status).toBe(503)
    expect(outcome.error.code).toBe("ROUTER_FUSION_UNAVAILABLE")
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("treats a payload with no actor as a caller with no scopes at all", async () => {
    const { host, seen } = fakeHost()
    await dispatchRouterFusionBridgeCommand(
      "router_fusion_run_get",
      { runId: "run-1" },
      { settings: ON, loadHost: async () => host }
    )
    expect((seen[0].args as { actor: unknown }).actor).toEqual({
      keyId: null,
      keyName: "",
      scopes: [],
    })
  })
})
