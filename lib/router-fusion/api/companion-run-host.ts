/**
 * The Run API, for a paired phone or browser (ADR-0188 D25, B2 companion RPC).
 *
 * A companion reaches the same brain path `/v1/runs` does — `run-api.ts` keeps
 * the promises (scopes, actor isolation, idempotency, session versions), and
 * `run-api-host.ts` routes and creates the run — with two differences, both
 * decided here:
 *
 *  - **The actor is the paired device, not a gateway key.** Rust stamps the
 *    authenticated `callerDeviceId` on every `execution_run_*` call
 *    (`CALLER_DEVICE_ID_COMMANDS`), and that device becomes the key the Run API
 *    reasons about: `device:<deviceId>`, named by the device's own pairing
 *    label. The `device:` prefix cannot collide with a gateway key id, so a
 *    device's runs are isolated from every key's and every other device's
 *    exactly as one key's are from another's (AUTH-03). The device reached this
 *    arm holding `agent.run` (the descriptor capability, checked by Rust before
 *    dispatch), which is the Control grant; the Run API scopes that grant
 *    stands for are all of them.
 *  - **The run belongs to the `companion` surface** (`lane: "companion"`), so
 *    the live checks before each reservation, the boot sweep and the retention
 *    pass read the companion switch.
 *
 * A companion does not send a contract `RunRequest`: it names a mode and a
 * message, and this host builds the request from ITS OWN settings (run cap,
 * budget mode), because the host's settings are authoritative for runs it
 * executes (D36) and a phone does not hold them (`routerFusion` never syncs).
 * The message is the person's own text on their own device, so it — and the
 * conversation it continues — pass the same PII gate a chat send does before
 * anything is stored or reserved.
 *
 * **A follow-up carries its conversation.** A run bound to an existing
 * conversation is a follow-up ("summarise what we just decided"), so this host
 * reads that conversation's recent turns and puts them in front of the new
 * message. The turns come from the host's own transcript, never from the
 * device: the phone's payload contributes the mode and one message and nothing
 * else, so a device cannot put words in the conversation's mouth. Such a run
 * writes `answer-only` (the person's message is appended here, once, with the
 * id the transcript would have given it), because a run whose input carries
 * the history would otherwise append the whole conversation again. A run that
 * opens a NEW conversation has no history and keeps the Run API's own
 * behaviour: it appends its one message and its answer.
 *
 * Loaded only through `gate/companion-bridge.ts`, after the companion gate said
 * `on`, by a dynamic import.
 */

import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import {
  CONTRACT_SCHEMA_VERSION,
  estimateTokens,
  microusdToUsd,
  parseRunRequest,
  usdToMicrousd,
  type Message,
  type RunRequest,
} from "@cognia/router-fusion"
import { normalizeRouterFusionSettings } from "@cognia/router-fusion/settings/settings"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { commitMessageDelta } from "@/lib/db/messages"
import { getPairedDevice } from "@/lib/db/paired-devices"

import { inputMessageId } from "../db/session-transcript"

import {
  acceptRun,
  cancelRunFromApi,
  getRunFromApi,
  issuesToError,
  listRunEventsFromApi,
  readRunForActor,
  resumeRunFromApi,
  RUN_API_SCOPES,
  type RunApiActor,
  type RunApiDeps,
  type RunApiError,
  type RunApiResult,
  type RunCreated,
  type RunEventsPage,
  type RunSnapshotRead,
} from "./run-api"
import { runApiDeps, type RunTranscriptMode } from "./run-api-host"

/** The modes a companion may ask for explicitly: fusion work, never a direct turn. */
export const COMPANION_RUN_MODES = ["cascade", "panel"] as const
export type CompanionRunMode = (typeof COMPANION_RUN_MODES)[number]

export function isCompanionRunMode(value: unknown): value is CompanionRunMode {
  return value === "cascade" || value === "panel"
}

/** The idempotency endpoint a companion create is scoped by; distinct from `POST /v1/runs`. */
export const COMPANION_RUN_ENDPOINT = "companion execution_run_create"

/** A companion's message; the Run API bounds one input message at this length. */
export const COMPANION_RUN_MAX_TEXT = 500_000

const DEVICE_KEY_PREFIX = "device:"

/** The Run API key id a paired device acts under. */
export function companionKeyId(deviceId: string): string {
  return `${DEVICE_KEY_PREFIX}${deviceId}`
}

function error(
  status: RunApiError["status"],
  code: string,
  message: string,
  details?: Record<string, unknown>
): RunApiError {
  return { status, code, message, ...(details ? { details } : {}) }
}

