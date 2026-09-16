/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import {
  ArtifactMetadataSchema,
  CONTRACT_SCHEMA_VERSION,
  fakeCompiledConfig,
  fixtureRouteRequest,
  routeAction,
  RunAcceptedSchema,
  RunEventSchema,
  RunSnapshotSchema,
  SessionSnapshotSchema,
  uuidFromName,
  type RunRequestPolicy,
} from "@cognia/router-fusion"

import { fusionContentCodec } from "../db/content-codec"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore } from "../db/ledger-store"
import { decodeRunInput } from "../db/run-input"
import { __resetArtifactTokenKeyForTesting } from "./artifact-tokens"
import {
  cancelRunFromApi,
  contractEventOf,
  createRunFromApi,
  getArtifactFromApi,
  getRunFromApi,
  getSessionFromApi,
  isRunApiScope,
  listRunEventsFromApi,
  messagesOf,
  ownsSession,
  readArtifactFromApi,
  resumeRunFromApi,
  RUN_API_SCOPES,
  sessionVersionOf,
  submitFeedbackFromApi,
  titleFor,
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
  maxRunCapMicrousd: () => 5 * USD,
  workspaceAuthorized: () => false,
  acceptanceProfileExists: () => false,
  minimumProfile: "economy",
  degradeAllowed: true,
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    input_messages: [{ role: "user", content: "write me a haiku about ledgers" }],
    mode: "auto",
    allowed_modes: ["direct"],
    profile: "balanced",
    budget: { max_cost_usd: "0.500000", mode: "tracked" },
    deadline_ms: 60_000,
    allow_degraded: false,
    delivery: "verified_buffered",
    ...overrides,
  }
}

const KEY_A: RunApiActor = { keyId: "key-a", keyName: "CI robot", scopes: [...RUN_API_SCOPES] }
const KEY_B: RunApiActor = { keyId: "key-b", keyName: "Other robot", scopes: [...RUN_API_SCOPES] }

const runIdOf = (n: number) => uuidFromName(`run:${n}`)

function harness(overrides: Partial<RunApiDeps> = {}) {
  const name = `fusion-run-api-test-${++dbCounter}`
  const store = new FusionLedgerStore({
    db: new FusionDB(name),
    codec: fusionContentCodec(name),
    now: () => NOW,
  })
  const started: string[] = []
  const sessions = new Map<string, ChatSession>()
  const transcripts = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>()
  const created: CreateRunFromApiInput[] = []
  let runs = 0
  let ids = 0
  const createRun = jest.fn(async (input: CreateRunFromApiInput) => {
    created.push(input)
    const runId = runIdOf(++runs)
    const { decision } = routeAction(
      config,
      fixtureRouteRequest({ runId, decisionId: uuidFromName(`decision:${runId}`) })
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
      deadlineMs: 60_000,
      budgetMode: "tracked",
      tenantLimitRemainingMicrousd: null,
      actorKeyId: input.actor.keyId,
      inputArtifactId: input.inputArtifactId,
      currentSessionVersion: input.sessionVersion,
    })
    if (!outcome.ok) {
      return {
        ok: false as const,
        error: { status: 409 as const, code: outcome.code, message: outcome.code },
      }
    }
    return { ok: true as const, value: { runId } }
  })
  const deps: RunApiDeps = {
    store: async () => store,
    appSettings: () => ({}) as AppSettings,
    policy: () => POLICY,
    createRun,
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
      messages: async (id) => transcripts.get(id) ?? [],
    },
    now: () => NOW,
    newId: () => uuidFromName(`id:${++ids}`),
    ...overrides,
  }
  return { store, deps, started, sessions, transcripts, created, createRun }
}

async function accept(deps: RunApiDeps, actor = KEY_A, extra: Record<string, unknown> = {}) {
  const outcome = await createRunFromApi(deps, { actor, body: body(extra) })
  if (!outcome.ok) throw new Error(`create refused: ${outcome.error.code}`)
  return outcome.value.accepted
}

/** Drive a created run to success, with a sealed result like the orchestrator writes. */
async function seal(store: FusionLedgerStore, runId: string, answer = "an answer") {
  const lease = await store.acquireLease(runId, "test-worker", 60_000)
  if (!lease.ok) throw new Error(lease.code)
  await store.startRun(runId, lease.fencingToken)
  const artifacts = store.artifactStore(runId)
  const answerArtifact = await artifacts.put(answer, "text/markdown", `runs/${runId}/answer`)
  const record = await artifacts.put(
    JSON.stringify({
      answer_artifact_id: answerArtifact.artifactId,
      answer_sha256: answerArtifact.contentSha256,
      mode_executed: "direct",
      quality_status: "accepted",
      verification: {
        schema_version: CONTRACT_SCHEMA_VERSION,
        report_id: uuidFromName(`report:${runId}`),
        status: "passed",
        level: "schema_only",
        checks: [],
        revision: null,
        verifier_version: "text-verifiers-1",
        artifact_refs: [],
      },
      delivery: "answer",
      artifact_ids: [answerArtifact.artifactId],
      warnings: [],
    }),
    "application/json",
    `runs/${runId}/result`
  )
  const sealed = await store.finalizeRun(runId, lease.fencingToken, {
    status: "succeeded",
    resultArtifactId: answerArtifact.artifactId,
    resultRecordArtifactId: record.artifactId,
  })
  if (!sealed.ok) throw new Error(sealed.code)
}

