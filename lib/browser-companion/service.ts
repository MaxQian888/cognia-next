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
  BrowserContextSubmissionStatusV1,
  BrowserContextSubmissionSummaryPageV1,
  BrowserContextSubmitRequestV1,
  BrowserContextSubmitResponseV1,
  BrowserSubmissionStatus,
} from "@/types/browser-companion"
import { BROWSER_CAPTURE_MODES, BROWSER_CONTEXT_LIMITS } from "@/types/browser-companion"
import { utf8ByteLength } from "@cognia/companion-client"
import type { BrowserSubmissionRow } from "@/lib/db/browser-submissions-types"

import { sha256Hex } from "@/lib/share/hash"

import { buildBrowserContextPrompt, sourceHostOf } from "./build-prompt"
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
  /** The Host's resolved appearance for the side panel. */
  appearance: () => BrowserCompanionCapabilityV1["appearance"]
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
  /** The live status of the session a submission created. */
  sessionStatus: (sessionId: string) => Promise<BrowserSubmissionStatus>
}

/** `cognia://session/<id>` — the link that opens the task on the desktop. */
export function browserSubmissionDeepLink(sessionId: string): string {
  return `cognia://session/${encodeURIComponent(sessionId)}`
}

export async function browserCompanionCapability(
  deps: BrowserCompanionDeps
): Promise<BrowserCompanionCapabilityV1> {
  return {
    schemaVersion: 1,
    limits: BROWSER_CONTEXT_LIMITS,
    supportedCaptureModes: [...BROWSER_CAPTURE_MODES],
    workspaces: await deps.listWorkspaces(),
    appearance: deps.appearance(),
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
    if (existing.status === "submitting") {
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
      await deps.enqueueMessage({
        sessionId: existing.sessionId,
        messageId: `browser-${request.submissionId}`,
        text: prompt,
      })
      await deps.recordSubmission({ ...existing, status: "queued", updatedAt: deps.now() })
    }
    return {
      submissionId: existing.submissionId,
      sessionId: existing.sessionId,
      acceptedAt: existing.submittedAt,
      status: existing.status === "submitting" ? "queued" : existing.status,
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

  const { prompt, derivedTitle } = buildBrowserContextPrompt(
    request.context,
    request.instruction,
    request.suggestedTitle
  )
  const session = await deps.createSession({
    title: derivedTitle,
    projectId: request.workspaceId,
  })

  const now = deps.now()
  // Persist the recoverable intent first, then mark it queued only after
  // HostState accepts the stable message id. A retry can redrive a submission
  // left in `submitting` without creating another session or transcript item.
  const submission: BrowserSubmissionRow = {
    submissionId: request.submissionId,
    deviceId,
    sessionId: session.id,
    title: derivedTitle,
    sourceHost: sourceHostOf(request.context.url),
    urlFingerprint,
    captureMode: request.context.captureMode,
    contentBytes: capturedContentBytes(request),
    truncated: capturedTruncated(request),
    status: "submitting",
    submittedAt: now,
    updatedAt: now,
  }
  await deps.recordSubmission(submission)

  await deps.enqueueMessage({
    sessionId: session.id,
    // Derived from the submission id rather than random: a retry that gets
    // past the ledger must still resolve to the same message, or the same
    // capture arrives twice in one transcript.
    messageId: `browser-${request.submissionId}`,
    text: prompt,
  })
  await deps.recordSubmission({ ...submission, status: "queued", updatedAt: deps.now() })

  return {
    submissionId: request.submissionId,
    sessionId: session.id,
    acceptedAt: now,
    status: "queued",
    deepLink: browserSubmissionDeepLink(session.id),
  }
}

export async function listBrowserContextSubmissions(
  deps: BrowserCompanionDeps,
  deviceId: string,
  payload: { limit?: number } = {}
): Promise<BrowserContextSubmissionSummaryPageV1> {
  if (!deviceId) throw new BrowserCompanionError("caller_unbound", "the caller device is unknown")
  const limit = Math.min(50, Math.max(1, Math.trunc(payload.limit ?? 20)))
  const rows = await deps.listSubmissions(deviceId, limit)
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
  return { items }
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
 * The session's live state wins over the recorded one.
 *
 * The row records what was true when it was written; the run has moved on
 * since. Falling back to the row when the session cannot be read keeps a
 * temporarily unreachable runtime from rewriting history as `failed`.
 */
async function currentStatus(
  deps: BrowserCompanionDeps,
  row: BrowserSubmissionRow
): Promise<BrowserSubmissionStatus> {
  try {
    return await deps.sessionStatus(row.sessionId)
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
  return (
    row.title === derivedTitle &&
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
