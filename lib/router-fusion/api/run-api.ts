/**
 * The Run API, on the side that owns the data (ADR-0188 D8/D9/D24, B2–B3).
 *
 * `POST /v1/runs` and its siblings are served by the Rust gateway, but the
 * gateway holds no state: Dexie is authoritative and lives in the brain (the
 * desktop renderer or the headless Node process). Every request therefore
 * crosses the brain bridge and lands here, which is why this module speaks in
 * request/response shapes and never in HTTP. The shapes are the contract's
 * (`RunAccepted`, `RunSnapshot`, `RunEvent`, `SessionSnapshot`,
 * `ArtifactMetadata`, `Acknowledgement`); the gateway forwards them as they are.
 *
 * What it owns:
 *  - **scopes** — a key may only do what its scopes allow (`runs:create`,
 *    `runs:read`, `runs:cancel`, `runs:approve`, `artifacts:read`,
 *    `feedback:write`). A legacy key with no scopes gets none of them.
 *  - **actor isolation** (AUTH-03, CACHE-05) — a run, a conversation and an
 *    artifact belong to the key that created them. Another key is told they do
 *    not exist, which is the truth as far as that key is concerned.
 *  - **idempotency** (API-02) — the same key with the same body replays its
 *    run; with a different body it is a conflict, never a second run.
 *  - **session binding** (D24) — a run either continues a conversation the
 *    caller names (at the version it expects, API-03) or opens one tagged with
 *    the key that opened it, so it is findable in the app like any other. The
 *    contract names a conversation with a UUID; `fusionApiSessions` maps it to
 *    the app's own session id.
 *
 * Running the run is `runtime/orchestrator-host.ts`; this module starts it and
 * returns, because `POST /v1/runs` answers 202.
 */

import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import {
  CONTRACT_SCHEMA_VERSION,
  decideIdempotency,
  FeedbackRequestSchema,
  idempotencyRequestHash,
  parseRunRequest,
  ResumeRequestSchema,
  RUN_EVENT_TYPES,
  usdToMicrousd,
  type ApiIssue,
  type ArtifactMetadata,
  type BillingSummary,
  type ExecutionMode,
  type Message,
  type RouteDecision,
  type RunAccepted,
  type RunEvent,
  type RunEventType,
  type RunRequest,
  type RunRequestPolicy,
  type RunResult,
  type RunSnapshot,
  type SessionSnapshot,
} from "@cognia/router-fusion"

import type { FusionLedgerStore } from "../db/ledger-store"
import { IDEMPOTENCY_TTL_MS } from "../db/retention"
import { decodeRunInput, encodeRunInput } from "../db/run-input"
import type { FusionArtifactRow, FusionRunEventRow, FusionRunRow } from "../db/types"
import { issueArtifactReadToken, verifyArtifactReadToken } from "./artifact-tokens"

/** The scopes a gateway key can carry (D8). A legacy key has none of them. */
export const RUN_API_SCOPES = [
  "runs:create",
  "runs:read",
  "runs:cancel",
  "runs:approve",
  "artifacts:read",
  "feedback:write",
] as const
export type RunApiScope = (typeof RUN_API_SCOPES)[number]

export function isRunApiScope(value: unknown): value is RunApiScope {
  return typeof value === "string" && (RUN_API_SCOPES as readonly string[]).includes(value)
}

export interface RunApiActor {
  /** The gateway key that made the call. Null is the app itself, which is unscoped. */
  keyId: string | null
  keyName: string
  scopes: readonly RunApiScope[]
}

export interface RunApiError {
  status: 400 | 403 | 404 | 409 | 410 | 422 | 429 | 503
  code: string
  message: string
  details?: Record<string, unknown>
}

export type RunApiResult<T> = { ok: true; value: T } | { ok: false; error: RunApiError }

/**
 * The modes this build executes. Delegate needs a workspace, a sandbox and an
 * approval step (B4); until then it is refused, never downgraded (D38).
 */
export const EXECUTABLE_MODES: readonly ExecutionMode[] = ["direct", "cascade", "panel"]