describe("scopes", () => {
  it("names the six scopes a gateway key can carry", () => {
    expect(RUN_API_SCOPES).toEqual([
      "runs:create",
      "runs:read",
      "runs:cancel",
      "runs:approve",
      "artifacts:read",
      "feedback:write",
    ])
    expect(isRunApiScope("runs:create")).toBe(true)
    expect(isRunApiScope("runs:delete")).toBe(false)
    expect(isRunApiScope(null)).toBe(false)
  })

  it("[ACC:AUTH-01] refuses a legacy key, which carries no scopes at all", async () => {
    const { deps } = harness()
    const legacy: RunApiActor = { keyId: "legacy", keyName: "old key", scopes: [] }
    const created = await createRunFromApi(deps, { actor: legacy, body: body() })
    expect(created).toMatchObject({ ok: false, error: { status: 403, code: "SCOPE_REQUIRED" } })
    const read = await getRunFromApi(deps, { actor: legacy, runId: runIdOf(1) })
    expect(read).toMatchObject({ ok: false, error: { status: 403 } })
  })

  it("[ACC:AUTH-02] checks each verb against its own scope", async () => {
    const { deps } = harness()
    const readOnly: RunApiActor = { keyId: "key-a", keyName: "reader", scopes: ["runs:read"] }
    const runId = runIdOf(1)
    await expect(cancelRunFromApi(deps, { actor: readOnly, runId })).resolves.toMatchObject({
      ok: false,
      error: { status: 403, details: { scope: "runs:cancel" } },
    })
    await expect(
      resumeRunFromApi(deps, { actor: readOnly, runId, body: {} })
    ).resolves.toMatchObject({
      ok: false,
      error: { details: { scope: "runs:approve" } },
    })
    await expect(
      submitFeedbackFromApi(deps, { actor: readOnly, runId, body: { rating: "positive" } })
    ).resolves.toMatchObject({ ok: false, error: { details: { scope: "feedback:write" } } })
    await expect(createRunFromApi(deps, { actor: readOnly, body: body() })).resolves.toMatchObject({
      ok: false,
      error: { details: { scope: "runs:create" } },
    })
  })
})

