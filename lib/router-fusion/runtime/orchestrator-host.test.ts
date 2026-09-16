/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import type { AppSettings } from "@cognia/agent-config-types"
import {
  fakeCompiledConfig,
  FakeProvider,
  fixtureRouteRequest,
  PANEL_MEMBER_STAGE,
  PANEL_TAIL_STAGE,
  RunResultSchema,
  routeAction,
  type FakeStep,
  type RoleCallExecutor,
  type RoleCallRequest,
  type RoleCallResponse,
} from "@cognia/router-fusion"

import { fusionContentCodec } from "../db/content-codec"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore, type CreateRunInput } from "../db/ledger-store"
import type { OutboxAppliers } from "../db/outbox"
import { encodeRunInput } from "../db/run-input"
import { RouterFusionInfrastructureError } from "../gate/faults"
import {
  createHostToolRuntime,
  PANEL_READ_POLICY,
  PANEL_VERIFY_POLICY,
} from "../tools/tool-runtime"
import type { WebEvidence } from "../tools/web-evidence"
import { executeFusionRun, inputMessagesFor, reserveForAction } from "./orchestrator-host"

const USD = 1_000_000
const config = fakeCompiledConfig()
let dbCounter = 0

const appliers: OutboxAppliers = {
  usage_row: jest.fn(async () => "applied" as const),
  execution_run_milestone: jest.fn(async () => "applied" as const),
  execution_run_projection: jest.fn(async () => "applied" as const),
  session_message: jest.fn(async () => "applied" as const),
}

function harness() {
  const name = `fusion-orchestrator-test-${++dbCounter}`
  const db = new FusionDB(name)
  const store = new FusionLedgerStore({ db, codec: fusionContentCodec(name) })
  return { db, store }
}

function runInput(runId: string, overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  const { decision } = routeAction(
    config,
    fixtureRouteRequest({ runId, decisionId: `decision-${runId}` })
  )
  return {
    runId,
    sessionId: null,
    surface: "gatewayRuns",
    origin: "gateway",
    decision,
    actionId: "direct_baseline",
    ruleId: null,
    roleDeployments: { solver: "fake-baseline" },
    config,
    capMicrousd: 1 * USD,
    maxModelCalls: 8,
    deadlineMs: 600_000,
    budgetMode: "tracked",
    tenantLimitRemainingMicrousd: null,
    ...overrides,
  }
}

function answering(response: Partial<RoleCallResponse> = {}): RoleCallExecutor {
  return {
    call: jest.fn(async () => ({
      outcome: "ok",
      text: "the answer",
      usage: { inputTokens: 100, outputTokens: 20 },
      semantics: {
        inputIncludesCacheRead: true,
        inputIncludesCacheWrite: true,
        outputIncludesReasoning: true,
      },
      providerRequestId: "resp_1",
      finishReason: "stop",
      ...response,
    })) as RoleCallExecutor["call"],
  }
}

function deps(store: FusionLedgerStore, overrides: Record<string, unknown> = {}) {
  return {
    store: async () => store,
    appliers,
    leaseOwner: "worker:test",
    appSettings: () => ({}) as AppSettings,
    executor: answering(),
    sleep: async () => {},
    heartbeatMs: 1_000_000,
    ...overrides,
  }
}

const MESSAGES = [{ role: "user" as const, content: "write me a haiku" }]

beforeEach(() => {
  ;(appliers.usage_row as jest.Mock).mockClear()
  ;(appliers.execution_run_milestone as jest.Mock).mockClear()
  ;(appliers.execution_run_projection as jest.Mock).mockClear()
  ;(appliers.session_message as jest.Mock).mockClear()
})

/** Store a run's input the way the Run API does, and point the run at it. */
async function storeInput(
  store: FusionLedgerStore,
  runId: string,
  input: {
    messages: typeof MESSAGES
    jsonSchema?: Record<string, unknown>
    allowDegraded?: boolean
  }
) {
  const stored = await store.artifactStore(runId).put(
    encodeRunInput({
      messages: input.messages,
      allowDegraded: input.allowDegraded ?? false,
      jsonSchema: input.jsonSchema ?? null,
    }),
    "application/json",
    `runs/${runId}/input`
  )
  await store.db.fusionRuns.update(runId, { inputArtifactId: stored.artifactId })
  return stored.artifactId
}