const SESSION_NOT_FOUND = error(404, "SESSION_NOT_FOUND", "no such session")

export interface CompanionHostDeps {
  /**
   * The Run API wiring for one transcript mode;
   * `runApiDeps(settings, { lane: "companion", transcript })` when omitted.
   */
  apiDeps?: (transcript: RunTranscriptMode) => RunApiDeps
  /** The paired device's pairing label, when this host knows the device. */
  deviceLabel?: (deviceId: string) => Promise<string | undefined>
}

async function pairingLabel(deviceId: string): Promise<string | undefined> {
  const row = await getPairedDevice(deviceId)
  return row?.label?.trim() || undefined
}

/**
 * The actor a paired device calls as. Named by its pairing label so the
 * session it opens and the cockpit can say which device asked; the id alone
 * when this host has no row for it (a headless host keeps its devices in the
 * security store, not in this database).
 */
export async function companionActor(
  deviceId: string,
  deps: Pick<CompanionHostDeps, "deviceLabel"> = {}
): Promise<RunApiActor> {
  const label = await (deps.deviceLabel ?? pairingLabel)(deviceId).catch(() => undefined)
  return {
    keyId: companionKeyId(deviceId),
    keyName: label ?? companionKeyId(deviceId),
    scopes: [...RUN_API_SCOPES],
  }
}

function apiDepsOf(
  appSettings: AppSettings | null | undefined,
  deps: CompanionHostDeps,
  transcript: RunTranscriptMode = "input-and-answer"
): RunApiDeps {
  return deps.apiDeps
    ? deps.apiDeps(transcript)
    : runApiDeps(appSettings, { lane: "companion", transcript })
}

/**
 * How much of a conversation a follow-up carries, and how it is cut.
 *
 * A budget rather than a message count, because two turns of pasted output and
 * twenty short ones are not the same amount of context; and the newest turns
 * are kept, because a follow-up is about what was just said. A message is kept
 * whole or dropped whole — a half-quoted turn reads as a different statement —
 * and the cut is deterministic, so the same conversation always yields the same
 * context (and the same idempotent run).
 */
export const COMPANION_CONTEXT_TOKEN_BUDGET = 4_000
/** However short the turns are, a follow-up never carries more of them than this. */
export const COMPANION_CONTEXT_MAX_TURNS = 20

export function trimCompanionContext(
  messages: readonly Message[],
  budgetTokens: number = COMPANION_CONTEXT_TOKEN_BUDGET,
  maxTurns: number = COMPANION_CONTEXT_MAX_TURNS
): Message[] {
  const kept: Message[] = []
  let tokens = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (kept.length >= maxTurns) break
    const cost = estimateTokens(message.content)
    // The newest turn is kept even when it alone exceeds the budget: dropping
    // it would answer a follow-up with everything except what it follows.
    if (tokens + cost > budgetTokens && kept.length > 0) break
    kept.push(message)
    tokens += cost
  }
  return kept.reverse()
}

/**
 * The contract request this host builds for a companion's message. The run
 * cap is the host's own cap for the mode — a phone asks for the mode, never
 * for the money — and the budget mode is the account's.
 */
export function companionRunRequest(
  appSettings: AppSettings | null | undefined,
  mode: CompanionRunMode,
  text: string
): RunRequest {
  const settings = normalizeRouterFusionSettings(appSettings?.routerFusion)
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    input_messages: [{ role: "user", content: text }],
    mode,
    allowed_modes: [mode],
    profile: "balanced",
    budget: {
      max_cost_usd: microusdToUsd(usdToMicrousd(settings.runCapUsdByMode[mode])),
      mode: settings.budgetMode,
    },
    // The action's own deadline bounds the run; the request lowers nothing.
    deadline_ms: 3_600_000,
    // A degraded panel answer is labelled on the run view, as it is on the
    // desktop's run card; one surviving candidate beats no answer.
    allow_degraded: true,
    delivery: "verified_buffered",
  }
}

/**
 * The conversation a companion run writes into, when the companion names one:
 * the session the person is looking at on the phone. Another gateway key's or
 * another device's conversation is reported as missing, the same answer a
 * stranger's id gets.
 */
async function targetSession(
  apiDeps: RunApiDeps,
  sessionId: string,
  actor: RunApiActor
): Promise<ChatSession | null> {
  const session = await apiDeps.session.get(sessionId)
  if (!session) return null
  if (session.origin && session.origin.keyId !== actor.keyId) return null
  return session
}

export interface CreateCompanionRunInput {
  actor: RunApiActor
  mode: CompanionRunMode
  text: string
  /** The app session to continue; a new conversation for the device when absent. */
  sessionId?: string | null
  idempotencyKey?: string
}