describe("createRunFromApi", () => {
  it("[ACC:API-01] answers with the contract's RunAccepted, binds a conversation and starts the run", async () => {
    const { deps, started, created } = harness()
    const outcome = await createRunFromApi(deps, { actor: KEY_A, body: body() })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const { accepted, replayed } = outcome.value
    expect(RunAcceptedSchema.parse(accepted)).toEqual(accepted)
    expect(accepted).toMatchObject({ run_id: runIdOf(1), status: "queued", session_version: 0 })
    expect(replayed).toBe(false)
    expect(started).toEqual([runIdOf(1)])
    expect(created[0].messages).toEqual([
      { role: "user", content: "write me a haiku about ledgers" },
    ])
    expect(created[0].jsonSchema).toBeNull()
  })

  it("stores the request's input and options where a restarted worker finds them", async () => {
    const { deps, store } = harness()
    const accepted = await accept(deps, KEY_A, { allow_degraded: true })
    const run = await store.getRun(accepted.run_id)
    const stored = await store.artifactStore(accepted.run_id).get(run!.inputArtifactId!)
    expect(decodeRunInput(stored?.content)).toEqual({
      messages: [{ role: "user", content: "write me a haiku about ledgers" }],
      allowDegraded: true,
      jsonSchema: null,
    })
    expect((await store.db.fusionArtifacts.get(run!.inputArtifactId!))?.runId).toBe(accepted.run_id)
  })

  it("[ACC:API-04] refuses a request that is not the contract, naming what was wrong", async () => {
    const { deps, createRun } = harness()
    const refused = await createRunFromApi(deps, { actor: KEY_A, body: body({ temperature: 0.2 }) })
    expect(refused).toMatchObject({
      ok: false,
      error: {
        status: 422,
        code: "UNSUPPORTED_PARAMETER",
        details: { issues: [{ details: { fields: ["temperature"] } }] },
      },
    })
    expect(createRun).not.toHaveBeenCalled()
  })

  it("refuses a budget above what the account allows", async () => {
    const { deps } = harness({ policy: () => ({ ...POLICY, maxRunCapMicrousd: () => 100_000 }) })
    await expect(createRunFromApi(deps, { actor: KEY_A, body: body() })).resolves.toMatchObject({
      ok: false,
      error: { status: 422, code: "BUDGET_ABOVE_LIMIT" },
    })
  })

  it("accepts cascade and panel, and refuses delegate rather than quietly running another mode", async () => {
    const { deps, started } = harness()
    for (const mode of ["cascade", "panel"]) {
      await expect(
        createRunFromApi(deps, { actor: KEY_A, body: body({ mode, allowed_modes: [mode] }) })
      ).resolves.toMatchObject({ ok: true })
    }
    const delegate = await createRunFromApi(deps, {
      actor: KEY_A,
      body: body({ mode: "auto", allowed_modes: ["delegate"] }),
    })
    expect(delegate).toMatchObject({
      ok: false,
      error: {
        status: 422,
        code: "MODE_NOT_AVAILABLE",
        details: { available: ["direct", "cascade", "panel"] },
      },
    })
    expect(started).toHaveLength(2)
  })

  it("[ACC:API-02] replays the run of a repeated Idempotency-Key instead of buying a second one", async () => {
    const { deps, started, createRun } = harness()
    const first = await createRunFromApi(deps, { actor: KEY_A, body: body(), idempotencyKey: "k1" })
    const second = await createRunFromApi(deps, {
      actor: KEY_A,
      body: body(),
      idempotencyKey: "k1",
    })
    expect(first).toMatchObject({
      ok: true,
      value: { accepted: { run_id: runIdOf(1) }, replayed: false },
    })
    expect(second).toMatchObject({
      ok: true,
      value: { accepted: { run_id: runIdOf(1) }, replayed: true },
    })
    if (first.ok && second.ok)
      expect(second.value.accepted.session_id).toBe(first.value.accepted.session_id)
    expect(createRun).toHaveBeenCalledTimes(1)
    expect(started).toEqual([runIdOf(1)])
  })

  it("[ACC:API-02] reports a reused key with a different body as a conflict", async () => {
    const { deps } = harness()
    await createRunFromApi(deps, { actor: KEY_A, body: body(), idempotencyKey: "k1" })
    const clash = await createRunFromApi(deps, {
      actor: KEY_A,
      body: body({ deadline_ms: 30_000 }),
      idempotencyKey: "k1",
    })
    expect(clash).toMatchObject({ ok: false, error: { status: 409, code: "IDEMPOTENCY_CONFLICT" } })
  })

  it("scopes an Idempotency-Key to its own key, so two callers never collide", async () => {
    const { deps, createRun } = harness()
    await createRunFromApi(deps, { actor: KEY_A, body: body(), idempotencyKey: "k1" })
    const other = await createRunFromApi(deps, { actor: KEY_B, body: body(), idempotencyKey: "k1" })
    expect(other).toMatchObject({
      ok: true,
      value: { accepted: { run_id: runIdOf(2) }, replayed: false },
    })
    expect(createRun).toHaveBeenCalledTimes(2)
  })

  it("starts a new run when the key it replayed points at a run that was reaped", async () => {
    const { deps, store, createRun } = harness()
    await createRunFromApi(deps, { actor: KEY_A, body: body(), idempotencyKey: "k1" })
    await store.db.fusionRuns.clear()
    await store.db.fusionSessionLocks.clear()
    const again = await createRunFromApi(deps, { actor: KEY_A, body: body(), idempotencyKey: "k1" })
    expect(again).toMatchObject({ ok: true, value: { accepted: { run_id: runIdOf(2) } } })
    expect(createRun).toHaveBeenCalledTimes(2)
  })

  it("continues a conversation by the contract's UUID, at the version the caller read", async () => {
    const { deps, sessions, created, store } = harness()
    const first = await accept(deps)
    await seal(store, first.run_id)
    await store.db.fusionOutbox
      .where("kind")
      .equals("session_message")
      .modify({ status: "applied" })
    const session = [...sessions.values()][0]
    sessions.set(session.id, { ...session, transcriptRevision: 2 })

    const next = await createRunFromApi(deps, {
      actor: KEY_A,
      body: body({ session_id: first.session_id, expected_session_version: 2 }),
    })
    expect(next).toMatchObject({
      ok: true,
      value: { accepted: { session_id: first.session_id, session_version: 2 } },
    })
    expect(created[1].session.id).toBe(session.id)
  })

  it("[ACC:API-03] refuses a follow-up whose session moved on since the caller read it", async () => {
    const { deps, sessions } = harness()
    const first = await accept(deps)
    const session = [...sessions.values()][0]
    sessions.set(session.id, { ...session, transcriptRevision: 3 })
    const conflict = await createRunFromApi(deps, {
      actor: KEY_A,
      body: body({ session_id: first.session_id, expected_session_version: 2 }),
    })
    expect(conflict).toMatchObject({
      ok: false,
      error: { status: 409, code: "SESSION_VERSION_CONFLICT", details: { expected: 2, actual: 3 } },
    })
  })

  it("[ACC:AUTH-03] will not continue a conversation another key opened", async () => {
    const { deps } = harness()
    const first = await accept(deps, KEY_A)
    const stolen = await createRunFromApi(deps, {
      actor: KEY_B,
      body: body({ session_id: first.session_id, expected_session_version: 0 }),
    })
    expect(stolen).toMatchObject({ ok: false, error: { status: 404, code: "SESSION_NOT_FOUND" } })
  })

  it("will not continue a conversation id it never issued", async () => {
    const { deps } = harness()
    const unknown = await createRunFromApi(deps, {
      actor: KEY_A,
      body: body({
        session_id: "99999999-9999-4999-8999-999999999999",
        expected_session_version: 0,
      }),
    })
    expect(unknown).toMatchObject({ ok: false, error: { status: 404, code: "SESSION_NOT_FOUND" } })
  })
})