describe("reserveForAction", () => {
  it("takes the reservation the route decided for this run's action", () => {
    const run = { actionId: "direct_baseline", budget: { capMicrousd: 999 } } as never
    expect(
      reserveForAction(run, {
        candidates: [
          { action_id: "direct_economy", reserve_cost_microusd: 1 },
          { action_id: "direct_baseline", reserve_cost_microusd: 42 },
        ],
      })
    ).toBe(42)
    // With no decision on file the run cap is the only honest bound.
    expect(reserveForAction(run, null)).toBe(999)
  })
})

describe("inputMessagesFor", () => {
  it("prefers what the caller still has, and otherwise reads the run's own input back", async () => {
    const { store } = harness()
    await store.createRun(runInput("run-input"))
    const run = (await store.getRun("run-input"))!
    expect(await inputMessagesFor(store, run, MESSAGES)).toBe(MESSAGES)
    // A worker that restarted has no messages and no artifact: nothing to send.
    expect(await inputMessagesFor(store, run, undefined)).toBeNull()

    const stored = await store
      .artifactStore("run-input")
      .put(JSON.stringify(MESSAGES), "application/json", "runs/run-input/input")
    const withInput = { ...run, inputArtifactId: stored.artifactId }
    expect(await inputMessagesFor(store, withInput, undefined)).toEqual(MESSAGES)
    expect(await inputMessagesFor(store, withInput, [])).toEqual(MESSAGES)
  })

  it("treats an artifact that is not a message list as no input at all", async () => {
    const { store } = harness()
    await store.createRun(runInput("run-bad-input"))
    const run = (await store.getRun("run-bad-input"))!
    const broken = await store
      .artifactStore("run-bad-input")
      .put("not json", "application/json", "runs/run-bad-input/input")
    expect(
      await inputMessagesFor(store, { ...run, inputArtifactId: broken.artifactId }, undefined)
    ).toBeNull()
    const empty = await store
      .artifactStore("run-bad-input")
      .put("[]", "application/json", "runs/run-bad-input/input")
    expect(
      await inputMessagesFor(store, { ...run, inputArtifactId: empty.artifactId }, undefined)
    ).toBeNull()
    expect(
      await inputMessagesFor(store, { ...run, inputArtifactId: "missing" }, undefined)
    ).toBeNull()
  })
})