/** What `POST /v1/runs` answers, plus whether an Idempotency-Key replayed it (a header in HTTP). */
export interface RunCreated {
  accepted: RunAccepted
  replayed: boolean
}

/** What `GET /v1/runs/{id}` answers, plus whether its result outlived its content (a header). */
export interface RunSnapshotRead {
  snapshot: RunSnapshot
  resultExpired: boolean
}

export interface RunEventsPage {
  events: RunEvent[]
  /** The run's newest seq, so a caller knows whether it is caught up. */
  lastSeq: number
  terminal: boolean
}

/** What the caller has to give this module so it can reach the rest of the app. */
export interface RunApiDeps {
  store: () => Promise<FusionLedgerStore>
  appSettings: () => AppSettings | undefined
  /** Route a request and create its run; `run-api-host.ts` wires the real one. */
  createRun: (input: CreateRunFromApiInput) => Promise<RunApiResult<{ runId: string }>>
  /** Start executing a created run. It answers 202, so this is not awaited. */
  startRun: (runId: string) => void
  session: SessionPort
  policy: () => RunRequestPolicy
  now?: () => number
  newId?: () => string
}

export interface SessionPort {
  get: (sessionId: string) => Promise<ChatSession | undefined>
  /** Open a conversation the app shows like any other, tagged with the key that opened it. */
  open: (actor: RunApiActor, title: string) => Promise<ChatSession>
  /** The session's visible text messages, oldest first. */
  messages: (sessionId: string) => Promise<Message[]>
}

export interface CreateRunFromApiInput {
  request: RunRequest
  /**
   * The run's input: the request's own messages, or — for a chat-compat call —
   * the whole stateless message snapshot, system and assistant turns included.
   */
  messages: Message[]
  /** The structured answer a chat-compat caller asked for. */
  jsonSchema: Record<string, unknown> | null
  actor: RunApiActor
  session: ChatSession
  sessionVersion: number
  capMicrousd: number
  /** The encrypted artifact holding `messages` and the request's options. */
  inputArtifactId: string
}

function error(
  status: RunApiError["status"],
  code: string,
  message: string,
  details?: Record<string, unknown>
): RunApiError {
  return { status, code, message, ...(details ? { details } : {}) }
}

/** A run the actor may not see is reported as missing: the same answer a stranger's id gets. */
const NOT_FOUND = error(404, "RUN_NOT_FOUND", "no such run")
const SESSION_NOT_FOUND = error(404, "SESSION_NOT_FOUND", "no such session")
const ARTIFACT_NOT_FOUND = error(404, "ARTIFACT_NOT_FOUND", "no such artifact")

/** A session belongs to the gateway key that opened it; the app's own conversations belong to no key. */
export function ownsSession(session: ChatSession, actor: RunApiActor): boolean {
  return session.origin?.kind === "gateway-api" && session.origin.keyId === (actor.keyId ?? "local")
}

export function requireScope(actor: RunApiActor, scope: RunApiScope): RunApiError | null {
  return actor.scopes.includes(scope)
    ? null
    : error(403, "SCOPE_REQUIRED", `this key is missing the ${scope} scope`, { scope })
}

export function issuesToError(issues: readonly ApiIssue[]): RunApiError {
  const first = issues[0]
  return error(first.status, first.code, first.message, {
    issues: issues.map(({ code, message, details }) => ({ code, message, details })),
  })
}

/** The version of a session's transcript, which is what `expected_session_version` names. */
export function sessionVersionOf(session: ChatSession | undefined): number {
  return session?.transcriptRevision ?? 0
}

/** The first line of the caller's own text, for a session the app has to show a name for. */
export function titleFor(messages: readonly Message[]): string {
  const first = messages.find((message) => message.role === "user")?.content ?? ""
  const line = first.split("\n", 1)[0].trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || "Gateway run"
}

/** The request's own messages, as the workflow's message list. */
export function messagesOf(request: RunRequest): Message[] {
  return request.input_messages.map((message) => ({
    role: "user" as const,
    content: message.content,
  }))
}