describe("reading a run", () => {
  it("[ACC:AUTH-03] tells another key the run does not exist, rather than that it may not see it", async () => {
    const { deps } = harness()
    const accepted = await accept(deps)
    const mine = await getRunFromApi(deps, { actor: KEY_A, runId: accepted.run_id })
    expect(mine).toMatchObject({
      ok: true,
      value: { snapshot: { run_id: accepted.run_id, status: "queued" } },
    })
    if (mine.ok) expect(RunSnapshotSchema.parse(mine.value.snapshot)).toEqual(mine.value.snapshot)
    const denied = await getRunFromApi(deps, { actor: KEY_B, runId: accepted.run_id })
    expect(denied).toEqual({
      ok: false,
      error: { status: 404, code: "RUN_NOT_FOUND", message: "no such run" },
    })
  })

  it("[ACC:SSE-01] replays contract events after a seq, and says whether the caller is caught up", async () => {
    const { deps, store } = harness()
    const { run_id } = await accept(deps)
    const all = await listRunEventsFromApi(deps, { actor: KEY_A, runId: run_id })
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.value.events.map((event) => event.event_type)).toEqual([
      "run.queued",
      "route.selected",
    ])
    for (const event of all.value.events) expect(RunEventSchema.parse(event)).toEqual(event)
    expect(all.value.lastSeq).toBe(2)
    expect(all.value.terminal).toBe(false)

    const after = await listRunEventsFromApi(deps, { actor: KEY_A, runId: run_id, afterSeq: 1 })
    expect(after.ok && after.value.events.map((event) => event.seq)).toEqual([2])

    // Asking from beyond the run's history is being caught up, not an error.
    const beyond = await listRunEventsFromApi(deps, { actor: KEY_A, runId: run_id, afterSeq: 99 })
    expect(beyond.ok && beyond.value.events).toEqual([])
    expect((await store.getRun(run_id))?.lastSeq).toBe(2)
  })

  it("marks a page terminal only once it reaches the terminal event", async () => {
    const { deps, store } = harness()
    const { run_id } = await accept(deps)
    await seal(store, run_id)
    const partial = await listRunEventsFromApi(deps, { actor: KEY_A, runId: run_id, limit: 2 })
    expect(partial).toMatchObject({ ok: true, value: { terminal: false } })
    const rest = await listRunEventsFromApi(deps, { actor: KEY_A, runId: run_id, afterSeq: 2 })
    expect(rest).toMatchObject({ ok: true, value: { terminal: true } })
  })

  it("carries a journal type the contract lacks as a phase change, losing nothing", () => {
    const event = contractEventOf({
      runId: runIdOf(1),
      seq: 7,
      type: "candidate.rejected",
      payload: { stage: "cheap" },
      createdAt: NOW,
    })
    expect(RunEventSchema.parse(event)).toEqual(event)
    expect(event).toMatchObject({
      event_type: "phase.changed",
      payload: { stage: "cheap", event: "candidate.rejected" },
    })
    expect(
      contractEventOf({
        runId: runIdOf(1),
        seq: 1,
        type: "run.queued",
        payload: { a: 1 },
        createdAt: NOW,
      }).payload
    ).toEqual({ a: 1 })
  })

  it("[ACC:SSE-04] answers 410 once the journal is gone, and still serves the snapshot", async () => {
    const { deps, store } = harness()
    const { run_id } = await accept(deps)
    await seal(store, run_id)
    const lastSeq = (await store.getRun(run_id))!.lastSeq
    // What retention does once the event window has passed.
    await store.db.fusionRunEvents.where("runId").equals(run_id).delete()

    for (const afterSeq of [0, 1, lastSeq - 1]) {
      await expect(
        listRunEventsFromApi(deps, { actor: KEY_A, runId: run_id, afterSeq })
      ).resolves.toMatchObject({
        ok: false,
        error: { status: 410, code: "EVENT_HISTORY_EXPIRED", details: { lastSeq } },
      })
    }
    // A client that already has everything is simply caught up.
    await expect(
      listRunEventsFromApi(deps, { actor: KEY_A, runId: run_id, afterSeq: lastSeq })
    ).resolves.toMatchObject({ ok: true, value: { events: [], terminal: true } })
    const snapshot = await getRunFromApi(deps, { actor: KEY_A, runId: run_id })
    expect(snapshot).toMatchObject({
      ok: true,
      value: { snapshot: { run_id, status: "succeeded" } },
    })
    if (snapshot.ok)
      expect(RunSnapshotSchema.parse(snapshot.value.snapshot)).toEqual(snapshot.value.snapshot)
  })

  it("never replays around a hole in the middle of a journal", async () => {
    const { deps, store } = harness()
    const { run_id } = await accept(deps)
    await store.db.fusionRunEvents.delete([run_id, 1])
    await expect(
      listRunEventsFromApi(deps, { actor: KEY_A, runId: run_id })
    ).resolves.toMatchObject({
      ok: false,
      error: { status: 410 },
    })
    // From after the hole, the journal is whole again.
    await expect(
      listRunEventsFromApi(deps, { actor: KEY_A, runId: run_id, afterSeq: 1 })
    ).resolves.toMatchObject({ ok: true })
  })

  it("carries the decision, the billing and the sealed result, answer included", async () => {
    const { deps, store } = harness()
    const { run_id } = await accept(deps)
    const pending = await getRunFromApi(deps, { actor: KEY_A, runId: run_id })
    expect(pending).toMatchObject({
      ok: true,
      value: {
        snapshot: {
          result: null,
          decision: { run_id },
          phase: "intake",
          billing: { budget_cap_microusd: 1 * USD, model_calls: 0 },
          pending_approval_id: null,
          error: null,
        },
        resultExpired: false,
      },
    })

    await seal(store, run_id, "paper columns, ink")
    const done = await getRunFromApi(deps, { actor: KEY_A, runId: run_id })
    expect(done).toMatchObject({
      ok: true,
      value: {
        snapshot: {
          status: "succeeded",
          phase: "finalize",
          result: {
            answer: "paper columns, ink",
            mode_executed: "direct",
            quality_status: "accepted",
          },
        },
        resultExpired: false,
      },
    })
    if (done.ok) expect(RunSnapshotSchema.parse(done.value.snapshot)).toEqual(done.value.snapshot)
  })

  it("says the result expired rather than that there never was one", async () => {
    const { deps, store } = harness()
    const { run_id } = await accept(deps)
    await seal(store, run_id, "gone by now")
    const run = (await store.getRun(run_id))!
    await store.db.fusionArtifacts.delete(run.resultArtifactId!)
    await expect(getRunFromApi(deps, { actor: KEY_A, runId: run_id })).resolves.toMatchObject({
      ok: true,
      value: { snapshot: { status: "succeeded", result: null }, resultExpired: true },
    })
  })

  it("reports a failed run's error in the contract's shape", async () => {
    const { deps, store } = harness()
    const { run_id } = await accept(deps)
    const lease = await store.acquireLease(run_id, "w", 60_000)
    if (!lease.ok) throw new Error(lease.code)
    await store.finalizeRun(run_id, lease.fencingToken, {
      status: "failed",
      error: { code: "VERIFICATION_FAILED", message: "no" },
    })
    const read = await getRunFromApi(deps, { actor: KEY_A, runId: run_id })
    expect(read).toMatchObject({
      ok: true,
      value: {
        snapshot: { error: { code: "VERIFICATION_FAILED", retryable: false, trace_id: run_id } },
      },
    })
    if (read.ok) expect(RunSnapshotSchema.parse(read.value.snapshot)).toEqual(read.value.snapshot)
  })

  it("keeps another key out of the event stream too", async () => {
    const { deps } = harness()
    const { run_id } = await accept(deps)
    await expect(
      listRunEventsFromApi(deps, { actor: KEY_B, runId: run_id })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "RUN_NOT_FOUND" },
    })
  })
})

