/**
 * The Host side of the Browser Companion.
 *
 * Four commands, one of which does anything: `browser_context_submit` turns a
 * page the user explicitly captured into a new Cognia task. The other three
 * describe the Host and read back what this device has already submitted.
 *
 * ## Why this creates the session itself and then enqueues one message
 *
 * The obvious route — hand the whole thing to HostState as a `session.create`
 * plus a `message.enqueue` — is wrong twice over. `session.create` maps to the
 * `process.spawn` capability, the Agent Control grant, which a browser must
 * never hold; and its Dexie projection writes a bare row with no workspace, no
 * execution context and no `SESSION_CREATED` event, so the conversation would
 * exist without belonging anywhere. `startNewSession()` is the 219 lines that
 * make a session real, and there is no reason to reimplement a thinner version
 * of it here.
 *
 * The message half does go through HostState, because
 * `createAgentRpcHostStateDispatcher` is the only non-React path from "a
 * message exists" to "a turn is running": it accepts into the WorkSubmission
 * ledger, claims a dispatch lease, resolves send options, and calls
 * `sendPrompt` — which is where the PII gate lives. Rebuilding that chain for
 * one caller would mean rebuilding its recovery semantics too.
 *
 * ## The authority argument, stated plainly
 *
 * `message.enqueue` requires `workspace.write`, and a browser device does not
 * have it. This module submits that action on the **Host's** authority, not the
 * device's. That is not a bypass, and the reason is structural rather than a
 * promise: the action is built here from validated inputs, for a session this
 * module just created, with a fixed intent kind. The caller supplies an
 * instruction and a captured page; it cannot name a session, cannot choose an
 * intent, and cannot submit a batch. `browser.submit` is the capability for
 * exactly this one closed effect, in the same way `agent.worker` is the
 * capability for exactly one device class.
 */
import type {
  BrowserCompanionCapabilityV1,
  BrowserContextResultV1,
  BrowserDeliveryTargetV1,
  BrowserContextSubmissionStatusV1,
  BrowserContextSubmissionSummaryPageV1,
  BrowserContextSubmitRequestV1,
  BrowserContextSubmitResponseV1,
  BrowserSubmissionStatus,
} from "@/types/browser-companion"
import {
  BROWSER_CAPTURE_MODES,
  BROWSER_CONTEXT_LIMITS,
  BROWSER_RESULT_TEXT_BYTES,
} from "@/types/browser-companion"
import { utf8ByteLength } from "@cognia/companion-client"
import type { BrowserSubmissionRow } from "@/lib/db/browser-submissions-types"

import { sha256Hex } from "@/lib/share/hash"

import { buildBrowserContextPrompt, sourceHostOf } from "./build-prompt"
import { NEW_CHAT_TARGET_ID, resolveDeliveryTarget, sessionIdOfTarget } from "./targets"
import { validateBrowserSubmission, type BrowserSubmissionRejection } from "./limits"

/** A refusal the side panel can act on, rather than an English sentence. */
export class BrowserCompanionError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "BrowserCompanionError"
  }
}

/**
 * Everything this module touches outside itself.
 *
 * Injected rather than imported so the whole submit path can be exercised
 * without a Dexie database, a runtime target or a live agent — and so the
 * pieces it borrows (session creation, HostState) stay visible in one list
 * instead of being scattered through the body.
 */