describe("executeFusionRun", () => {
  it("seals a run it has no input for rather than sending an empty prompt", async () => {
    const { store } = harness()
    await store.createRun(runInput("run-no-input"))
    const outcome = await executeFusionRun(deps(store), { runId: "run-no-input" })
    expect(outcome).toMatchObject({ kind: "failed", code: "RUN_INPUT_MISSING" })
    expect((await store.getRun("run-no-input"))?.status).toBe("failed")
  })

  it("reads a run's stored input when the caller has none", async () => {
    const { store } = harness()
    await store.createRun(runInput("run-stored-input"))
    const stored = await store
      .artifactStore("run-stored-input")
      .put(JSON.stringify(MESSAGES), "application/json", "runs/run-stored-input/input")
    await store.db.fusionRuns.update("run-stored-input", { inputArtifactId: stored.artifactId })
    const outcome = await executeFusionRun(deps(store), { runId: "run-stored-input" })
    expect(outcome).toMatchObject({ kind: "succeeded" })
  })

  it("runs a direct run to a sealed answer and drains the outbox", async () => {
    const { db, store } = harness()
    await store.createRun(runInput("run-1"))
    const outcome = await executeFusionRun(deps(store), { runId: "run-1", messages: MESSAGES })
    expect(outcome).toMatchObject({ kind: "succeeded" })
    if (outcome.kind !== "succeeded") return

    expect(outcome.result.answer).toBe("the answer")
    expect(outcome.result.mode_executed).toBe("direct")
    const run = await store.getRun("run-1")
    expect(run?.status).toBe("succeeded")
    expect(run?.resultArtifactId).toBe(outcome.result.answer_artifact_id)
    expect((await db.fusionCallAttempts.toArray())[0]).toMatchObject({
      state: "SUCCEEDED",
      logicalStepId: "direct:solver",
      providerRequestId: "resp_1",
    })
    // The journal is the status source, so the graph's own phases are in it.
    const events = await store.listEvents("run-1")
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "run.queued",
        "route.selected",
        "phase.changed",
        "verification.completed",
      ])
    )
    expect(appliers.execution_run_milestone).toHaveBeenCalled()
  })

  it("applies the run's cockpit row as soon as it starts, before any model call", async () => {
    // A Run API run that only reached `/agent-runs` once it had finished could
    // never be stopped from there.
    const { store } = harness()
    await store.createRun(runInput("run-early"))
    const seenBeforeCall: string[] = []
    const executor: RoleCallExecutor = {
      call: jest.fn(async () => {
        const phases = (appliers.execution_run_projection as jest.Mock).mock.calls.map(
          ([row]) => (row as { payload: { phase: string } }).payload.phase
        )
        seenBeforeCall.push(...phases)
        const response: RoleCallResponse = {
          outcome: "ok",
          text: "the answer",
          usage: { inputTokens: 1, outputTokens: 1 },
          semantics: {
            inputIncludesCacheRead: true,
            inputIncludesCacheWrite: true,
            outputIncludesReasoning: true,
          },
          providerRequestId: null,
          finishReason: "stop",
        }
        return response
      }) as unknown as RoleCallExecutor["call"],
    }
    await executeFusionRun(deps(store, { executor }), { runId: "run-early", messages: MESSAGES })
    expect(seenBeforeCall).toEqual(["queued", "running"])
  })

  it("keeps running when the early cockpit update cannot be applied", async () => {
    const { store } = harness()
    await store.createRun(runInput("run-early-fail"))
    ;(appliers.execution_run_projection as jest.Mock).mockRejectedValueOnce(new Error("busy"))
    const outcome = await executeFusionRun(deps(store), {
      runId: "run-early-fail",
      messages: MESSAGES,
    })
    expect(outcome).toMatchObject({ kind: "succeeded" })
  })

  it("streams the answer to the caller when asked", async () => {
    const { store } = harness()
    await store.createRun(runInput("run-stream"))
    const deltas: string[] = []
    const executor: RoleCallExecutor = {
      call: async (request) => {
        request.onDelta?.("the ")
        request.onDelta?.("answer")
        return {
          outcome: "ok",
          text: "the answer",
          usage: { inputTokens: 1, outputTokens: 1 },
          semantics: {
            inputIncludesCacheRead: true,
            inputIncludesCacheWrite: true,
            outputIncludesReasoning: true,
          },
          providerRequestId: null,
          finishReason: "stop",
        }
      },
    }
    await executeFusionRun(deps(store, { executor }), {
      runId: "run-stream",
      messages: MESSAGES,
      stream: true,
      onDelta: (text) => deltas.push(text),
    })
    expect(deltas).toEqual(["the ", "answer"])
  })

  it("leaves a run another worker is holding alone", async () => {
    const { store } = harness()
    await store.createRun(runInput("run-busy"))
    await store.acquireLease("run-busy", "worker:other", 60_000)
    const outcome = await executeFusionRun(deps(store), { runId: "run-busy", messages: MESSAGES })
    expect(outcome).toEqual({ kind: "busy" })
    expect((await store.getRun("run-busy"))?.status).toBe("queued")
  })

  it("reports a run that does not exist rather than inventing one", async () => {
    const { store } = harness()
    const outcome = await executeFusionRun(deps(store), { runId: "nope", messages: MESSAGES })
    expect(outcome).toMatchObject({ kind: "failed", code: "RUN_NOT_FOUND" })
  })

  it("seals the run failed when the provider keeps failing, and says why", async () => {
    const { store } = harness()
    await store.createRun(runInput("run-fail"))
    const executor: RoleCallExecutor = {
      call: async () => ({
        outcome: "error",
        errorClass: "server_error",
        message: "upstream is down",
      }),
    }
    const outcome = await executeFusionRun(deps(store, { executor }), {
      runId: "run-fail",
      messages: MESSAGES,
    })
    expect(outcome.kind).toBe("failed")
    const run = await store.getRun("run-fail")
    expect(run?.status).toBe("failed")
    expect(run?.error?.code).toBeTruthy()
  })

  it("[ACC:REC-04] seals a cancelled run once, and the answer never appears", async () => {
    const { store } = harness()
    await store.createRun(runInput("run-cancel"))
    const controller = new AbortController()
    controller.abort()
    const outcome = await executeFusionRun(deps(store), {
      runId: "run-cancel",
      messages: MESSAGES,
      signal: controller.signal,
    })
    expect(outcome).toEqual({ kind: "cancelled" })
    const run = await store.getRun("run-cancel")
    expect(run?.status).toBe("cancelled")
    expect(run?.resultArtifactId).toBeNull()
  })

  it("books an executor that threw as sent-with-no-answer, never as free", async () => {
    // A throw out of the provider call proves nothing about whether the request
    // left, so the money stays held and the run says the outcome is unknown.
    const { db, store } = harness()
    await store.createRun(runInput("run-threw"))
    const executor: RoleCallExecutor = {
      call: async () => {
        throw new Error("the socket died")
      },
    }
    const outcome = await executeFusionRun(deps(store, { executor }), {
      runId: "run-threw",
      messages: MESSAGES,
    })
    expect(outcome).toMatchObject({ kind: "failed", code: "CALL_OUTCOME_UNKNOWN" })
    expect((await db.fusionCallAttempts.toArray())[0].state).toBe("UNKNOWN")
    expect((await store.getAccount()).activeHoldsMicrousd).toBeGreaterThan(0)
  })

  it("does not seal the run on an infrastructure fault: recovery owns it", async () => {
    const { db, store } = harness()
    await store.createRun(runInput("run-fault"))
    // The snapshot a run pinned is written with the run; losing it is a broken
    // database, not a routing answer. A worker that picks the run up after a
    // reload has no cached copy to fall back on.
    await db.fusionConfigSnapshots.clear()
    const reloaded = new FusionLedgerStore({ db, codec: fusionContentCodec(db.name) })
    await expect(
      executeFusionRun(deps(reloaded), { runId: "run-fault", messages: MESSAGES })
    ).rejects.toBeInstanceOf(RouterFusionInfrastructureError)
    expect((await store.getRun("run-fault"))?.status).toBe("queued")
  })

  it("refuses to guess credentials when it has neither settings nor an executor", async () => {
    const { store } = harness()
    await store.createRun(runInput("run-no-settings"))
    await expect(
      executeFusionRun(deps(store, { executor: undefined, appSettings: () => undefined }), {
        runId: "run-no-settings",
        messages: MESSAGES,
      })
    ).rejects.toBeInstanceOf(RouterFusionInfrastructureError)
  })
})

