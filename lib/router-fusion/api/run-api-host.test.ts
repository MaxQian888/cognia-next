/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import type { AppSettings } from "@cognia/agent-config-types"
import {
  CONTRACT_SCHEMA_VERSION,
  fakeCompiledConfig,
  fixtureRouteRequest,
  routeAction,
  uuidFromName,
  type RunRequest,
} from "@cognia/router-fusion"

import { fusionContentCodec } from "../db/content-codec"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore } from "../db/ledger-store"
import type { RunRoute } from "../routing/run-route"

// The route itself is `run-route`'s own subject; here we drive its outcomes so
// the run creation, the cap and deadline rules and the stored facts are what
// actually runs.
const routeMock = jest.fn()
jest.mock("../routing/run-route", () => ({
  routeRunRequest: (...args: unknown[]) => routeMock(...args),
}))

jest.mock("../chat/chat-route-host", () => ({
  createChatRouteHost: () => ({
    settings: {},
    now: () => 0,
    newId: () => "id",
    currentSettings: () => undefined,
  }),
}))

jest.mock("@cognia/provider-routing", () => ({
  ProviderRoutingEngine: class {},
  createMappingRegistry: () => ({}),
}))
jest.mock("@cognia/provider-routing/build-preview-engine", () => ({
  buildRoutingEngineDeps: () => ({}),
}))

let store: FusionLedgerStore
jest.mock("../chat/store-provider", () => ({
  currentFusionStore: async () => store,
}))

const tenantLimits: Record<string, number | null> = {}
jest.mock("../chat/tenant-budget", () => ({
  tightestTenantLimit: async (_budget: unknown, deploymentIds: string[]) => {
    const limits = deploymentIds
      .map((id) => tenantLimits[id.slice(0, id.indexOf("::"))])
      .filter((limit): limit is number => typeof limit === "number")
    return limits.length > 0 ? Math.min(...limits) : null
  },
}))

const executed: string[] = []
jest.mock("../runtime/orchestrator-host", () => ({
  executeFusionRun: async (_deps: unknown, input: { runId: string }) => {
    executed.push(input.runId)
    return { kind: "succeeded" }
  },
}))

jest.mock("../tools/web-evidence", () => ({ webEvidenceAvailable: () => true }))

const createdSessions: Record<string, unknown>[] = []
jest.mock("@/lib/db/sessions", () => ({
  createSession: async (partial: Record<string, unknown>) => {
    createdSessions.push(partial)
    return { id: "session-created", transcriptRevision: 0, ...partial }
  },
  getSession: async (id: string) => ({ id, transcriptRevision: 4 }),
}))

const storedMessages: Record<string, unknown[]> = {}
jest.mock("@/lib/db/messages", () => ({
  listMessages: async (sessionId: string) => storedMessages[sessionId] ?? [],
}))

import { driveRun, isDrivingRun } from "../runtime/run-driver"
import {
  createRoutedRun,
  runApiDeps,
  runRequestPolicyOf,
  sessionPort,
  visibleMessages,
} from "./run-api-host"

const USD = 1_000_000
const config = fakeCompiledConfig()
let dbCounter = 0
const RUN_ID = uuidFromName("host-run-1")
const ROLES = {
  panel_a: "openai::gpt-5-mini",
  panel_b: "anthropic::claude-haiku",
  judge: "openai::gpt-5",
  synthesizer: "openai::gpt-5",
}

function freshStore() {
  const name = `fusion-run-api-host-test-${++dbCounter}`
  store = new FusionLedgerStore({ db: new FusionDB(name), codec: fusionContentCodec(name) })
  return store
}

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    input_messages: [{ role: "user", content: "hello there" }],
    mode: "auto",
    allowed_modes: ["direct", "panel"],
    profile: "balanced",
    budget: { max_cost_usd: "0.100000", mode: "tracked" },
    deadline_ms: 30_000,
    allow_degraded: false,
    delivery: "verified_buffered",
    ...overrides,
  } as RunRequest
}

function selected(overrides: Partial<Extract<RunRoute, { kind: "selected" }>> = {}): RunRoute {
  const { decision } = routeAction(
    config,
    fixtureRouteRequest({ runId: RUN_ID, decisionId: uuidFromName("host-decision") })
  )
  return {
    kind: "selected",
    config,
    decision,
    actionId: "panel_review",
    ruleId: "R1_explicit_mode",
    mode: "panel",
    roles: { ...ROLES },
    capMicrousd: 2 * USD,
    maxModelCalls: 24,
    deadlineMs: 120_000,
    task: "research.synthesis",
    acceptanceProfile: "evidence_review",
    dataClass: "internal",
    ...overrides,
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    request: request(),
    messages: [{ role: "user" as const, content: "hello there" }],
    jsonSchema: null,
    actor: { keyId: "key-a", keyName: "CI robot", scopes: [] as never[] },
    session: { id: "session-1", title: "t" } as never,
    sessionVersion: 0,
    capMicrousd: 100_000,
    inputArtifactId: "input-artifact",
    ...overrides,
  }
}