function scopedIdempotencyKey(actor: RunApiActor, endpoint: string, key: string): string {
  return [actor.keyId ?? "local", endpoint, key].join("\u0000")
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function clock(deps: RunApiDeps): { now: () => number; newId: () => string } {
  return {
    now: deps.now ?? (() => Date.now()),
    newId: deps.newId ?? (() => globalThis.crypto.randomUUID()),
  }
}

// ── conversations ─────────────────────────────────────────────────────────────

/** The contract's id for one of this actor's conversations, minted on first use. */
export async function apiSessionIdFor(
  store: FusionLedgerStore,
  sessionId: string,
  actor: RunApiActor,
  deps: RunApiDeps
): Promise<string> {
  const existing = await store.db.fusionApiSessions
    .where("sessionId")
    .equals(sessionId)
    .filter((row) => row.actorKeyId === (actor.keyId ?? null))
    .first()
  if (existing) return existing.apiSessionId
  const { now, newId } = clock(deps)
  const apiSessionId = newId()
  await store.db.fusionApiSessions.put({
    apiSessionId,
    sessionId,
    actorKeyId: actor.keyId ?? null,
    createdAt: now(),
  })
  return apiSessionId
}

/** The conversation behind a contract session id, if it is this actor's. */
async function sessionForActor(
  deps: RunApiDeps,
  store: FusionLedgerStore,
  apiSessionId: string,
  actor: RunApiActor
): Promise<ChatSession | null> {
  const mapping = await store.db.fusionApiSessions.get(apiSessionId)
  if (!mapping || mapping.actorKeyId !== (actor.keyId ?? null)) return null
  const session = await deps.session.get(mapping.sessionId)
  return session && ownsSession(session, actor) ? session : null
}

async function bindSession(
  deps: RunApiDeps,
  store: FusionLedgerStore,
  actor: RunApiActor,
  request: RunRequest,
  messages: readonly Message[]
): Promise<RunApiResult<{ session: ChatSession; sessionVersion: number }>> {
  if (!request.session_id) {
    const session = await deps.session.open(actor, titleFor(messages))
    await apiSessionIdFor(store, session.id, actor, deps)
    return { ok: true, value: { session, sessionVersion: sessionVersionOf(session) } }
  }
  // A key may only continue a conversation it opened (D24).
  const session = await sessionForActor(deps, store, request.session_id, actor)
  if (!session) return { ok: false, error: SESSION_NOT_FOUND }
  const version = sessionVersionOf(session)
  if (request.expected_session_version !== version) {
    return {
      ok: false,
      error: error(409, "SESSION_VERSION_CONFLICT", "the session moved on since you read it", {
        expected: request.expected_session_version,
        actual: version,
      }),
    }
  }
  return { ok: true, value: { session, sessionVersion: version } }
}

// ── creating runs ─────────────────────────────────────────────────────────────

export interface AcceptRunInput {
  actor: RunApiActor
  request: RunRequest
  messages: Message[]
  jsonSchema: Record<string, unknown> | null
  /** The body the idempotency hash covers, exactly as the caller sent it. */
  body: unknown
  endpoint: string
  idempotencyKey?: string
}

/**
 * The part of run creation both entry points share: idempotency, the
 * conversation, the stored input, the run, and its start. The request has
 * already been validated by the caller's own parser.
 */
export async function acceptRun(
  deps: RunApiDeps,
  input: AcceptRunInput
): Promise<RunApiResult<RunCreated>> {
  const requestedModes: ExecutionMode[] =
    input.request.mode === "auto" ? [...input.request.allowed_modes] : [input.request.mode]
  if (!requestedModes.some((mode) => EXECUTABLE_MODES.includes(mode))) {
    return {
      ok: false,
      error: error(
        422,
        "MODE_NOT_AVAILABLE",
        `this build executes ${EXECUTABLE_MODES.join(", ")}; delegate is not available yet`,
        { requested: requestedModes, available: EXECUTABLE_MODES }
      ),
    }
  }

  const store = await deps.store()
  const { now, newId } = clock(deps)
  const requestHash = idempotencyRequestHash(
    { actorKeyId: input.actor.keyId ?? "local", endpoint: input.endpoint },
    input.body
  )
  const scopedKey = input.idempotencyKey
    ? scopedIdempotencyKey(input.actor, input.endpoint, input.idempotencyKey)
    : null

  if (scopedKey) {
    const existing = await store.db.fusionIdempotency.get(scopedKey)
    const decision = decideIdempotency(
      existing && existing.expiresAt > now() ? existing : undefined,
      requestHash
    )
    if (decision.kind === "conflict") {
      return {
        ok: false,
        error: error(
          409,
          "IDEMPOTENCY_CONFLICT",
          "this Idempotency-Key was used with a different body"
        ),
      }
    }
    if (decision.kind === "replay") {
      const run = await store.getRun(decision.runId)
      if (run) {
        return {
          ok: true,
          value: { accepted: await acceptedOf(store, run, input.actor, deps), replayed: true },
        }
      }
      // The run it named was reaped; the key no longer points at anything.
      await store.db.fusionIdempotency.delete(scopedKey)
    }
  }

  const bound = await bindSession(deps, store, input.actor, input.request, input.messages)
  if (!bound.ok) return bound
  const { session, sessionVersion } = bound.value

  // The request is gone once this call answers 202, so the run's input is
  // stored before the run exists. If creation is refused, the artifact is an
  // orphan that expires on its own window.
  const inputArtifact = await store.artifactStore(null).put(
    encodeRunInput({
      messages: input.messages,
      allowDegraded: input.request.allow_degraded,
      jsonSchema: input.jsonSchema,
    }),
    "application/json",
    `api-input/${newId()}`
  )

  // A request may lower the action's run cap, never raise it (D22).
  const created = await deps.createRun({
    request: input.request,
    messages: input.messages,
    jsonSchema: input.jsonSchema,
    actor: input.actor,
    session,
    sessionVersion,
    capMicrousd: usdToMicrousd(input.request.budget.max_cost_usd),
    inputArtifactId: inputArtifact.artifactId,
  })
  if (!created.ok) return created
  // Bind the input to its run, so retention and ownership checks see it.
  await store.db.fusionArtifacts.update(inputArtifact.artifactId, { runId: created.value.runId })

  if (scopedKey) {
    await store.db.fusionIdempotency.put({
      scopedKey,
      requestHash,
      runId: created.value.runId,
      createdAt: now(),
      expiresAt: now() + IDEMPOTENCY_TTL_MS,
    })
  }
  deps.startRun(created.value.runId)

  const run = await store.getRun(created.value.runId)
  if (!run) {
    return {
      ok: false,
      error: error(503, "RUN_UNAVAILABLE", "the run was created but could not be read back"),
    }
  }
  return {
    ok: true,
    value: { accepted: await acceptedOf(store, run, input.actor, deps), replayed: false },
  }
}

/**
 * Accept a run: validate, resolve idempotency, bind a session, create the run
 * and start it. Answers with what `202 Accepted` carries.
 */
export async function createRunFromApi(
  deps: RunApiDeps,
  input: { actor: RunApiActor; body: unknown; idempotencyKey?: string }
): Promise<RunApiResult<RunCreated>> {
  const scopeError = requireScope(input.actor, "runs:create")
  if (scopeError) return { ok: false, error: scopeError }
  const parsed = parseRunRequest(input.body, deps.policy())
  if (!parsed.ok) return { ok: false, error: issuesToError(parsed.issues) }
  return acceptRun(deps, {
    actor: input.actor,
    request: parsed.value,
    messages: messagesOf(parsed.value),
    jsonSchema: null,
    body: input.body,
    endpoint: "POST /v1/runs",
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  })
}

async function contractSessionId(
  store: FusionLedgerStore,
  run: FusionRunRow,
  actor: RunApiActor,
  deps: RunApiDeps
): Promise<string> {
  // Every Run API run has a conversation; a run without one cannot reach here.
  if (!run.sessionId) return run.runId
  return apiSessionIdFor(store, run.sessionId, actor, deps)
}

async function acceptedOf(
  store: FusionLedgerStore,
  run: FusionRunRow,
  actor: RunApiActor,
  deps: RunApiDeps
): Promise<RunAccepted> {
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    run_id: run.runId,
    session_id: await contractSessionId(store, run, actor, deps),
    session_version: run.sessionVersion ?? 0,
    status: run.status,
    version: run.lastSeq,
    created_at: iso(run.createdAt),
  }
}

