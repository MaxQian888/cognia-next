/**
 * Local (connector-host) inbox writes — ADR-0131 cross-shell inbox relay.
 *
 * The three write primitives every Inbox reply surface needs, executed
 * against THIS process's Dexie + delivery gateway. Shared verbatim by:
 *
 *  - the `"local"` route of `lib/connectors/inbox-writes/index.ts` (desktop
 *    / headless brain UI acting on its own connector runtime), and
 *  - the host-side RPC arms in `lib/companion/desktop-write-source.ts`
 *    (`connector_enqueue_outbound`, `connector_approve_draft`,
 *    `connector_reject_draft`) that a phone / browser / remote-driving
 *    desktop reaches through the durable `mobileOutboundQueue`.
 *
 * `sendManualReplyLocally` is the composer's historical manual-mode path
 * (`components/chat/composer.tsx` — `enqueueGoverned(source: "manual")` +
 * `messages.add`) lifted out so it can be replayed idempotently: an RPC
 * retry that re-runs the arm with the same `idempotencyKey` finds the
 * existing `outboundQueue` row and returns it instead of sending twice.
 */

import type { StoredMessage, MessageReplyTo } from "@cognia/agent-config-types"
import { enqueueGoverned } from "@/lib/connectors/delivery-gateway"
import { approveDraft, getDraft, rejectDraft } from "@/lib/db/connector-drafts"
import type { ConnectorDraftRow, OutboundJobRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"
import { publishSyncInvalidate } from "@/lib/sync/host-invalidate"
import type { ConversationReference } from "@/types/connectors/event"
import { parseConversationKey } from "@/types/connectors/event"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { markSessionDirty } from "@/lib/chat/search/indexer"
import { invalidatePersistSnapshot } from "@/lib/db/messages"
import { readChatTemplateRun, type ChatTemplateRun } from "@/lib/chat/template/run"
import { parseReplyToPayload } from "@/lib/chat/reply-to"
import { enforceTwinDisclosureFromProvenance } from "@/lib/twin/outbound-disclosure"

/** Internal transcript provenance; never forwarded to platform adapters. */
export interface ManualReplyMessageMetadata {
  replyTo?: MessageReplyTo
  templateRun?: ChatTemplateRun
}

export function parseManualReplyMessageMetadata(
  value: unknown
): ManualReplyMessageMetadata | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid messageMetadata")
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => key !== "replyTo" && key !== "templateRun"))
    throw new Error("invalid messageMetadata field")
  const replyTo = raw.replyTo === undefined ? undefined : parseReplyToPayload(raw.replyTo)
  const templateRun = raw.templateRun === undefined ? undefined : readChatTemplateRun(raw)
  if (replyTo === null || templateRun === null) throw new Error("invalid messageMetadata value")
  return { ...(replyTo ? { replyTo } : {}), ...(templateRun ? { templateRun } : {}) }
}

export interface ManualReplyInput {
  adapterId: string
  conversationKey: string
  /** The platform-bound chat session the user replied from. */
  sessionId: string
  conversationRef: ConversationReference
  segments: MessageSegment[]
  /**
   * Client-minted ONCE (`crypto.randomUUID()`) and stable across every retry
   * — the same value is the `mobileOutboundQueue` row's idempotency key, the
   * `Idempotency-Key` header the Rust ledger dedupes on, AND
   * `OutboundRequest.metadata.idempotencyKey` the outbound runner dedupes on.
   */
  idempotencyKey: string
  /**
   * Client-minted id for the local `messages` row. Stable so a thin client's
   * optimistic message and the host's authoritative message share one id and
   * companion sync converges instead of duplicating.
   */
  clientMessageId?: string
  replyTo?: OutboundRequest["replyTo"]
  threadId?: string
  messageMetadata?: ManualReplyMessageMetadata
}

export interface ManualReplyResult {
  jobId: string
  messageId: string
  /** `true` when the idempotency key matched an existing job (retry replay). */
  reused: boolean
}