export interface BrowserCompanionDeps {
  now: () => number
  /** The workspaces a submission may be aimed at, default first. */
  listWorkspaces: () => Promise<{ id: string; label: string; isDefault: boolean }[]>
  /** What this device may aim a submission at, default first. */
  listDeliveryTargets: (deviceId: string) => Promise<BrowserDeliveryTargetV1[]>
  /**
   * The Host's resolved appearance for the side panel.
   *
   * Async because the only source that answers on every host is the database.
   * A synchronous reader can only see in-memory state, and the one this used to
   * read is hydrated by a React provider — which the headless brain does not
   * have, so it answered the stock preset there forever.
   *
   * `preferredMode` is the panel's own light/dark override, or the mode it
   * resolved from `prefers-color-scheme` when the Host follows the system. It
   * is resolved HERE rather than applied in the panel: the panel can toggle a
   * class, but the custom properties it would be toggling over are a palette
   * only the Host can build, so a locally-flipped class would paint a light
   * layout in dark colours.
   */
  appearance: (preferredMode?: "light" | "dark") => Promise<{
    appearance: BrowserCompanionCapabilityV1["appearance"]
    followsSystem: boolean
  }>
  /** `startNewSession`, narrowed to what this module needs. */
  createSession: (input: { title: string; projectId: string }) => Promise<{ id: string }>
  /** Enqueue one message on a session and start its turn. */
  enqueueMessage: (input: { sessionId: string; messageId: string; text: string }) => Promise<void>
  /** Persist the side-note row. */
  recordSubmission: (row: BrowserSubmissionRow) => Promise<void>
  /** Read one side-note row back. */
  readSubmission: (submissionId: string) => Promise<BrowserSubmissionRow | undefined>
  /** This device's submissions, newest first. */
  listSubmissions: (deviceId: string, limit: number) => Promise<BrowserSubmissionRow[]>
  /**
   * The live status of the session a submission created, or `null` when that
   * session has no run at all — which is what an enqueue that never happened
   * looks like from here.
   */
  sessionStatus: (sessionId: string) => Promise<BrowserSubmissionStatus | null>
  /**
   * A digest of what {@link browserCompanionCapability} would answer right now.
   *
   * Carried on the list because that is the call the panel already makes on a
   * timer. Without it, a Host whose theme, workspaces or delivery targets
   * changed had no way to tell an open panel, and the panel had no cheap way to
   * ask — it read the capability once, on connect.
   */
  capabilityRevision: (deviceId: string) => Promise<string>
  /**
   * The last thing the assistant said in a session, or `null` while it has not
   * said anything yet.
   *
   * The last message rather than the transcript: the panel is a side panel, and
   * the conversation is what the deep link is for.
   */
  latestAnswer: (sessionId: string) => Promise<{ text: string; at: number } | null>
  /**
   * Stop the turn running on a session.
   *
   * Returns `false` when the Host refuses because somebody else is driving that
   * session right now — a distinct outcome from an error, and the panel says so
   * rather than reporting a failure the user cannot act on from a browser.
   */
  abortTurn: (sessionId: string) => Promise<boolean>
}

/** `cognia://session/<id>` — the link that opens the task on the desktop. */
export function browserSubmissionDeepLink(sessionId: string): string {
  return `cognia://session/${encodeURIComponent(sessionId)}`
}

export async function browserCompanionCapability(
  deps: BrowserCompanionDeps,
  deviceId: string,
  payload: { preferredMode?: unknown } = {}
): Promise<BrowserCompanionCapabilityV1> {
  // Narrowed rather than cast. The RPC schema already refuses anything else,
  // but this module is also the one a test or an in-process caller reaches
  // directly, and an unrecognised value must mean "no preference" rather than
  // reaching `resolveAppPalette` as a mode it does not know.
  const preferredMode =
    payload.preferredMode === "light" || payload.preferredMode === "dark"
      ? payload.preferredMode
      : undefined
  const { appearance, followsSystem } = await deps.appearance(preferredMode)
  return {
    schemaVersion: 1,
    limits: BROWSER_CONTEXT_LIMITS,
    supportedCaptureModes: [...BROWSER_CAPTURE_MODES],
    workspaces: await deps.listWorkspaces(),
    appearance,
    followsSystem,
    // Device-scoped like every other read: the targets beyond "new task" are
    // this browser's own past submissions, so an unbound caller is offered the
    // one target that names nothing.
    deliveryTargets: await deps.listDeliveryTargets(deviceId),
  }
}