const APP = {
  routerFusion: { enabled: true, surfaces: { gatewayRuns: true } },
} as unknown as AppSettings

function ids(first = RUN_ID) {
  let n = 0
  return () => (n++ === 0 ? first : uuidFromName(`${first}:${n}`))
}

beforeEach(() => {
  freshStore()
  createdSessions.length = 0
  executed.length = 0
  for (const key of Object.keys(tenantLimits)) delete tenantLimits[key]
  routeMock.mockReset().mockResolvedValue(selected())
})

describe("runRequestPolicyOf", () => {
  it("reads the account's own caps and refuses what this build cannot authorize", () => {
    const policy = runRequestPolicyOf({
      routerFusion: { runCapUsdByMode: { direct: "0.40", cascade: "1.20", panel: "2.50" } },
    } as unknown as AppSettings)
    expect(policy.maxRunCapMicrousd("direct")).toBe(400_000)
    expect(policy.maxRunCapMicrousd("panel")).toBe(2_500_000)
    // Auto may land on any executable mode; the route applies the chosen one's cap.
    expect(policy.maxRunCapMicrousd("auto")).toBe(2_500_000)
    // Workspaces and acceptance profiles arrive with delegate (B4), so nothing
    // is authorized yet rather than optimistically waved through.
    expect(policy.workspaceAuthorized("ws-1")).toBe(false)
    expect(policy.acceptanceProfileExists("p")).toBe(false)
    expect(policy.degradeAllowed).toBe(true)
  })

  it("reports tracked budgets as enabled only in tracked mode", () => {
    const strict = runRequestPolicyOf({
      routerFusion: { budgetMode: "strict" },
    } as unknown as AppSettings)
    expect(strict.trackedBudgetEnabled).toBe(false)
  })
})

describe("sessionPort", () => {
  it("opens an ordinary conversation, tagged with the key that opened it", async () => {
    const session = await sessionPort().open(
      { keyId: "key-a", keyName: "CI robot", scopes: [] },
      "a title"
    )
    expect(session.id).toBe("session-created")
    expect(createdSessions[0]).toMatchObject({
      title: "a title",
      titleAuto: true,
      origin: { kind: "gateway-api", keyId: "key-a", keyName: "CI robot" },
    })
  })

  it("names a local caller rather than leaving the origin half-written", async () => {
    await sessionPort().open({ keyId: null, keyName: "the app", scopes: [] }, "t")
    expect(createdSessions[0].origin).toMatchObject({ keyId: "local", keyName: "the app" })
  })

  it("reads a session's conversation as the caller's text turns", async () => {
    storedMessages["session-read"] = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
      {
        id: "m2",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "hidden" },
          { type: "text", text: "hi" },
        ],
      },
    ]
    await expect(sessionPort().messages("session-read")).resolves.toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ])
  })
})