/** Render outbound segments as the text parts of the local user message. */
export function segmentsToMessageParts(
  segments: readonly MessageSegment[]
): StoredMessage["parts"] {
  const parts: StoredMessage["parts"] = []
  for (const segment of segments) {
    switch (segment.type) {
      case "text":
        if (segment.text) parts.push({ type: "text", text: segment.text })
        break
      case "markdown":
        if (segment.md) parts.push({ type: "text", text: segment.md })
        break
      case "image":
        parts.push({
          type: "file",
          url: segment.url,
          mediaType: segment.mimeType ?? "image/png",
          filename: segment.alt,
        })
        break
      case "file":
        parts.push({
          type: "file",
          url: segment.url,
          mediaType: segment.mimeType,
          filename: segment.name,
        })
        break
      default:
        break
    }
  }
  return parts
}

async function findJobByIdempotencyKey(
  idempotencyKey: string
): Promise<OutboundJobRow | undefined> {
  return getDb().outboundQueue.where("idempotencyKey").equals(idempotencyKey).first()
}

async function findMessageForJob(
  sessionId: string,
  jobId: string
): Promise<StoredMessage | undefined> {
  const rows = await getDb().messages.where("sessionId").equals(sessionId).toArray()
  return rows.find((row) => row.metadata?.outboundJobId === jobId)
}

/**
 * Enqueue a manual reply (governed, PII fail-closed) and append the matching
 * local `user` message carrying `metadata.outboundJobId`. Idempotent on
 * `idempotencyKey`.
 */
// Host RPC replays may overlap before the first durable write completes.
const manualReplyWrites = new Map<string, Promise<ManualReplyResult>>()

export async function sendManualReplyLocally(input: ManualReplyInput): Promise<ManualReplyResult> {
  const previous = manualReplyWrites.get(input.idempotencyKey)
  const write = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => persistManualReplyLocally(input))
  manualReplyWrites.set(input.idempotencyKey, write)
  try {
    return await write
  } finally {
    if (manualReplyWrites.get(input.idempotencyKey) === write)
      manualReplyWrites.delete(input.idempotencyKey)
  }
}