// ── reading runs ──────────────────────────────────────────────────────────────

/** The run, if this actor is the one that created it. */
export async function readRunForActor(
  store: FusionLedgerStore,
  runId: string,
  actor: RunApiActor
): Promise<FusionRunRow | null> {
  const run = await store.getRun(runId)
  if (!run) return null
  return run.actorKeyId === (actor.keyId ?? null) ? run : null
}

/**
 * A finished run's `RunResult`: the record the orchestrator sealed, with the
 * answer read back from its own artifact. Null when the run has no result, or
 * when the content window reaped it.
 */
export async function readRunResult(
  store: FusionLedgerStore,
  run: FusionRunRow
): Promise<{ result: RunResult | null; expired: boolean }> {
  if (!run.resultRecordArtifactId || !run.resultArtifactId) return { result: null, expired: false }
  const artifacts = store.artifactStore(run.runId)
  const [record, answer] = await Promise.all([
    artifacts.get(run.resultRecordArtifactId),
    artifacts.get(run.resultArtifactId),
  ])
  if (!record || !answer) return { result: null, expired: true }
  const sealed = JSON.parse(record.content) as Omit<RunResult, "answer">
  return { result: { ...sealed, answer: answer.content }, expired: false }
}

export function billingOf(run: FusionRunRow): BillingSummary {
  return {
    budget_cap_microusd: run.budget.capMicrousd,
    spent_microusd: run.budget.spentMicrousd,
    active_step_reservations_microusd: run.budget.activeReservationsMicrousd,
    tenant_hold_microusd: run.budget.tenantHoldMicrousd,
    status: run.costStatus,
    overspend_microusd: run.budget.overspendMicrousd,
    model_calls: run.budget.modelCalls,
  }
}