export async function submitBrowserContext(
  deps: BrowserCompanionDeps,
  deviceId: string,
  payload: unknown
): Promise<BrowserContextSubmitResponseV1> {
  if (!deviceId) throw new BrowserCompanionError("caller_unbound", "the caller device is unknown")
  const validation = validateBrowserSubmission(payload)
  if (!validation.ok) throw rejectionError(validation.rejection)
  const request = validation.request

  // Replay before anything else. The RPC layer already replays the receipt for
  // a repeated Idempotency-Key, so reaching here twice means the ledger was
  // cleared or the key was reused across restarts — either way, a second
  // session for one user action is the failure this exists to prevent.
  const urlFingerprint = await sha256Hex(request.context.url)
  const existing = await deps.readSubmission(request.submissionId)
  if (existing) {
    if (existing.deviceId !== deviceId) {
      throw new BrowserCompanionError(
        "submission_owned_elsewhere",
        "this submission id belongs to another device"
      )
    }
    let status = existing.status
    if (REDRIVABLE_STATUSES.includes(existing.status)) {
      const { prompt, derivedTitle } = buildBrowserContextPrompt(
        request.context,
        request.instruction,
        request.suggestedTitle
      )
      // The submission id is the caller's, so "the row is still mid-flight"
      // does not on its own make this the same capture. Redriving a *different*
      // page onto the session the first one created would put page B in a
      // transcript whose session title, deep link and side-note row all still
      // describe page A — and nothing downstream could ever tell they had
      // diverged. Same id, different capture is a client bug, not a retry.
      if (!describesSameCapture(existing, request, derivedTitle, urlFingerprint)) {
        throw new BrowserCompanionError(
          "submission_payload_mismatch",
          "this submission id was already accepted for a different capture"
        )
      }
      status = await enqueueAndSettle(deps, existing, {
        messageId: `browser-${request.submissionId}`,
        text: prompt,
      })
    }
    return {
      submissionId: existing.submissionId,
      sessionId: existing.sessionId,
      acceptedAt: existing.submittedAt,
      status,
      deepLink: browserSubmissionDeepLink(existing.sessionId),
    }
  }

  const workspaces = await deps.listWorkspaces()
  // The workspace must be one the Host offered. Accepting an arbitrary id
  // would let a submission land in a project the user never chose — and the
  // panel's dropdown is populated from exactly this list, so a mismatch means
  // stale state, not a new capability.
  if (!workspaces.some((workspace) => workspace.id === request.workspaceId)) {
    throw new BrowserCompanionError(
      "unknown_workspace",
      "the chosen workspace is not available on this Host"
    )
  }

  // Same rule, one level up. The target is looked up in a catalogue this
  // process just built, never parsed out of the request: a lookup can only
  // return something the Host offered, while a parse would let a browser name
  // any session on this machine by writing its id down.
  const target = resolveDeliveryTarget(await deps.listDeliveryTargets(deviceId), request.targetId)
  if (!target) {
    throw new BrowserCompanionError(
      "unknown_target",
      "the chosen delivery target is not available on this Host, or not in this workspace"
    )
  }
  if (target.workspaceId && target.workspaceId !== request.workspaceId) {
    // The panel filters targets by workspace, so the pair can only disagree
    // when the panel is showing a stale catalogue. Honouring it would append to
    // a conversation in a workspace the user did not pick, which is a move the
    // submission does not perform and cannot undo.
    throw new BrowserCompanionError(
      "unknown_target",
      "the chosen delivery target belongs to a different workspace"
    )
  }

  const { prompt, derivedTitle } = buildBrowserContextPrompt(
    request.context,
    request.instruction,
    request.suggestedTitle
  )
  // An append reuses the conversation the target names; only a new task creates
  // one. Deciding it here rather than inside `createSession` keeps the two
  // effects visible side by side, which is the difference the capability
  // argument turns on.
  const appendTo = sessionIdOfTarget(target)
  const session = appendTo
    ? { id: appendTo }
    : await deps.createSession({ title: derivedTitle, projectId: request.workspaceId })

  const now = deps.now()
  // Persist the recoverable intent first, then settle the status only after
  // HostState has answered. A retry can redrive any row still in
  // `REDRIVABLE_STATUSES` without creating another session or transcript item.
  const submission: BrowserSubmissionRow = {
    submissionId: request.submissionId,
    deviceId,
    sessionId: session.id,
    // The append keeps the conversation's own title. Overwriting it with the
    // page just captured would rename a task from under whoever is reading it.
    title: appendTo ? target.label : derivedTitle,
    sourceHost: sourceHostOf(request.context.url),
    urlFingerprint,
    workspaceId: request.workspaceId,
    targetId: target.id,
    captureMode: request.context.captureMode,
    contentBytes: capturedContentBytes(request),
    truncated: capturedTruncated(request),
    status: "submitting",
    submittedAt: now,
    updatedAt: now,
  }
  await deps.recordSubmission(submission)

  const status = await enqueueAndSettle(deps, submission, {
    // Derived from the submission id rather than random: a retry that gets
    // past the ledger must still resolve to the same message, or the same
    // capture arrives twice in one transcript.
    messageId: `browser-${request.submissionId}`,
    text: prompt,
  })

  return {
    submissionId: request.submissionId,
    sessionId: session.id,
    acceptedAt: now,
    status,
    deepLink: browserSubmissionDeepLink(session.id),
  }
}