async function persistManualReplyLocally(input: ManualReplyInput): Promise<ManualReplyResult> {
  const existingJob = await findJobByIdempotencyKey(input.idempotencyKey)
  if (existingJob) {
    const existingMessage = await findMessageForJob(input.sessionId, existingJob.id)
    if (existingMessage) {
      return { jobId: existingJob.id, messageId: existingMessage.id, reused: true }
    }
    // The job landed but the message write was interrupted — finish it.
    const messageId = await appendReplyMessage(input, existingJob.id)
    return { jobId: existingJob.id, messageId, reused: true }
  }

  const message = buildReplyMessage(input)
  try {
    const job = await enqueueGoverned({
      localMessage: message,
      adapterId: input.adapterId,
      conversationKey: input.conversationKey,
      request: {
        conversationRef: input.conversationRef,
        segments: input.segments,
        metadata: { idempotencyKey: input.idempotencyKey },
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
      source: "manual",
    })
    notifyReplyMessage(input)
    return { jobId: job.id, messageId: message.id, reused: false }
  } catch (error) {
    // Housekeeping can fail after the atomic commit. Report acceptance only
    // when BOTH durable rows exist; a failed transcript write rolls back the job.
    const acceptedJob = await findJobByIdempotencyKey(input.idempotencyKey)
    const acceptedMessage =
      acceptedJob && (await findMessageForJob(input.sessionId, acceptedJob.id))
    if (!acceptedJob || !acceptedMessage) throw error
    notifyReplyMessage(input)
    return { jobId: acceptedJob.id, messageId: acceptedMessage.id, reused: true }
  }
}

function buildReplyMessage(input: ManualReplyInput, jobId?: string): StoredMessage {
  const now = Date.now()
  const id = input.clientMessageId ?? crypto.randomUUID()
  const parts = segmentsToMessageParts(input.segments)
  const row: StoredMessage = {
    id,
    sessionId: input.sessionId,
    role: "user",
    parts: parts.length > 0 ? parts : [{ type: "text", text: "" }],
    metadata: { ...input.messageMetadata, ...(jobId ? { outboundJobId: jobId } : {}) },
    createdAt: now,
  }
  return row
}

async function appendReplyMessage(input: ManualReplyInput, jobId: string): Promise<string> {
  const row = buildReplyMessage(input, jobId)
  // `put`, not `add`: a thin client may already hold the optimistic row under
  // the same client-minted id (host and client converge on one row).
  await getDb().messages.put(row)
  notifyReplyMessage(input)
  return row.id
}

function notifyReplyMessage(input: ManualReplyInput): void {
  markSessionDirty(input.sessionId)
  invalidatePersistSnapshot(input.sessionId)
  try {
    publishSyncInvalidate("messages", input.conversationKey)
  } catch {
    // The transcript and job already committed. Periodic companion sync can
    // recover a missed wake; a notification failure must not invite a resend.
  }
}

export interface ApproveDraftLocallyOptions {
  /** Edited segments; defaults to the draft's own. */
  segments?: MessageSegment[]
  /**
   * Fallback delivery binding for drafts without an `outboundPreview` (every
   * `draft-prepare` route draft today — `runtime.ts:createDraft` never sets a
   * preview). Resolved from the draft's session when omitted.
   */
  binding?: {
    adapterId: string
    conversationKey: string
    conversationRef: ConversationReference
  }
}

export interface ApproveDraftResult {
  draftId: string
  /** The outbound job that carries the delivery; `undefined` when no delivery target could be resolved. */
  jobId?: string
  /** `true` when the draft was already approved (idempotent replay). */
  alreadyApproved: boolean
}

export class DraftNotFoundError extends Error {
  readonly code = "draft_not_found"
  constructor(readonly draftId: string) {
    super(`connector draft not found: ${draftId}`)
    this.name = "DraftNotFoundError"
  }
}

/** Stable idempotency key for the outbound job an approval produces. */
export function draftApprovalIdempotencyKey(draft: Pick<ConnectorDraftRow, "id">): string {
  return `cdr-approve:${draft.id}`
}

async function resolveApprovalRequest(
  draft: ConnectorDraftRow,
  options: ApproveDraftLocallyOptions
): Promise<{ adapterId: string; request: OutboundRequest } | undefined> {
  const segments = options.segments ?? draft.segments
  if (draft.outboundPreview) {
    const request = { ...draft.outboundPreview, segments }
    request.segments = enforceTwinDisclosureFromProvenance(
      request.segments,
      request.metadata.provenance
    )
    return {
      adapterId: draft.outboundPreview.conversationRef.adapterId,
      request,
    }
  }
  const binding =
    options.binding ??
    (await getDb()
      .sessions.get(draft.sessionId)
      .then((session) => session?.platformBinding))
  if (!binding) return undefined
  return {
    adapterId: binding.adapterId,
    request: {
      conversationRef: binding.conversationRef,
      segments,
      metadata: { idempotencyKey: draftApprovalIdempotencyKey(draft) },
    },
  }
}

/**
 * Approve a pending draft: enqueue the governed outbound job FIRST (a failed
 * enqueue leaves the draft pending), then flip the draft to `approved`.
 * Idempotent: an already-approved draft, or an approval whose idempotency
 * key already produced a job, returns the existing job without a second send.
 */
export async function approveDraftLocally(
  draftId: string,
  options: ApproveDraftLocallyOptions = {}
): Promise<ApproveDraftResult> {
  const draft = await getDraft(draftId)
  if (!draft) throw new DraftNotFoundError(draftId)
  const resolved = await resolveApprovalRequest(draft, options)
  const idempotencyKey = resolved?.request.metadata.idempotencyKey
  const existingJob = idempotencyKey ? await findJobByIdempotencyKey(idempotencyKey) : undefined

  if (draft.status !== "pending") {
    return { draftId, jobId: existingJob?.id, alreadyApproved: draft.status === "approved" }
  }
  let jobId = existingJob?.id
  if (resolved && !existingJob) {
    const job = await enqueueGoverned({
      adapterId: resolved.adapterId,
      conversationKey: draft.conversationKey,
      request: resolved.request,
      source: "draft-approved",
    })
    jobId = job.id
  }
  await approveDraft(draftId)
  return { draftId, jobId, alreadyApproved: false }
}

/** Reject a pending draft. Idempotent — a non-pending draft is left as is. */
export async function rejectDraftLocally(draftId: string): Promise<{ draftId: string }> {
  const draft = await getDraft(draftId)
  if (!draft) throw new DraftNotFoundError(draftId)
  if (draft.status === "pending") await rejectDraft(draftId)
  return { draftId }
}

/** Adapter id for a conversation key, or `undefined` when unparsable. */
export function adapterIdOfConversationKey(conversationKey: string): string | undefined {
  try {
    return parseConversationKey(conversationKey).adapterId
  } catch {
    return undefined
  }
}