describe("reading a session", () => {
  it("shows the key that opened it the version to send back and the conversation", async () => {
    const { deps, store, sessions, transcripts } = harness()
    const { session_id, run_id } = await accept(deps)
    const session = [...sessions.values()][0]
    transcripts.set(session.id, [
      { role: "user", content: "write me a haiku about ledgers" },
      { role: "assistant", content: "columns of small debts" },
    ])
    sessions.set(session.id, { ...session, transcriptRevision: 2 })
    const read = await getSessionFromApi(deps, { actor: KEY_A, sessionId: session_id })
    expect(read).toEqual({
      ok: true,
      value: {
        session_id,
        version: 2,
        active_run_id: run_id,
        messages: [
          { role: "user", content: "write me a haiku about ledgers" },
          { role: "assistant", content: "columns of small debts" },
        ],
      },
    })
    if (read.ok) expect(SessionSnapshotSchema.parse(read.value)).toEqual(read.value)
    expect((await store.db.fusionApiSessions.get(session_id))?.sessionId).toBe(session.id)
  })

  it("is invisible to another key, to a key without the scope and for an id never issued", async () => {
    const { deps } = harness()
    const { session_id } = await accept(deps)
    const notFound = { ok: false, error: { status: 404, code: "SESSION_NOT_FOUND" } }
    await expect(
      getSessionFromApi(deps, { actor: KEY_B, sessionId: session_id })
    ).resolves.toMatchObject(notFound)
    await expect(
      getSessionFromApi(deps, { actor: KEY_A, sessionId: "99999999-9999-4999-8999-999999999999" })
    ).resolves.toMatchObject(notFound)
    await expect(
      getSessionFromApi(deps, { actor: { ...KEY_A, scopes: [] }, sessionId: session_id })
    ).resolves.toMatchObject({ ok: false, error: { status: 403, code: "SCOPE_REQUIRED" } })
  })

  it("never shows a conversation the app's own UI opened, even under a mapped id", async () => {
    const { deps, sessions } = harness()
    const { session_id } = await accept(deps)
    const session = [...sessions.values()][0]
    sessions.set(session.id, { ...session, origin: undefined })
    await expect(
      getSessionFromApi(deps, { actor: KEY_A, sessionId: session_id })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "SESSION_NOT_FOUND" },
    })
  })

  it("recognizes only a gateway key's own conversations", () => {
    const tagged = {
      id: "s",
      origin: { kind: "gateway-api", keyId: "key-a", keyName: "x" },
    } as ChatSession
    expect(ownsSession(tagged, KEY_A)).toBe(true)
    expect(ownsSession(tagged, KEY_B)).toBe(false)
    expect(ownsSession({ id: "s" } as ChatSession, KEY_A)).toBe(false)
    const local = {
      id: "s",
      origin: { kind: "gateway-api", keyId: "local", keyName: "app" },
    } as ChatSession
    expect(ownsSession(local, { keyId: null, keyName: "app", scopes: [] })).toBe(true)
  })
})