/**
 * Row states a redrive may act on.
 *
 * All three mean the same thing: the enqueue is known not to have landed, so
 * re-running it cannot duplicate anything. `submitting` is a submission
 * interrupted between writing the row and enqueueing; the other two are
 * recorded refusals, and a panel offering "try again" on them lands right here
 * with the same submission id. A row past this set has a message in a
 * transcript and must not be driven twice.
 */
const REDRIVABLE_STATUSES: readonly BrowserSubmissionStatus[] = [
  "submitting",
  "host_unavailable",
  "failed",
]

/**
 * Enqueue the message, then write down what actually happened.
 *
 * Three outcomes, and only one of them is an exception:
 *
 * - **Accepted** → the row moves to `queued` and any `errorCode` from an
 *   earlier attempt is dropped, because it no longer describes anything.
 * - **No runtime** → `host_unavailable`, RETURNED rather than thrown. The
 *   contract calls it "a real state, not an error", and it is one: the session
 *   exists, the capture is recorded, and the row stays inside
 *   {@link REDRIVABLE_STATUSES} so a retry finishes the job instead of opening
 *   a second session. Reporting it as a failure would tell the user to
 *   resubmit something that is one runtime away from running.
 * - **Refused** → `failed` with the refusal's code, and the error is rethrown.
 *   The Host said no to this specific message; the panel needs to see that,
 *   and the row needs to remember why. This is the only writer of `errorCode`.
 */
async function enqueueAndSettle(
  deps: BrowserCompanionDeps,
  row: BrowserSubmissionRow,
  message: { messageId: string; text: string }
): Promise<BrowserSubmissionStatus> {
  try {
    await deps.enqueueMessage({ sessionId: row.sessionId, ...message })
  } catch (error) {
    const code = error instanceof BrowserCompanionError ? error.code : "enqueue_failed"
    const status: BrowserSubmissionStatus =
      code === "runtime_target_unavailable" ? "host_unavailable" : "failed"
    await deps.recordSubmission({
      ...row,
      status,
      errorCode: code,
      updatedAt: deps.now(),
    })
    if (status === "host_unavailable") return status
    throw error
  }
  // Spread first so `errorCode` is genuinely removed rather than set to
  // undefined — a row put back with `errorCode: undefined` still carries the
  // key, and `getBrowserContextSubmission` spreads it back onto the response.
  const { errorCode: _cleared, ...settled } = row
  await deps.recordSubmission({ ...settled, status: "queued", updatedAt: deps.now() })
  return "queued"
}

export async function listBrowserContextSubmissions(
  deps: BrowserCompanionDeps,
  deviceId: string,
  payload: { limit?: number } = {}
): Promise<BrowserContextSubmissionSummaryPageV1> {
  if (!deviceId) throw new BrowserCompanionError("caller_unbound", "the caller device is unknown")
  const limit = Math.min(50, Math.max(1, Math.trunc(payload.limit ?? 20)))
  const rows = await deps.listSubmissions(deviceId, limit)
  const capabilityRevision = await deps.capabilityRevision(deviceId)
  const items = await Promise.all(
    rows.map(async (row) => ({
      submissionId: row.submissionId,
      sessionId: row.sessionId,
      title: row.title,
      sourceHost: row.sourceHost,
      captureMode: row.captureMode,
      status: await currentStatus(deps, row),
      submittedAt: row.submittedAt,
      updatedAt: row.updatedAt,
      deepLink: browserSubmissionDeepLink(row.sessionId),
    }))
  )
  return { items, capabilityRevision }
}