describe("visibleMessages", () => {
  it("keeps only user and assistant text, and drops turns with nothing to read", () => {
    expect(
      visibleMessages([
        { role: "system", parts: [{ type: "text", text: "rules" }] },
        {
          role: "user",
          parts: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
        { role: "assistant", parts: [{ type: "tool-read", input: {} }] },
        { role: "assistant", parts: [{ type: "text", text: "   " }] },
        { role: "assistant" },
        { role: "assistant", parts: [{ type: "text", text: "done" }] },
      ])
    ).toEqual([
      { role: "user", content: "ab" },
      { role: "assistant", content: "done" },
    ])
  })
})

describe("createRoutedRun", () => {
  it("creates the run the route decided — its mode, roles and facts — owned by the key that asked", async () => {
    const created = await createRoutedRun(input(), APP, { newId: ids() })
    expect(created).toEqual({ ok: true, value: { runId: RUN_ID } })
    expect(await store.getRun(RUN_ID)).toMatchObject({
      surface: "gatewayRuns",
      origin: "gateway",
      mode: "panel",
      actionId: "panel_review",
      actorKeyId: "key-a",
      actorKeyName: "CI robot",
      sessionId: "session-1",
      inputArtifactId: "input-artifact",
      roleDeployments: ROLES,
      writesSessionTranscript: true,
      task: "research.synthesis",
      acceptanceProfile: "evidence_review",
      dataClass: "internal",
      title: "hello there",
    })
  })

  it("hands the route everything it decides from", async () => {
    const schema = { type: "object" }
    await createRoutedRun(
      input({
        jsonSchema: schema,
        messages: [
          { role: "system", content: "json" },
          { role: "user", content: "q" },
        ],
      }),
      APP,
      { newId: ids(), webToolsAvailable: false }
    )
    const [host, routeInput] = routeMock.mock.calls[0]
    expect(routeInput).toMatchObject({
      runId: RUN_ID,
      jsonSchema: schema,
      sessionId: "session-1",
      webToolsAvailable: false,
      executableModes: ["direct", "cascade", "panel"],
      messages: [
        { role: "system", content: "json" },
        { role: "user", content: "q" },
      ],
    })
    // The route reads settings from the snapshot, never from a store a headless brain never loads.
    expect(host.currentSettings()).toBe(APP)
  })

  it("[ACC:BUD-08] lets a request lower the action's cap but never raise it", async () => {
    await createRoutedRun(input({ capMicrousd: 100_000 }), APP, { newId: ids() })
    expect((await store.getRun(RUN_ID))?.budget.capMicrousd).toBe(100_000)

    freshStore()
    await createRoutedRun(input({ capMicrousd: 9 * USD }), APP, { newId: ids() })
    expect((await store.getRun(RUN_ID))?.budget.capMicrousd).toBe(2 * USD)
  })

  it("takes the route's deadline, which is already the tighter of request and action", async () => {
    routeMock.mockResolvedValue(selected({ deadlineMs: 30_000 }))
    const before = Date.now()
    await createRoutedRun(input(), APP, { newId: ids() })
    const run = await store.getRun(RUN_ID)
    expect(run!.deadlineAt - before).toBeLessThanOrEqual(30_000 + 1_000)
  })

  it("refuses with the router's own reasons when nothing fits, and opens no run", async () => {
    routeMock.mockResolvedValue({
      kind: "refused",
      code: "ROUTE_NO_SOLUTION",
      reasons: ["panel_review:PANEL_SAME_REVISION"],
      decision: null,
    })
    const created = await createRoutedRun(input(), APP, { newId: ids() })
    expect(created).toMatchObject({
      ok: false,
      error: {
        status: 422,
        code: "ROUTE_NO_SOLUTION",
        details: { reasons: ["panel_review:PANEL_SAME_REVISION"] },
      },
    })
    expect(await store.db.fusionRuns.count()).toBe(0)
  })

  it("reports a busy session as a conflict, not as a validation error", async () => {
    await createRoutedRun(input(), APP, { newId: ids() })
    const second = await createRoutedRun(input(), APP, { newId: ids(uuidFromName("host-run-2")) })
    expect(second).toMatchObject({
      ok: false,
      error: { status: 409, code: "SESSION_BUSY", details: { activeRunId: RUN_ID } },
    })
  })

  it("holds against the tightest budget over every provider the run may call", async () => {
    tenantLimits.openai = 5 * USD
    tenantLimits.anthropic = 1
    const refused = await createRoutedRun(input(), APP, { newId: ids() })
    expect(refused).toMatchObject({ ok: false, error: { status: 422 } })
    expect(await store.db.fusionRuns.count()).toBe(0)

    tenantLimits.anthropic = null
    await expect(createRoutedRun(input(), APP, { newId: ids() })).resolves.toMatchObject({
      ok: true,
    })
  })
})

describe("runApiDeps", () => {
  it("validates against the snapshot it was given, and says so when there is none", () => {
    expect(runApiDeps(APP).policy().trackedBudgetEnabled).toBe(true)
    expect(() => runApiDeps(null).policy()).toThrow("no settings")
  })

  it("refuses to create a run with no settings to route it by", async () => {
    await expect(runApiDeps(null).createRun(input() as never)).resolves.toMatchObject({
      ok: false,
      error: { status: 503, code: "SETTINGS_UNAVAILABLE" },
    })
  })

  it("drives each run once in this process, however often it is started", async () => {
    const deps = runApiDeps(APP)
    deps.startRun("run-x")
    deps.startRun("run-x")
    runApiDeps(APP).startRun("run-x")
    expect(isDrivingRun("run-x")).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(executed).toEqual(["run-x"])
    expect(isDrivingRun("run-x")).toBe(false)
    driveRun("run-x", () => APP)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(executed).toEqual(["run-x", "run-x"])
  })
})