describe("reading an artifact", () => {
  beforeEach(() => __resetArtifactTokenKeyForTesting())

  it("hands its owner the contract's metadata and a sixty-second link that reads the content", async () => {
    const { deps, store } = harness()
    const { run_id } = await accept(deps)
    const stored = await store
      .artifactStore(run_id)
      .put("the answer", "text/markdown", `runs/${run_id}/answer`)

    const meta = await getArtifactFromApi(deps, {
      actor: KEY_A,
      artifactId: stored.artifactId,
      baseUrl: "http://127.0.0.1:8765/",
    })
    expect(meta).toMatchObject({
      ok: true,
      value: {
        artifact_id: stored.artifactId,
        content_sha256: stored.contentSha256,
        media_type: "text/markdown",
        size_bytes: 10,
        expires_at: new Date(NOW + 60_000).toISOString(),
      },
    })
    if (!meta.ok) return
    expect(ArtifactMetadataSchema.parse(meta.value)).toEqual(meta.value)
    const url = new URL(meta.value.read_url)
    expect(`${url.origin}${url.pathname}`).toBe(
      `http://127.0.0.1:8765/v1/artifacts/${stored.artifactId}/content`
    )
    await expect(
      readArtifactFromApi(deps, {
        actor: KEY_A,
        artifactId: stored.artifactId,
        token: url.searchParams.get("token"),
      })
    ).resolves.toEqual({
      ok: true,
      value: {
        content: "the answer",
        mediaType: "text/markdown",
        contentSha256: stored.contentSha256,
      },
    })
  })

  it("refuses an expired link and a link that was never issued", async () => {
    let now = NOW
    const { deps, store } = harness({ now: () => now })
    const { run_id } = await accept(deps)
    const stored = await store
      .artifactStore(run_id)
      .put("the answer", "text/plain", `runs/${run_id}/answer`)
    const meta = await getArtifactFromApi(deps, {
      actor: KEY_A,
      artifactId: stored.artifactId,
      baseUrl: "http://h",
    })
    if (!meta.ok) throw new Error("metadata refused")
    const token = new URL(meta.value.read_url).searchParams.get("token")

    await expect(
      readArtifactFromApi(deps, { actor: KEY_A, artifactId: stored.artifactId, token: "123.abc" })
    ).resolves.toMatchObject({ ok: false, error: { status: 403, code: "READ_TOKEN_INVALID" } })
    now += 60_000
    await expect(
      readArtifactFromApi(deps, { actor: KEY_A, artifactId: stored.artifactId, token })
    ).resolves.toMatchObject({ ok: false, error: { status: 410, code: "READ_TOKEN_EXPIRED" } })
  })

  it("[ACC:CACHE-05] keeps identical content of two keys, and of two accounts, apart", async () => {
    const { deps, store } = harness()
    const runA = (await accept(deps, KEY_A)).run_id
    const runB = (await accept(deps, KEY_B)).run_id
    const same = "the same private text"
    const ofA = await store.artifactStore(runA).put(same, "text/plain", "answer")
    const ofB = await store.artifactStore(runB).put(same, "text/plain", "answer")
    // Content-addressed, but bound to the run that wrote it: no shared entry to read through.
    expect(ofA.contentSha256).toBe(ofB.contentSha256)
    expect(ofA.artifactId).not.toBe(ofB.artifactId)

    const metaB = await getArtifactFromApi(deps, {
      actor: KEY_B,
      artifactId: ofB.artifactId,
      baseUrl: "http://h",
    })
    if (!metaB.ok) throw new Error("key B could not read its own artifact")
    const tokenB = new URL(metaB.value.read_url).searchParams.get("token")
    await expect(
      getArtifactFromApi(deps, { actor: KEY_B, artifactId: ofA.artifactId, baseUrl: "http://h" })
    ).resolves.toMatchObject({ ok: false, error: { status: 404, code: "ARTIFACT_NOT_FOUND" } })
    // Key B's valid token for its own artifact does not open key A's.
    await expect(
      readArtifactFromApi(deps, { actor: KEY_B, artifactId: ofA.artifactId, token: tokenB })
    ).resolves.toMatchObject({ ok: false, error: { status: 404 } })
    // Key A's link, replayed by key B, is refused before the token is even read.
    const metaA = await getArtifactFromApi(deps, {
      actor: KEY_A,
      artifactId: ofA.artifactId,
      baseUrl: "http://h",
    })
    if (!metaA.ok) throw new Error("key A could not read its own artifact")
    const tokenA = new URL(metaA.value.read_url).searchParams.get("token")
    await expect(
      readArtifactFromApi(deps, { actor: KEY_B, artifactId: ofA.artifactId, token: tokenA })
    ).resolves.toMatchObject({ ok: false, error: { status: 404 } })

    // Another account is another database: the same content is not there at all.
    const other = harness().store
    await expect(other.artifactStore(runA).get(ofA.artifactId)).resolves.toBeNull()
    expect(other.db.name).not.toBe(store.db.name)
  })

  it("will not hand out an artifact without the artifacts:read scope, or one no run owns", async () => {
    const { deps, store } = harness()
    const { run_id } = await accept(deps)
    const owned = await store.artifactStore(run_id).put("x", "text/plain", "n")
    const orphan = await store.artifactStore(null).put("y", "text/plain", "utility")
    await expect(
      getArtifactFromApi(deps, {
        actor: { ...KEY_A, scopes: ["runs:read"] },
        artifactId: owned.artifactId,
        baseUrl: "http://h",
      })
    ).resolves.toMatchObject({ ok: false, error: { status: 403, code: "SCOPE_REQUIRED" } })
    await expect(
      getArtifactFromApi(deps, { actor: KEY_A, artifactId: orphan.artifactId, baseUrl: "http://h" })
    ).resolves.toMatchObject({ ok: false, error: { code: "ARTIFACT_NOT_FOUND" } })
  })
})