export async function getBrowserContextSubmission(
  deps: BrowserCompanionDeps,
  deviceId: string,
  payload: { submissionId?: unknown }
): Promise<BrowserContextSubmissionStatusV1> {
  if (!deviceId) throw new BrowserCompanionError("caller_unbound", "the caller device is unknown")
  const submissionId = payload.submissionId
  if (typeof submissionId !== "string" || !submissionId) {
    throw new BrowserCompanionError("malformed", "submissionId is required")
  }
  const row = await deps.readSubmission(submissionId)
  // Same answer for "never existed" and "belongs to another device". Telling
  // the two apart would let one browser probe another's submission ids.
  if (!row || row.deviceId !== deviceId) {
    throw new BrowserCompanionError("submission_not_found", "no such submission for this device")
  }
  return {
    submissionId: row.submissionId,
    sessionId: row.sessionId,
    status: await currentStatus(deps, row),
    updatedAt: row.updatedAt,
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    deepLink: browserSubmissionDeepLink(row.sessionId),
  }
}

/**
 * What a task answered, for a submission this device owns.
 *
 * The status half is `getBrowserContextSubmission`'s, because a result *is* a
 * status with the answer attached: a running task has one and not the other,
 * and splitting them would make the panel ask twice for one row.
 *
 * The text is capped in UTF-8 bytes rather than characters, for the same reason
 * every other limit in this contract is: a CJK answer hits a byte ceiling at
 * roughly a third of the character count, so a character cap silently means
 * something different per language. `truncated` is carried explicitly because
 * "the task said this" and "the task said this much of it" are different
 * claims.
 */
export async function getBrowserContextResult(
  deps: BrowserCompanionDeps,
  deviceId: string,
  payload: { submissionId?: unknown }
): Promise<BrowserContextResultV1> {
  const status = await getBrowserContextSubmission(deps, deviceId, payload)
  const answer = await deps.latestAnswer(status.sessionId)
  if (!answer) return status
  const clipped = clipToBytes(answer.text, BROWSER_RESULT_TEXT_BYTES)
  return {
    ...status,
    text: clipped.text,
    truncated: clipped.truncated,
    answeredAt: answer.at,
  }
}

/**
 * Stop the task a submission started.
 *
 * On the Host's authority, and for a session this device owns — the ownership
 * check is `getBrowserContextSubmission`'s, which answers a submission
 * belonging to another device exactly as it answers a missing one.
 *
 * A refusal because somebody else is holding the wheel is reported as its own
 * code rather than as a failure. It is the honest answer: the run is fine, the
 * desktop is driving it, and the remedy is over there. Reporting it as failed
 * would tell the user their task broke.
 */
export async function cancelBrowserContext(
  deps: BrowserCompanionDeps,
  deviceId: string,
  payload: { submissionId?: unknown }
): Promise<BrowserContextSubmissionStatusV1> {
  const status = await getBrowserContextSubmission(deps, deviceId, payload)
  const stopped = await deps.abortTurn(status.sessionId)
  if (!stopped) {
    throw new BrowserCompanionError(
      "session_driven_elsewhere",
      "another device is driving this task; stop it there"
    )
  }
  // Read the status back rather than assuming `cancelled`: an abort is a
  // request to the runtime, and what the run does with it is the runtime's
  // answer, not this function's.
  return getBrowserContextSubmission(deps, deviceId, payload)
}

/**
 * Cut text to a byte ceiling on a character boundary, and say whether it was
 * cut.
 *
 * The loop steps back a character at a time so a multi-byte codepoint is never
 * split into a replacement character — the same shape the extension's own
 * clipper has, for the same reason.
 */
function clipToBytes(value: string, limitBytes: number): { text: string; truncated: boolean } {
  if (utf8ByteLength(value) <= limitBytes) return { text: value, truncated: false }
  let cut = value.length
  while (cut > 0 && utf8ByteLength(value.slice(0, cut)) > limitBytes) {
    cut = Math.max(0, cut - Math.ceil((utf8ByteLength(value.slice(0, cut)) - limitBytes) / 4) - 1)
  }
  return { text: value.slice(0, cut), truncated: true }
}