const DEFAULT_PHASE: Partial<Record<FusionRunRow["status"], string>> = {
  queued: "intake",
  succeeded: "finalize",
  failed: "finalize",
  cancelled: "finalize",
  expired: "finalize",
}

/** The contract's snapshot of a run. */
export async function snapshotOf(
  store: FusionLedgerStore,
  run: FusionRunRow,
  actor: RunApiActor,
  deps: RunApiDeps,
  extra: { decision: RouteDecision | null; result: RunResult | null }
): Promise<RunSnapshot> {
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    run_id: run.runId,
    session_id: await contractSessionId(store, run, actor, deps),
    session_version: run.sessionVersion ?? 0,
    status: run.status,
    phase: run.phase ?? DEFAULT_PHASE[run.status] ?? "execution",
    version: run.lastSeq,
    created_at: iso(run.createdAt),
    deadline_at: iso(run.deadlineAt),
    decision: extra.decision,
    result: extra.result,
    billing: billingOf(run),
    error: run.error
      ? {
          code: run.error.code,
          message: run.error.message,
          retryable: false,
          details: {},
          trace_id: run.runId,
        }
      : null,
    pending_approval_id: null,
    trace_id: run.runId,
  }
}

async function fullSnapshot(
  deps: RunApiDeps,
  store: FusionLedgerStore,
  run: FusionRunRow,
  actor: RunApiActor
): Promise<RunSnapshotRead> {
  const [summary, sealed] = await Promise.all([
    store.runSummary(run.runId),
    readRunResult(store, run),
  ])
  return {
    snapshot: await snapshotOf(store, run, actor, deps, {
      decision: summary?.decision ?? null,
      result: sealed.result,
    }),
    resultExpired: sealed.expired,
  }
}

export async function getRunFromApi(
  deps: RunApiDeps,
  input: { actor: RunApiActor; runId: string }
): Promise<RunApiResult<RunSnapshotRead>> {
  const scopeError = requireScope(input.actor, "runs:read")
  if (scopeError) return { ok: false, error: scopeError }
  const store = await deps.store()
  const run = await readRunForActor(store, input.runId, input.actor)
  if (!run) return { ok: false, error: NOT_FOUND }
  return { ok: true, value: await fullSnapshot(deps, store, run, input.actor) }
}