/**
 * Create a companion run: build the request from this host's settings, bind
 * the conversation, store the input and start the run. Idempotent on the
 * device's key: the same key and message replay the same run, a different
 * message under the same key is a conflict (API-02).
 */
export async function createCompanionRun(
  appSettings: AppSettings | null | undefined,
  input: CreateCompanionRunInput,
  deps: CompanionHostDeps = {}
): Promise<RunApiResult<RunCreated>> {
  const text = input.text.trim()
  if (text.length === 0 || text.length > COMPANION_RUN_MAX_TEXT) {
    return {
      ok: false,
      error: error(422, "SCHEMA_INVALID", "the message must be between 1 and 500000 characters", {
        paths: ["text"],
      }),
    }
  }
  const message: Message = { role: "user", content: text }
  // A follow-up continues a conversation: the run is created with that
  // conversation behind it, and writes only its answer into it.
  const continuing = Boolean(input.sessionId)
  const apiDeps = apiDepsOf(appSettings, deps, continuing ? "answer-only" : "input-and-answer")
  let runDeps = apiDeps
  let session: ChatSession | null = null
  let context: Message[] = []
  if (input.sessionId) {
    session = await targetSession(apiDeps, input.sessionId, input.actor)
    if (!session) return { ok: false, error: SESSION_NOT_FOUND }
    // The transcript is read HERE, from the host's own store. The device sends
    // one message and a mode; it can neither add to this history nor replace
    // it, which is what keeps a phone from inventing what "we" agreed earlier.
    context = trimCompanionContext(await apiDeps.session.messages(session.id))
    // The Run API opens a conversation for a request that names none; a
    // companion names the one it is showing, so "opening" it is that session.
    const target = session
    runDeps = { ...apiDeps, session: { ...apiDeps.session, open: async () => target } }
  }
  // The person's own words, and the conversation they continue, leave this
  // host for the models the router picks: the gate a chat send passes applies
  // (`lib/claude/ipc.ts`), over the transcript as well as the new message.
  if (!hasNoLeakingPiiDeep([...context, message])) {
    return {
      ok: false,
      error: error(422, "PII_BLOCKED", "the message carries personal data that may not leave"),
    }
  }
  const request = companionRunRequest(appSettings, input.mode, text)
  // The policy is asked per request now that delegate's workspace rules are
  // real (WP-D4); a companion request names no workspace, so this costs
  // nothing beyond the await.
  const parsed = parseRunRequest(request, await apiDeps.policy())
  if (!parsed.ok) return { ok: false, error: issuesToError(parsed.issues) }
  const accepted = await acceptRun(runDeps, {
    actor: input.actor,
    request: parsed.value,
    // The contract request names the one message the person sent; the run's
    // stored input is what the workflow reads, and a follow-up reads the turns
    // before it too.
    messages: [...context, message],
    jsonSchema: null,
    // What the device sent, which is what the idempotency hash must cover. The
    // history is deliberately absent: a conversation that moved on must not
    // turn a replayed key into a different request.
    body: { mode: input.mode, text, sessionId: input.sessionId ?? null },
    endpoint: COMPANION_RUN_ENDPOINT,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  })
  if (accepted.ok && session) {
    await appendCompanionMessage(
      session.id,
      accepted.value.accepted.run_id,
      context.length,
      message,
      input.actor
    )
  }
  return accepted
}

/**
 * The person's message in the conversation, written once by the surface that
 * took it — the same row, with the same derived id, the transcript applier
 * would have written for a run that appends its own input. Derived from the
 * run id, so a replayed create upserts the row it already wrote instead of a
 * second copy.
 *
 * A failure here is logged, not raised: the run exists and will answer, and
 * the device shows the message it sent in its own run view either way.
 */
async function appendCompanionMessage(
  sessionId: string,
  runId: string,
  index: number,
  message: Message,
  actor: RunApiActor
): Promise<void> {
  try {
    await commitMessageDelta(sessionId, {
      upserts: [
        {
          id: inputMessageId(runId, index),
          role: message.role,
          parts: [{ type: "text", text: message.content }],
          metadata: {
            // A paired device asked for this run; the app's own "on new
            // message" workflows are not its to trigger, as for a gateway key.
            triggerWorkflows: false,
            routerFusion: {
              runId,
              origin: "gateway-api",
              ...(actor.keyName ? { keyName: actor.keyName } : {}),
            },
          },
        },
      ] as never,
    })
  } catch (error) {
    console.warn("[router-fusion] a companion run's message could not be appended", error)
  }
}