const TOTAL_SCHEMA = {
  type: "object",
  required: ["total"],
  properties: { total: { type: "number" } },
  additionalProperties: false,
}

/** Answer by logical step; anything unscripted is a visible failure. */
function scripted(
  steps: Record<string, FakeStep | ((request: RoleCallRequest) => FakeStep)>
): FakeProvider {
  return new FakeProvider((request) => {
    const step = steps[request.logicalStepId]
    if (!step) return { kind: "text", text: `unscripted ${request.logicalStepId}` }
    return typeof step === "function" ? step(request) : step
  })
}

function fakeWeb(pages: Record<string, string>): WebEvidence {
  return {
    async fetchPage(url) {
      const content = pages[url]
      return content === undefined
        ? { ok: false, code: "HTTP_ERROR", message: "404", audit: [] }
        : { ok: true, finalUrl: url, title: "page", content, truncated: false }
    },
  }
}

/** The evidence a tool round handed back, as the member saw it. */
function evidenceShown(request: RoleCallRequest): unknown[] {
  const text = request.messages.map((message) => message.content).join("\n")
  return [...text.matchAll(/evidence: (\{[^\n]*\})/g)].map(
    (match) => JSON.parse(match[1]) as unknown
  )
}

function candidateStep(answer: string, refs: unknown[]): FakeStep {
  return {
    kind: "json",
    value: {
      answer,
      claims: [{ claim_id: "c1", text: "the 2025 steel tariff is 4%", evidence_refs: refs }],
      assumptions: [],
      open_questions: [],
    },
  }
}