describe("cancel, resume and feedback", () => {
  it("[ACC:API-05] cancels the caller's own run and answers with its snapshot", async () => {
    const { deps, store } = harness()
    const { run_id } = await accept(deps)
    const cancelled = await cancelRunFromApi(deps, { actor: KEY_A, runId: run_id })
    expect(cancelled).toMatchObject({ ok: true, value: { status: "cancelled" } })
    if (cancelled.ok) expect(RunSnapshotSchema.parse(cancelled.value)).toEqual(cancelled.value)
    expect((await store.getRun(run_id))?.status).toBe("cancelled")
    // Cancelling twice is the caller getting what it asked for.
    await expect(cancelRunFromApi(deps, { actor: KEY_A, runId: run_id })).resolves.toMatchObject({
      ok: true,
      value: { status: "cancelled" },
    })
  })

  it("validates a resume against the contract, and refuses one the run is not waiting for", async () => {
    const { deps, started } = harness()
    const { run_id } = await accept(deps)
    await expect(
      resumeRunFromApi(deps, { actor: KEY_A, runId: run_id, body: { kind: "input" } })
    ).resolves.toMatchObject({ ok: false, error: { status: 422, code: "SCHEMA_INVALID" } })
    const notWaiting = await resumeRunFromApi(deps, {
      actor: KEY_A,
      runId: run_id,
      body: {
        kind: "input",
        expected_run_version: 2,
        input_messages: [{ role: "user", content: "more" }],
      },
    })
    expect(notWaiting).toMatchObject({ ok: false, error: { status: 409, code: "RUN_NOT_WAITING" } })
    const approval = await resumeRunFromApi(deps, {
      actor: KEY_A,
      runId: run_id,
      body: {
        kind: "approval",
        expected_run_version: 2,
        approval_id: "99999999-9999-4999-8999-999999999999",
        decision: "approve",
      },
    })
    expect(approval).toMatchObject({ ok: false, error: { status: 409, code: "RUN_NOT_WAITING" } })
    expect(started).toEqual([run_id])
  })

  it("resumes a run waiting for input with the new messages, at the version the caller saw", async () => {
    const { deps, store, started } = harness()
    const { run_id } = await accept(deps)
    const run = (await store.getRun(run_id))!
    await store.db.fusionRuns.put({ ...run, status: "waiting_for_input" })

    const stale = await resumeRunFromApi(deps, {
      actor: KEY_A,
      runId: run_id,
      body: {
        kind: "input",
        expected_run_version: 1,
        input_messages: [{ role: "user", content: "the rest" }],
      },
    })
    expect(stale).toMatchObject({ ok: false, error: { status: 409, code: "RUN_VERSION_CONFLICT" } })

    const resumed = await resumeRunFromApi(deps, {
      actor: KEY_A,
      runId: run_id,
      body: {
        kind: "input",
        expected_run_version: run.lastSeq,
        input_messages: [{ role: "user", content: "the rest" }],
      },
    })
    expect(resumed).toMatchObject({ ok: true, value: { status: "queued" } })
    const updated = (await store.getRun(run_id))!
    const input = await store.artifactStore(run_id).get(updated.inputArtifactId!)
    expect(decodeRunInput(input?.content)?.messages).toEqual([
      { role: "user", content: "write me a haiku about ledgers" },
      { role: "user", content: "the rest" },
    ])
    expect(started).toEqual([run_id, run_id])
  })

  it("[ACC:API-06] stores a contract verdict, keeping the caller's words out of the row", async () => {
    const { deps, store } = harness()
    const { run_id } = await accept(deps)
    const written = await submitFeedbackFromApi(deps, {
      actor: KEY_A,
      runId: run_id,
      body: { rating: "negative", comment: "it missed the point" },
    })
    expect(written).toEqual({ ok: true, value: { accepted: true } })
    const row = (await store.db.fusionFeedback.toArray())[0]
    expect(row).toMatchObject({ runId: run_id, actorKeyId: "key-a", rating: "down" })
    expect(JSON.stringify(row)).not.toContain("missed the point")
    const artifact = await store.artifactStore(run_id).get(row.commentArtifactId!)
    expect(artifact?.content).toBe("it missed the point")
  })

  it.each([
    ["a rating that is not one of the two", { rating: "sideways" }],
    ["the pre-contract spelling", { rating: "up" }],
    ["an unknown field", { rating: "positive", label: "use this for training" }],
    ["no body at all", undefined],
  ])("refuses %s", async (_label, feedback) => {
    const { deps, store } = harness()
    const { run_id } = await accept(deps)
    await expect(
      submitFeedbackFromApi(deps, { actor: KEY_A, runId: run_id, body: feedback })
    ).resolves.toMatchObject({ ok: false, error: { status: 422, code: "SCHEMA_INVALID" } })
    expect(await store.db.fusionFeedback.count()).toBe(0)
  })

  it("will not take feedback on another key's run", async () => {
    const { deps } = harness()
    const { run_id } = await accept(deps)
    await expect(
      submitFeedbackFromApi(deps, { actor: KEY_B, runId: run_id, body: { rating: "positive" } })
    ).resolves.toMatchObject({ ok: false, error: { code: "RUN_NOT_FOUND" } })
  })
})

describe("small helpers", () => {
  it("reads the session version from the transcript, treating a fresh session as zero", () => {
    expect(sessionVersionOf({ id: "s", transcriptRevision: 7 } as ChatSession)).toBe(7)
    expect(sessionVersionOf({ id: "s" } as ChatSession)).toBe(0)
    expect(sessionVersionOf(undefined)).toBe(0)
  })

  it("titles a conversation from the caller's first user line, bounded", () => {
    expect(
      titleFor([
        { role: "system", content: "rules" },
        { role: "user", content: "one\ntwo" },
      ])
    ).toBe("one")
    expect(titleFor([{ role: "user", content: "   " }])).toBe("Gateway run")
    expect(titleFor([{ role: "user", content: "x".repeat(200) }])).toHaveLength(80)
  })

  it("carries the request's messages through as user turns", () => {
    expect(messagesOf({ input_messages: [{ role: "user", content: "hi" }] } as never)).toEqual([
      { role: "user", content: "hi" },
    ])
  })
})
