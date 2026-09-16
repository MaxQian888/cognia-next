/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import {
  ChatResponseSchema,
  fakeCompiledConfig,
  fixtureRouteRequest,
  RunAcceptedSchema,
  routeAction,
  uuidFromName,
  type RunRequestPolicy,
  type RunResult,
} from "@cognia/router-fusion"

import { fusionContentCodec } from "../db/content-codec"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore } from "../db/ledger-store"
import { decodeRunInput } from "../db/run-input"
import { chatResultFromApi, createChatRunFromApi, runTokenTotals } from "./chat-compat"
import {
  RUN_API_SCOPES,
  type CreateRunFromApiInput,
  type RunApiActor,
  type RunApiDeps,
} from "./run-api"

const USD = 1_000_000
const NOW = 1_800_000_000_000
const config = fakeCompiledConfig()
let dbCounter = 0

const POLICY: RunRequestPolicy = {
  trackedBudgetEnabled: true,
  maxRunCapMicrousd: () => 2 * USD,
  workspaceAuthorized: () => false,
  acceptanceProfileExists: () => false,
  minimumProfile: "economy",
  degradeAllowed: true,
}

const KEY_A: RunApiActor = { keyId: "key-a", keyName: "CI robot", scopes: [...RUN_API_SCOPES] }
const KEY_B: RunApiActor = { keyId: "key-b", keyName: "Other robot", scopes: [...RUN_API_SCOPES] }

function chatBody(overrides: Record<string, unknown> = {}) {
  return {
    model: "cognia/panel",
    messages: [
      { role: "system", content: "Answer briefly." },
      { role: "user", content: "What is the 2025 steel tariff?" },
    ],
    routing: {
      profile: "balanced",
      budget: { max_cost_usd: "1.000000", mode: "tracked" },
      deadline_ms: 120000,
      allow_degraded: false,
    },
    ...overrides,
  }
}

function harness() {
  const name = `fusion-chat-compat-test-${++dbCounter}`
  const store = new FusionLedgerStore({
    db: new FusionDB(name),
    codec: fusionContentCodec(name),
    now: () => NOW,
  })
  const created: CreateRunFromApiInput[] = []
  const started: string[] = []
  const sessions = new Map<string, ChatSession>()
  let runs = 0
  const deps: RunApiDeps = {
    store: async () => store,
    appSettings: () => ({}) as AppSettings,
    policy: () => POLICY,
    createRun: async (input) => {
      created.push(input)
      const runId = uuidFromName(`chat-run:${dbCounter}:${++runs}`)
      const { decision } = routeAction(
        config,
        fixtureRouteRequest({ runId, decisionId: uuidFromName(`d:${runId}`) })
      )
      const outcome = await store.createRun({
        runId,
        sessionId: input.session.id,
        surface: "gatewayRuns",
        origin: "gateway",
        decision,
        actionId: "direct_baseline",
        ruleId: null,
        roleDeployments: { solver: "fake-baseline" },
        config,
        capMicrousd: 1 * USD,
        maxModelCalls: 4,
        deadlineMs: 120_000,
        budgetMode: "tracked",
        tenantLimitRemainingMicrousd: null,
        actorKeyId: input.actor.keyId,
        inputArtifactId: input.inputArtifactId,
        currentSessionVersion: input.sessionVersion,
      })
      if (!outcome.ok)
        return { ok: false, error: { status: 409, code: outcome.code, message: outcome.code } }
      return { ok: true, value: { runId } }
    },
    startRun: (runId) => started.push(runId),
    session: {
      get: async (id) => sessions.get(id),
      open: async (actor, title) => {
        const session = {
          id: `s_${sessions.size + 1}`,
          title,
          transcriptRevision: 0,
          origin: { kind: "gateway-api", keyId: actor.keyId ?? "local", keyName: actor.keyName },
        } as ChatSession
        sessions.set(session.id, session)
        return session
      },
      messages: async () => [],
    },
    now: () => NOW,
    newId: (() => {
      let ids = 0
      return () => uuidFromName(`id:${dbCounter}:${++ids}`)
    })(),
  }
  return { store, deps, created, started, sessions }
}