describe("executeFusionRun: cascade and panel (B3)", () => {
  it("[ACC:SSE-02] escalates a cascade, seals the verified answer with its record, and journals byte ranges only", async () => {
    const { db, store } = harness()
    await store.createRun(
      runInput("run-cascade", {
        actionId: "cascade_schema",
        roleDeployments: { cheap: "fake-economy", strong: "fake-baseline" },
        acceptanceProfile: "schema_fixture",
        task: "data.extract",
      })
    )
    await storeInput(store, "run-cascade", {
      messages: [{ role: "user", content: "Add up the invoice lines and return the total." }],
      jsonSchema: TOTAL_SCHEMA,
    })
    const executor = scripted({
      "cascade:cheap": { kind: "invalid_json", text: "SECRET-DRAFT not json" },
      "cascade:cheap:format_repair:1": {
        kind: "invalid_json",
        text: "SECRET-DRAFT still not json",
      },
      "cascade:strong": { kind: "json", value: { total: 42 } },
    })
    const outcome = await executeFusionRun(deps(store, { executor }), { runId: "run-cascade" })
    expect(outcome).toMatchObject({ kind: "succeeded" })
    if (outcome.kind !== "succeeded") return
    expect(RunResultSchema.parse(outcome.result)).toEqual(outcome.result)
    expect(outcome.result).toMatchObject({ mode_executed: "cascade", quality_status: "accepted" })
    expect(JSON.parse(outcome.result.answer)).toEqual({ total: 42 })
    expect(executor.requests.map((request) => request.logicalStepId)).toEqual([
      "cascade:cheap",
      "cascade:cheap:format_repair:1",
      "cascade:strong",
    ])
    // The strong model was never shown the cheap draft.
    const strong = executor.requests[2].messages.map((message) => message.content).join("\n")
    expect(strong).not.toContain("SECRET-DRAFT")

    const run = await store.getRun("run-cascade")
    expect(run).toMatchObject({
      status: "succeeded",
      resultArtifactId: outcome.result.answer_artifact_id,
    })
    const record = await store.artifactStore("run-cascade").get(run!.resultRecordArtifactId!)
    const { answer: _answer, ...expectedRecord } = outcome.result
    expect(JSON.parse(record!.content)).toEqual(expectedRecord)

    const events = await store.listEvents("run-cascade")
    const types = events.map((event) => event.type)
    const completed = types.indexOf("answer.completed")
    expect(types.indexOf("answer.delta")).toBeGreaterThan(-1)
    expect(completed).toBeGreaterThan(types.indexOf("answer.delta"))
    const sealed = events.findIndex(
      (event) => event.type === "phase.changed" && event.payload.to === "succeeded"
    )
    expect(completed).toBeLessThan(sealed)
    expect(sealed).toBeLessThan(types.indexOf("run.completed"))
    expect(events[completed].payload).toMatchObject({
      answer_artifact_id: outcome.result.answer_artifact_id,
      result_artifact_id: run!.resultRecordArtifactId,
      mode_executed: "cascade",
    })
    // The journal names the answer; it never holds it, nor the draft.
    const journal = JSON.stringify(events)
    expect(journal).not.toContain("SECRET-DRAFT")
    expect(journal).not.toContain('"total":42')
    const attempts = await db.fusionCallAttempts.toArray()
    expect(attempts.map((a) => [a.logicalStepId, a.state]).sort()).toEqual([
      ["cascade:cheap", "SUCCEEDED"],
      ["cascade:cheap:format_repair:1", "SUCCEEDED"],
      ["cascade:strong", "SUCCEEDED"],
    ])
  })

  it("runs a panel through the host's own tools and evidence checks", async () => {
    const { db, store } = harness()
    await store.createRun(
      runInput("run-panel", {
        actionId: "panel_review",
        roleDeployments: {
          panel_a: "fake-economy",
          panel_b: "fake-independent",
          judge: "fake-baseline",
          synthesizer: "fake-baseline",
        },
        acceptanceProfile: "evidence_review",
        task: "research.synthesis",
        maxModelCalls: 24,
        capMicrousd: 2 * USD,
      })
    )
    await storeInput(store, "run-panel", {
      messages: [{ role: "user", content: "What is the 2025 steel tariff? Cite a source." }],
    })
    const page = "The 2025 steel tariff is 4%, up from 2% in 2024."
    const fetchStep = (url: string): FakeStep => ({
      kind: "tool_call",
      name: "web_fetch",
      arguments: { url },
    })
    const cite = (answer: string) => (request: RoleCallRequest) =>
      candidateStep(answer, evidenceShown(request))
    const executor = scripted({
      "panel:member:panel_a:1": fetchStep("https://example.com/tariffs"),
      "panel:member:panel_a:2": cite("A: 4% in 2025"),
      "panel:member:panel_b:1": fetchStep("https://example.com/tariffs"),
      "panel:member:panel_b:2": cite("B: rose to 4%"),
      "panel:judge:1": {
        kind: "json",
        value: {
          supported_claim_ids: ["A.c1", "B.c1"],
          rejected_claim_ids: [],
          contradictions: [],
          missing_requirements: [],
          verification_requests: [],
          ready_to_synthesize: true,
        },
      },
      "panel:synthesis": (request) => {
        const shown = request.messages.map((message) => message.content).join("\n")
        const artifactId = /"artifact_id":\s*"([^"]+)"/.exec(shown)?.[1] ?? "none"
        return {
          kind: "json",
          value: {
            answer: "The 2025 steel tariff is 4%.",
            used_claim_ids: ["A.c1"],
            uncertainties: [],
            citations: [{ claim_id: "A.c1", artifact_id: artifactId }],
          },
        }
      },
      "panel:final_check": {
        kind: "json",
        value: {
          status: "passed",
          new_unsupported_claims: [],
          missing_requirements: [],
          lost_citations: [],
        },
      },
    })
    const tools = jest.fn(async (toolStore: FusionLedgerStore, run: { runId: string }) => ({
      runtime: createHostToolRuntime({
        store: toolStore,
        runId: run.runId,
        web: fakeWeb({ "https://example.com/tariffs": page }),
        workspace: null,
        now: () => Date.now(),
      }),
      memberPolicyId: PANEL_READ_POLICY,
      verificationPolicyId: PANEL_VERIFY_POLICY,
    }))
    const outcome = await executeFusionRun(deps(store, { executor, tools }), { runId: "run-panel" })
    if (outcome.kind !== "succeeded") throw new Error(JSON.stringify(outcome))
    expect(RunResultSchema.parse(outcome.result)).toEqual(outcome.result)
    expect(outcome.result).toMatchObject({
      mode_executed: "panel",
      quality_status: "accepted",
      answer: "The 2025 steel tariff is 4%.",
    })
    // Members were offered the read tools, and a fetch was recorded once per member step.
    expect(executor.requests[0].tools?.map((tool) => tool.name)).toContain("web_fetch")
    const operations = await db.fusionToolOperations.toArray()
    expect(operations.map((op) => op.toolName)).toEqual(["web_fetch", "web_fetch"])
    // The cited evidence is this run's own stored page.
    const cited = evidenceShown(
      executor.requests.find((r) => r.logicalStepId === "panel:member:panel_a:2")!
    )
    expect(cited).toHaveLength(1)
    const [ref] = cited as Array<{ artifact_id: string }>
    expect((await store.artifactStore("run-panel").get(ref.artifact_id))?.content).toBe(page)
    // Stages were reserved before the first call.
    const stages = (await db.fusionReservations.where("runId").equals("run-panel").toArray())
      .filter((row) => row.kind === "stage")
      .map((row) => row.stageId)
    expect(stages.sort()).toEqual(
      [`run-panel:${PANEL_MEMBER_STAGE}`, `run-panel:${PANEL_TAIL_STAGE}`].sort()
    )
    expect((await store.getRun("run-panel"))?.status).toBe("succeeded")
  })

  it("writes a transcript run's answer to its session through the outbox", async () => {
    const { store } = harness()
    // The Run API stores the input first and creates the run pointing at it.
    const input = await store
      .artifactStore("run-transcript")
      .put(
        encodeRunInput({ messages: MESSAGES, allowDegraded: false, jsonSchema: null }),
        "application/json",
        "runs/run-transcript/input"
      )
    await store.createRun(
      runInput("run-transcript", {
        sessionId: "session-9",
        writesSessionTranscript: true,
        inputArtifactId: input.artifactId,
        expectedSessionVersion: 3,
        currentSessionVersion: 3,
      })
    )
    const outcome = await executeFusionRun(deps(store), { runId: "run-transcript" })
    expect(outcome.kind).toBe("succeeded")
    const effects = (appliers.session_message as jest.Mock).mock.calls.map(
      ([row]) => (row as { effectId: string }).effectId
    )
    expect(effects).toEqual(
      expect.arrayContaining(["session:run-transcript:input", "session:run-transcript:answer"])
    )
  })

  it("refuses a delegate run this build does not execute, sending nothing", async () => {
    const { store } = harness()
    await store.createRun(
      runInput("run-delegate", {
        actionId: "delegate_code",
        roleDeployments: { lead: "fake-baseline", worker: "fake-economy" },
      })
    )
    const executor = answering()
    const outcome = await executeFusionRun(deps(store, { executor }), {
      runId: "run-delegate",
      messages: MESSAGES,
    })
    expect(outcome).toMatchObject({ kind: "failed", code: "MODE_NOT_AVAILABLE" })
    expect(executor.call).not.toHaveBeenCalled()
    expect((await store.getRun("run-delegate"))?.error?.code).toBe("MODE_NOT_AVAILABLE")
  })

  it("[ACC:AUTH-07] refuses a call the account stopped allowing, before it is sent", async () => {
    const { db, store } = harness()
    await store.createRun(runInput("run-revoked"))
    const executor = answering()
    const liveRefusal = jest.fn(() => "PROVIDER_DISABLED")
    const outcome = await executeFusionRun(deps(store, { executor, liveRefusal }), {
      runId: "run-revoked",
      messages: MESSAGES,
    })
    expect(outcome.kind).toBe("failed")
    expect(executor.call).not.toHaveBeenCalled()
    expect(liveRefusal).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-revoked" }),
      "fake-baseline"
    )
    // Nothing went out, so nothing is held as uncertain.
    expect((await db.fusionCallAttempts.toArray()).every((a) => a.state !== "UNKNOWN")).toBe(true)
  })

  it("stops a running run when a cancel arrives from elsewhere", async () => {
    const { store } = harness()
    await store.createRun(runInput("run-cancel-remote"))
    const executor: RoleCallExecutor = {
      call: (_request, signal) =>
        new Promise<RoleCallResponse>((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ outcome: "error", errorClass: "cancelled", message: "aborted" }),
            { once: true }
          )
          // Another window (or `POST /v1/runs/{id}/cancel`) asks while the call is out.
          void store.cancelRun("run-cancel-remote")
        }),
    }
    const outcome = await executeFusionRun(deps(store, { executor, cancelPollMs: 5 }), {
      runId: "run-cancel-remote",
      messages: MESSAGES,
    })
    expect(outcome).toEqual({ kind: "cancelled" })
    const run = await store.getRun("run-cancel-remote")
    expect(run?.status).toBe("cancelled")
    expect(run?.resultArtifactId).toBeNull()
  })

  it("[ACC:REC-03] takes a lapsed run over without sending a step that was already out", async () => {
    const { db, store } = harness()
    await store.createRun(runInput("run-takeover"))
    await storeInput(store, "run-takeover", { messages: MESSAGES })
    const old = await store.acquireLease("run-takeover", "worker:crashed", 1)
    if (!old.ok) throw new Error(old.code)
    await store.startRun("run-takeover", old.fencingToken)
    const prepared = await store.prepareCall("run-takeover", old.fencingToken, {
      logicalStepId: "direct:solver",
      role: "solver",
      deploymentId: "fake-baseline",
      reserveMicrousd: 10_000,
      requestHash: "hash",
    })
    if (prepared.kind !== "granted") throw new Error("not granted")
    await store.markDispatched(prepared.attemptId, old.fencingToken)
    await new Promise((resolve) => setTimeout(resolve, 5))

    const executor = answering()
    const outcome = await executeFusionRun(deps(store, { executor }), { runId: "run-takeover" })
    expect(outcome).toMatchObject({ kind: "failed", code: "CALL_OUTCOME_UNKNOWN" })
    expect(executor.call).not.toHaveBeenCalled()
    const attempts = await db.fusionCallAttempts.toArray()
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ state: "UNKNOWN", unknownReason: "worker_lost" })
    // Its money stays held until reconciliation says what it cost.
    expect((await store.getAccount()).activeHoldsMicrousd).toBeGreaterThan(0)
  })
})