const CONTRACT_EVENT_TYPES: ReadonlySet<string> = new Set(RUN_EVENT_TYPES)

/**
 * One journal row as the contract's `RunEvent`. The journal also records what
 * the contract has no type for — a rejected candidate, a degraded run, a
 * verification request — and those travel as `phase.changed` with the original
 * type in the payload, so a strict client parses every event and loses nothing.
 */
export function contractEventOf(row: FusionRunEventRow): RunEvent {
  const known = CONTRACT_EVENT_TYPES.has(row.type)
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    run_id: row.runId,
    seq: row.seq,
    event_type: (known ? row.type : "phase.changed") as RunEventType,
    timestamp: iso(row.createdAt),
    payload: known ? row.payload : { ...row.payload, event: row.type },
  }
}

/**
 * Events after `afterSeq`, which is what the SSE stream replays from a
 * `Last-Event-ID`. A caller asking from beyond the run's own history is not an
 * error: it is simply caught up. A caller asking from a point whose events were
 * reaped is told so (`410 EVENT_HISTORY_EXPIRED`, SSE-04) and reads the
 * snapshot instead: replaying what is left would hide the gap.
 */
export async function listRunEventsFromApi(
  deps: RunApiDeps,
  input: { actor: RunApiActor; runId: string; afterSeq?: number; limit?: number }
): Promise<RunApiResult<RunEventsPage>> {
  const scopeError = requireScope(input.actor, "runs:read")
  if (scopeError) return { ok: false, error: scopeError }
  const store = await deps.store()
  const run = await readRunForActor(store, input.runId, input.actor)
  if (!run) return { ok: false, error: NOT_FOUND }
  const after = input.afterSeq ?? 0
  const events = await store.listEvents(input.runId, after)
  if (after < run.lastSeq && events[0]?.seq !== after + 1) {
    return {
      ok: false,
      error: error(
        410,
        "EVENT_HISTORY_EXPIRED",
        "this run's event history is no longer available; read the run snapshot instead",
        { lastSeq: run.lastSeq }
      ),
    }
  }
  const page = input.limit ? events.slice(0, input.limit) : events
  return {
    ok: true,
    value: {
      events: page.map(contractEventOf),
      lastSeq: run.lastSeq,
      // Terminal only once the caller has everything up to the terminal event.
      terminal: run.terminalAt !== null && (page.at(-1)?.seq ?? after) >= run.lastSeq,
    },
  }
}

// ── controlling runs ──────────────────────────────────────────────────────────

export async function cancelRunFromApi(
  deps: RunApiDeps,
  input: { actor: RunApiActor; runId: string }
): Promise<RunApiResult<RunSnapshot>> {
  const scopeError = requireScope(input.actor, "runs:cancel")
  if (scopeError) return { ok: false, error: scopeError }
  const store = await deps.store()
  const run = await readRunForActor(store, input.runId, input.actor)
  if (!run) return { ok: false, error: NOT_FOUND }
  // Cancelling a run that already ended is the caller getting what it asked for.
  const cancelled = (await store.cancelRun(input.runId)) ?? run
  return { ok: true, value: (await fullSnapshot(deps, store, cancelled, input.actor)).snapshot }
}

const RESUME_REFUSAL: Record<string, RunApiError> = {
  RUN_NOT_WAITING: error(409, "RUN_NOT_WAITING", "the run is not waiting for this"),
  RUN_VERSION_CONFLICT: error(409, "RUN_VERSION_CONFLICT", "the run moved on since you read it"),
  DEADLINE_EXCEEDED: error(409, "DEADLINE_EXCEEDED", "the run's deadline has passed"),
  RUN_NOT_FOUND: NOT_FOUND,
}

/**
 * `POST /v1/runs/{id}/resume` with the contract's `ResumeRequest`: more input
 * for a run waiting for input, or a decision for a run waiting for approval, at
 * the run version the caller saw.
 */