/** Drive a created run to a sealed answer the way the orchestrator does. */
async function seal(store: FusionLedgerStore, runId: string, answer: string) {
  const lease = await store.acquireLease(runId, "worker", 60_000)
  if (!lease.ok) throw new Error(lease.code)
  await store.startRun(runId, lease.fencingToken)
  const call = await store.prepareCall(runId, lease.fencingToken, {
    logicalStepId: "direct:solver",
    role: "solver",
    deploymentId: "fake-baseline",
    reserveMicrousd: 50_000,
    requestHash: "h",
  })
  if (call.kind !== "granted") throw new Error("not granted")
  await store.markDispatched(call.attemptId, lease.fencingToken)
  await store.settleCall(call.attemptId, {
    status: "succeeded",
    usage: { inputTokens: 1_200, outputTokens: 300 },
    semantics: {
      inputIncludesCacheRead: true,
      inputIncludesCacheWrite: true,
      outputIncludesReasoning: true,
    },
    providerRequestId: "resp",
    result: { text: answer, providerRequestId: "resp", finishReason: "stop" },
  })
  const artifacts = store.artifactStore(runId)
  const stored = await artifacts.put(answer, "text/plain", `runs/${runId}/answer`)
  const record: Omit<RunResult, "answer"> = {
    answer_artifact_id: stored.artifactId,
    answer_sha256: stored.contentSha256,
    mode_executed: "direct",
    quality_status: "accepted",
    verification: {
      schema_version: "1.0.0",
      report_id: uuidFromName(`report:${runId}`),
      status: "passed",
      level: "schema_only",
      checks: [],
      revision: null,
      verifier_version: "v",
      artifact_refs: [],
    },
    delivery: "answer",
    artifact_ids: [],
    warnings: [],
  }
  const recordArtifact = await artifacts.put(
    JSON.stringify(record),
    "application/json",
    `runs/${runId}/result`
  )
  await store.finalizeRun(runId, lease.fencingToken, {
    status: "succeeded",
    resultArtifactId: stored.artifactId,
    resultRecordArtifactId: recordArtifact.artifactId,
  })
}

describe("createChatRunFromApi", () => {
  it("[ACC:API-04] creates an ordinary run in a new conversation, with the whole message snapshot as input", async () => {
    const { store, deps, created, started } = harness()
    const outcome = await createChatRunFromApi(deps, { actor: KEY_A, body: chatBody() })
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
    expect(RunAcceptedSchema.parse(outcome.value.accepted)).toEqual(outcome.value.accepted)
    expect(started).toEqual([outcome.value.accepted.run_id])
    expect(created[0].request).toMatchObject({ mode: "panel", allowed_modes: ["panel"] })
    expect(created[0].messages.map((message) => message.role)).toEqual(["system", "user"])
    const run = await store.getRun(outcome.value.accepted.run_id)
    const input = await store.artifactStore(run!.runId).get(run!.inputArtifactId!)
    expect(decodeRunInput(input?.content)?.messages).toEqual([
      { role: "system", content: "Answer briefly." },
      { role: "user", content: "What is the 2025 steel tariff?" },
    ])
  })

  it("refuses what the compat subset does not have, before any run exists", async () => {
    const { deps, created } = harness()
    const tools = await createChatRunFromApi(deps, { actor: KEY_A, body: chatBody({ tools: [] }) })
    expect(tools).toMatchObject({
      ok: false,
      error: { status: 422, code: "UNSUPPORTED_PARAMETER" },
    })
    const delegate = await createChatRunFromApi(deps, {
      actor: KEY_A,
      body: chatBody({ model: "cognia/delegate" }),
    })
    expect(delegate).toMatchObject({ ok: false, error: { code: "DELEGATE_REQUIRES_RUN_API" } })
    const noSchema = await createChatRunFromApi(deps, {
      actor: KEY_A,
      body: chatBody({ response_format: { type: "json_schema" } }),
    })
    expect(noSchema).toMatchObject({ ok: false, error: { status: 422, code: "SCHEMA_INVALID" } })
    const unscoped = await createChatRunFromApi(deps, {
      actor: { ...KEY_A, scopes: ["runs:read"] },
      body: chatBody(),
    })
    expect(unscoped).toMatchObject({ ok: false, error: { status: 403, code: "SCOPE_REQUIRED" } })
    expect(created).toHaveLength(0)
  })

  it("carries the structured-output schema into the run", async () => {
    const { deps, created } = harness()
    const schema = { type: "object", required: ["rate"], properties: { rate: { type: "number" } } }
    await createChatRunFromApi(deps, {
      actor: KEY_A,
      body: chatBody({ response_format: { type: "json_schema", json_schema: schema } }),
    })
    expect(created[0].jsonSchema).toEqual(schema)
  })

  it("replays the same run for a repeated Idempotency-Key and scopes it to the compat endpoint", async () => {
    const { deps, created } = harness()
    const first = await createChatRunFromApi(deps, {
      actor: KEY_A,
      body: chatBody(),
      idempotencyKey: "k1",
    })
    const again = await createChatRunFromApi(deps, {
      actor: KEY_A,
      body: chatBody(),
      idempotencyKey: "k1",
    })
    expect(again.ok && again.value.replayed).toBe(true)
    expect(first.ok && again.ok && again.value.accepted.run_id).toBe(
      first.ok && first.value.accepted.run_id
    )
    const changed = await createChatRunFromApi(deps, {
      actor: KEY_A,
      body: chatBody({ model: "cognia/direct" }),
      idempotencyKey: "k1",
    })
    expect(changed).toMatchObject({
      ok: false,
      error: { status: 409, code: "IDEMPOTENCY_CONFLICT" },
    })
    expect(created).toHaveLength(1)
  })
})