export function getCompanionRun(
  appSettings: AppSettings | null | undefined,
  input: { actor: RunApiActor; runId: string },
  deps: CompanionHostDeps = {}
): Promise<RunApiResult<RunSnapshotRead>> {
  return getRunFromApi(apiDepsOf(appSettings, deps), input)
}

/** One page of the run's events after `afterSeq` (REC-07: a gap is a 410, never skipped). */
export function listCompanionRunEvents(
  appSettings: AppSettings | null | undefined,
  input: { actor: RunApiActor; runId: string; afterSeq: number; limit?: number },
  deps: CompanionHostDeps = {}
): Promise<RunApiResult<RunEventsPage>> {
  return listRunEventsFromApi(apiDepsOf(appSettings, deps), input)
}

/** `ResumeRequest` from the device: more input, or a decision, at the version it saw. */
export function resumeCompanionRun(
  appSettings: AppSettings | null | undefined,
  input: { actor: RunApiActor; runId: string; body: unknown },
  deps: CompanionHostDeps = {}
): Promise<RunApiResult<import("@cognia/router-fusion").RunSnapshot>> {
  return resumeRunFromApi(apiDepsOf(appSettings, deps), input)
}

/**
 * What `execution_run_control` answers for a companion run: the cockpit's
 * `RunControlResult` shape, so the device's control code reads one answer for
 * every run kind.
 */
export interface CompanionRunControlResult {
  accepted: boolean
  reason?: "run_not_found" | "unsupported_for_kind" | "source_rejected" | "revision_conflict"
  currentRevision?: number
  /** The Run API's own refusal, when it refused. */
  code?: string
}

export interface CompanionRunControlCommand {
  runId: string
  action: string
  expectedRevision: number
  interruptId?: string
}

/**
 * Whether a run id names a companion run on this host. `execution_run_control`
 * asks this first: a companion run has no execution-run projection, so the
 * cockpit's control plane would not find it.
 */
export async function isCompanionRun(
  appSettings: AppSettings | null | undefined,
  runId: string,
  deps: CompanionHostDeps = {}
): Promise<boolean> {
  if (!runId) return false
  const store = await apiDepsOf(appSettings, deps).store()
  const run = await store.getRun(runId)
  return run?.surface === "companion"
}

/**
 * Cancel and approve reuse `execution_run_control` (ADR-0169's one control
 * seam). For a companion run they go through the Run API, so the device that
 * created the run is the only one that can steer it:
 *
 *  - `stop` cancels. A stop is never refused for a stale revision: the run's
 *    version moves with every event, and stopping is what the person wants
 *    whatever happened since they looked.
 *  - `approve` / `deny` are a `ResumeRequest` of kind `approval` bound to the
 *    version the device saw and the interrupt it answered.
 *  - `open_details` is a no-op, as for every other kind.
 */
export async function controlCompanionRun(
  appSettings: AppSettings | null | undefined,
  input: { actor: RunApiActor; command: CompanionRunControlCommand },
  deps: CompanionHostDeps = {}
): Promise<CompanionRunControlResult> {
  const apiDeps = apiDepsOf(appSettings, deps)
  const { command, actor } = input
  const store = await apiDeps.store()
  const owned = await readRunForActor(store, command.runId, actor)
  if (!owned) return { accepted: false, reason: "run_not_found" }
  switch (command.action) {
    case "open_details":
      return { accepted: true, currentRevision: owned.lastSeq }
    case "stop": {
      const cancelled = await cancelRunFromApi(apiDeps, { actor, runId: command.runId })
      return cancelled.ok
        ? { accepted: true, currentRevision: cancelled.value.version }
        : { accepted: false, reason: "source_rejected", code: cancelled.error.code }
    }
    case "approve":
    case "deny": {
      const resumed = await resumeRunFromApi(apiDeps, {
        actor,
        runId: command.runId,
        body: {
          kind: "approval",
          expected_run_version: command.expectedRevision,
          ...(command.interruptId ? { approval_id: command.interruptId } : {}),
          decision: command.action === "approve" ? "approve" : "reject",
        },
      })
      if (resumed.ok) return { accepted: true, currentRevision: resumed.value.version }
      return {
        accepted: false,
        reason:
          resumed.error.code === "RUN_VERSION_CONFLICT" ? "revision_conflict" : "source_rejected",
        code: resumed.error.code,
        currentRevision: owned.lastSeq,
      }
    }
    default:
      // Pause, resume, retry and steer have no meaning for a fusion run: there
      // is no coordinator to pause and a retry is a new run with its own key.
      return { accepted: false, reason: "unsupported_for_kind", currentRevision: owned.lastSeq }
  }
}