export async function resumeRunFromApi(
  deps: RunApiDeps,
  input: { actor: RunApiActor; runId: string; body: unknown }
): Promise<RunApiResult<RunSnapshot>> {
  const scopeError = requireScope(input.actor, "runs:approve")
  if (scopeError) return { ok: false, error: scopeError }
  const parsed = ResumeRequestSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      ok: false,
      error: error(422, "SCHEMA_INVALID", "the body must be a ResumeRequest", {
        paths: parsed.error.issues.map((issue) => issue.path.join(".")),
      }),
    }
  }
  const resume = parsed.data
  const store = await deps.store()
  const run = await readRunForActor(store, input.runId, input.actor)
  if (!run) return { ok: false, error: NOT_FOUND }
  if (resume.kind === "approval") {
    // Approvals belong to delegate work, which this build does not run: no run
    // here ever waits for one, so there is nothing a decision could release.
    return { ok: false, error: RESUME_REFUSAL.RUN_NOT_WAITING }
  }
  let inputArtifactId: string | undefined
  if (resume.input_messages) {
    const artifacts = store.artifactStore(run.runId)
    const previous = run.inputArtifactId ? await artifacts.get(run.inputArtifactId) : null
    const stored = decodeRunInput(previous?.content)
    const next = await artifacts.put(
      encodeRunInput({
        messages: [
          ...(stored?.messages ?? []),
          ...resume.input_messages.map((message) => ({
            role: "user" as const,
            content: message.content,
          })),
        ],
        allowDegraded: stored?.allowDegraded ?? false,
        jsonSchema: stored?.jsonSchema ?? null,
      }),
      "application/json",
      `runs/${run.runId}/input/${resume.expected_run_version}`
    )
    inputArtifactId = next.artifactId
  }
  const resumed = await store.resumeRun(input.runId, {
    kind: resume.kind,
    expectedVersion: resume.expected_run_version,
    ...(inputArtifactId ? { inputArtifactId } : {}),
  })
  if (!resumed.ok) return { ok: false, error: RESUME_REFUSAL[resumed.code] ?? NOT_FOUND }
  deps.startRun(input.runId)
  return { ok: true, value: (await fullSnapshot(deps, store, resumed.run, input.actor)).snapshot }
}

/** The stored verdict for each contract rating. The row predates the contract's spelling. */
const STORED_RATING = { positive: "up", negative: "down" } as const

/**
 * `POST /v1/runs/{id}/feedback` with the contract's `FeedbackRequest`
 * (`rating: positive | negative`, optional `comment`). Feedback is a record,
 * never a training label (DESIGN §15): nothing here changes a route.
 */
export async function submitFeedbackFromApi(
  deps: RunApiDeps,
  input: { actor: RunApiActor; runId: string; body: unknown }
): Promise<RunApiResult<{ accepted: true }>> {
  const scopeError = requireScope(input.actor, "feedback:write")
  if (scopeError) return { ok: false, error: scopeError }
  const parsed = FeedbackRequestSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      ok: false,
      error: error(422, "SCHEMA_INVALID", "the body must be a FeedbackRequest", {
        paths: parsed.error.issues.map((issue) => issue.path.join(".")),
      }),
    }
  }
  const feedback = parsed.data
  const store = await deps.store()
  const run = await readRunForActor(store, input.runId, input.actor)
  if (!run) return { ok: false, error: NOT_FOUND }
  const { now, newId } = clock(deps)
  // The comment is the caller's own words: it is content, so it lives where all
  // content lives — an encrypted artifact — and the row keeps only its id.
  const stored = feedback.comment
    ? await store
        .artifactStore(input.runId)
        .put(feedback.comment, "text/plain", `runs/${input.runId}/feedback`)
    : null
  await store.db.fusionFeedback.put({
    feedbackId: newId(),
    runId: input.runId,
    actorKeyId: input.actor.keyId,
    rating: STORED_RATING[feedback.rating],
    commentArtifactId: stored?.artifactId ?? null,
    createdAt: now(),
  })
  return { ok: true, value: { accepted: true } }
}

// ── conversations and artifacts ───────────────────────────────────────────────