describe("chatResultFromApi", () => {
  it("says a run is still working, then answers in the compat shape once it succeeded", async () => {
    const { store, deps } = harness()
    const outcome = await createChatRunFromApi(deps, { actor: KEY_A, body: chatBody() })
    if (!outcome.ok) throw new Error("not created")
    const runId = outcome.value.accepted.run_id
    await expect(
      chatResultFromApi(deps, { actor: KEY_A, runId, model: "cognia/panel" })
    ).resolves.toMatchObject({
      ok: true,
      value: { state: "pending", status: "queued" },
    })

    await seal(store, runId, "The 2025 steel tariff is 4%.")
    const read = await chatResultFromApi(deps, { actor: KEY_A, runId, model: "cognia/panel" })
    if (!read.ok || read.value.state !== "succeeded") throw new Error(JSON.stringify(read))
    const response = read.value.response
    expect(ChatResponseSchema.parse(response)).toEqual(response)
    expect(response).toMatchObject({
      id: `chatcmpl-${runId}`,
      model: "cognia/panel",
      choices: [{ message: { role: "assistant", content: "The 2025 steel tariff is 4%." } }],
      usage: { prompt_tokens: 1_200, completion_tokens: 300, total_tokens: 1_500 },
      routing: { run_id: runId, mode_executed: "direct", degraded: false },
    })
    expect(response.routing.billing.spent_microusd).toBeGreaterThan(0)
  })

  it("never echoes a model name that is not one of the virtual models", async () => {
    const { store, deps } = harness()
    const outcome = await createChatRunFromApi(deps, { actor: KEY_A, body: chatBody() })
    if (!outcome.ok) throw new Error("not created")
    await seal(store, outcome.value.accepted.run_id, "ok")
    const read = await chatResultFromApi(deps, {
      actor: KEY_A,
      runId: outcome.value.accepted.run_id,
      model: "<script>",
    })
    expect(read.ok && read.value.state === "succeeded" && read.value.response.model).toBe(
      "cognia/auto"
    )
  })

  it("reports a run that ended without an answer with its own code, sorted into a compat status", async () => {
    const { store, deps } = harness()
    const outcome = await createChatRunFromApi(deps, { actor: KEY_A, body: chatBody() })
    if (!outcome.ok) throw new Error("not created")
    const runId = outcome.value.accepted.run_id
    const lease = await store.acquireLease(runId, "worker", 60_000)
    if (!lease.ok) throw new Error(lease.code)
    await store.startRun(runId, lease.fencingToken)
    await store.finalizeRun(runId, lease.fencingToken, {
      status: "failed",
      error: { code: "VERIFICATION_FAILED", message: "the answer did not pass its checks" },
    })
    // The message is whatever the run was allowed to keep of it.
    const recorded = (await store.getRun(runId))?.error?.message
    await expect(
      chatResultFromApi(deps, { actor: KEY_A, runId, model: "cognia/panel" })
    ).resolves.toEqual({
      ok: false,
      error: {
        status: 422,
        code: "VERIFICATION_FAILED",
        message: recorded,
        details: { run_id: runId, run_status: "failed" },
      },
    })
  })

  it("[ACC:AUTH-03] answers another key's run as missing", async () => {
    const { store, deps } = harness()
    const outcome = await createChatRunFromApi(deps, { actor: KEY_A, body: chatBody() })
    if (!outcome.ok) throw new Error("not created")
    await seal(store, outcome.value.accepted.run_id, "private answer")
    const read = await chatResultFromApi(deps, {
      actor: KEY_B,
      runId: outcome.value.accepted.run_id,
      model: "cognia/panel",
    })
    expect(read).toMatchObject({ ok: false, error: { status: 404, code: "RUN_NOT_FOUND" } })
    expect(JSON.stringify(read)).not.toContain("private answer")
  })
})

describe("runTokenTotals", () => {
  it("sums every call's normalized usage, adding reasoning only when output left it out", async () => {
    const { store } = harness()
    await store.db.fusionCallAttempts.bulkPut([
      {
        attemptId: "a1",
        runId: "r",
        usage: {
          input_uncached_tokens: 100,
          input_cache_read_tokens: 20,
          output_tokens: 30,
          reasoning_tokens: 5,
        },
      },
      {
        attemptId: "a2",
        runId: "r",
        usage: {
          input_uncached_tokens: 10,
          input_cache_write_5m_tokens: 1,
          input_cache_write_1h_tokens: 2,
          output_tokens: 7,
          reasoning_tokens: 4,
          reasoning_included_in_output: false,
        },
      },
      { attemptId: "a3", runId: "r", usage: null },
      { attemptId: "a4", runId: "other", usage: { input_uncached_tokens: 999 } },
    ] as never)
    await expect(runTokenTotals(store, "r")).resolves.toEqual({
      promptTokens: 133,
      completionTokens: 41,
    })
  })
})