/**
 * The session's live state wins over the recorded one — when there is one.
 *
 * The row records what was true when it was written; the run has moved on
 * since. Two cases fall back to the row instead: the session cannot be read
 * (a temporarily unreachable runtime must not rewrite history as `failed`),
 * and the session has no run (`null`), which is exactly the shape of a
 * submission whose enqueue was refused or had no runtime to accept it.
 */
async function currentStatus(
  deps: BrowserCompanionDeps,
  row: BrowserSubmissionRow
): Promise<BrowserSubmissionStatus> {
  try {
    return (await deps.sessionStatus(row.sessionId)) ?? row.status
  } catch {
    return row.status
  }
}

/**
 * Whether an in-flight row and a fresh request describe the same capture.
 *
 * The URL settles it: `urlFingerprint` is the digest of the exact captured URL,
 * so two different pages cannot agree on it however alike they otherwise look.
 * The remaining fields — derived title, source host, capture mode, byte count,
 * truncation flags — then catch the same URL captured differently (a selection
 * vs the whole page, a page that changed between attempts).
 *
 * Host alone was not enough, which is why the fingerprint exists: two paths on
 * one host with the same derived title, mode and byte count are one capture as
 * far as `sourceHost` can tell, and redriving page B onto page A's session is
 * exactly what this check is here to refuse.
 *
 * A row from before the field existed has no fingerprint. It is compared on
 * everything else, as it was: the alternative — refusing every retry of an
 * older row — would break the recovery path this whole branch exists to serve,
 * to avoid a collision no wider than the one that shipped.
 *
 * The instruction is deliberately not compared. It is the user's question about
 * the page rather than the page itself, the row does not record it, and a retry
 * that rewords it is still a retry of the same capture.
 */
function describesSameCapture(
  row: BrowserSubmissionRow,
  request: BrowserContextSubmitRequestV1,
  derivedTitle: string,
  urlFingerprint: string
): boolean {
  if (row.urlFingerprint && row.urlFingerprint !== urlFingerprint) return false
  // Where it goes, not only what it carries. A row created for a new task and a
  // retry asking to append to that same task agree on every other field, and
  // honouring the second would do the opposite of what it asked while looking
  // like a recovery. A row from before targets existed has no `targetId` and is
  // compared against the default, which is what it was.
  if ((row.targetId ?? NEW_CHAT_TARGET_ID) !== (request.targetId ?? NEW_CHAT_TARGET_ID)) {
    return false
  }
  // An append keeps the conversation's title, so the derived one describes the
  // page rather than the row and cannot be compared against it.
  const titleMatches = row.targetId?.startsWith("session:") ? true : row.title === derivedTitle
  return (
    titleMatches &&
    row.sourceHost === sourceHostOf(request.context.url) &&
    row.captureMode === request.context.captureMode &&
    row.contentBytes === capturedContentBytes(request) &&
    row.truncated === capturedTruncated(request)
  )
}

function capturedTruncated(request: BrowserContextSubmitRequestV1): boolean {
  return (
    Boolean(request.context.selection?.truncated) ||
    Boolean(request.context.readableText?.truncated)
  )
}

function capturedContentBytes(request: BrowserContextSubmitRequestV1): number {
  return (
    utf8ByteLength(request.context.selection?.text ?? "") +
    utf8ByteLength(request.context.readableText?.text ?? "")
  )
}

function rejectionError(rejection: BrowserSubmissionRejection): BrowserCompanionError {
  switch (rejection.code) {
    case "too_large":
      return new BrowserCompanionError(
        "payload_too_large",
        `${rejection.field} is ${rejection.bytes} bytes, over the ${rejection.limit}-byte limit`
      )
    case "capture_mode_missing_content":
      return new BrowserCompanionError(
        "capture_mode_mismatch",
        `${rejection.field} is required for this capture mode`
      )
    default:
      return new BrowserCompanionError("malformed", `${rejection.field} is missing or invalid`)
  }
}