/** `GET /v1/sessions/{id}`: the version to send back and the conversation so far. */
export async function getSessionFromApi(
  deps: RunApiDeps,
  input: { actor: RunApiActor; sessionId: string }
): Promise<RunApiResult<SessionSnapshot>> {
  const scopeError = requireScope(input.actor, "runs:read")
  if (scopeError) return { ok: false, error: scopeError }
  const store = await deps.store()
  const session = await sessionForActor(deps, store, input.sessionId, input.actor)
  if (!session) return { ok: false, error: SESSION_NOT_FOUND }
  const [lock, messages] = await Promise.all([
    store.db.fusionSessionLocks.get(session.id),
    deps.session.messages(session.id),
  ])
  return {
    ok: true,
    value: {
      session_id: input.sessionId,
      version: sessionVersionOf(session),
      active_run_id: lock?.runId ?? null,
      messages,
    },
  }
}

/**
 * The artifact, if it belongs to a run this actor created. Content-addressed
 * ids are bound to their run and namespace, so the same text in another key's
 * run is another artifact that this key cannot name (CACHE-05).
 */
async function artifactForActor(
  store: FusionLedgerStore,
  artifactId: string,
  actor: RunApiActor,
  now: number
): Promise<FusionArtifactRow | null> {
  const row = await store.db.fusionArtifacts.get(artifactId)
  if (!row?.runId || row.expiresAt <= now) return null
  return (await readRunForActor(store, row.runId, actor)) ? row : null
}

/** `GET /v1/artifacts/{id}`: what the artifact is, and a sixty-second link that reads it. */
export async function getArtifactFromApi(
  deps: RunApiDeps,
  input: { actor: RunApiActor; artifactId: string; baseUrl: string }
): Promise<RunApiResult<ArtifactMetadata>> {
  const scopeError = requireScope(input.actor, "artifacts:read")
  if (scopeError) return { ok: false, error: scopeError }
  const now = clock(deps).now()
  const store = await deps.store()
  const row = await artifactForActor(store, input.artifactId, input.actor, now)
  if (!row) return { ok: false, error: ARTIFACT_NOT_FOUND }
  const issued = await issueArtifactReadToken(row.artifactId, input.actor.keyId, now)
  const base = input.baseUrl.replace(/\/+$/, "")
  return {
    ok: true,
    value: {
      artifact_id: row.artifactId,
      content_sha256: row.contentSha256,
      media_type: row.mediaType,
      size_bytes: row.sizeBytes,
      read_url: `${base}/v1/artifacts/${encodeURIComponent(row.artifactId)}/content?token=${encodeURIComponent(issued.token)}`,
      expires_at: iso(issued.expiresAt),
    },
  }
}

export interface ArtifactContentResponse {
  content: string
  mediaType: string
  contentSha256: string
}

/**
 * `GET /v1/artifacts/{id}/content?token=`: the content, re-authorized on every
 * read (DESIGN §16) — the key must still own the run and the token must still
 * be the one issued to it.
 */
export async function readArtifactFromApi(
  deps: RunApiDeps,
  input: { actor: RunApiActor; artifactId: string; token: unknown }
): Promise<RunApiResult<ArtifactContentResponse>> {
  const scopeError = requireScope(input.actor, "artifacts:read")
  if (scopeError) return { ok: false, error: scopeError }
  const now = clock(deps).now()
  const store = await deps.store()
  const row = await artifactForActor(store, input.artifactId, input.actor, now)
  if (!row?.runId) return { ok: false, error: ARTIFACT_NOT_FOUND }
  const verdict = await verifyArtifactReadToken(input.token, row.artifactId, input.actor.keyId, now)
  if (verdict === "expired") {
    return {
      ok: false,
      error: error(410, "READ_TOKEN_EXPIRED", "this read link has expired; ask for a new one"),
    }
  }
  if (verdict === "invalid") {
    return {
      ok: false,
      error: error(
        403,
        "READ_TOKEN_INVALID",
        "this read link was not issued for this key and artifact"
      ),
    }
  }
  const stored = await store.artifactStore(row.runId).get(row.artifactId)
  if (!stored) return { ok: false, error: ARTIFACT_NOT_FOUND }
  return {
    ok: true,
    value: {
      content: stored.content,
      mediaType: stored.artifact.mediaType,
      contentSha256: stored.artifact.contentSha256,
    },
  }
}
