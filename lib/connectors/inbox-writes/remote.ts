/**
 * Remote (thin-client) inbox writes — ADR-0131 cross-shell inbox relay.
 *
 * A phone, a web companion, or a desktop driving a remote host does not run
 * connector adapters; every write is shipped to the paired host through the
 * durable `mobileOutboundQueue` (`lib/db/mobile-outbound-queue.ts`) and
 * dispatched by `lib/queue/outbound-queue.ts` as an RPC with the row's
 * idempotency key as the `Idempotency-Key` header. Each write ALSO lands an
 * optimistic local mirror so the UI reflects it immediately; the host's
 * authoritative row replaces the mirror through companion sync.
 *
 * Idempotency contract (all three writes): the queue row's `idempotencyKey`
 * is minted once by the caller and reused on every retry, so the host arm can
 * dedupe (`outboundQueue.where("idempotencyKey")`, draft status) and the
 * Rust ledger can replay a cached response.
 */

import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"
import { approveDraft, getDraft, rejectDraft } from "@/lib/db/connector-drafts"
import { getDb } from "@/lib/db/schema"
import type { StoredMessage } from "@cognia/agent-config-types"
import type { MessageSegment } from "@/types/connectors/segment"
import { draftApprovalIdempotencyKey, segmentsToMessageParts, type ManualReplyInput } from "./local"
import {
  applyOptimisticOverrideMutation,
  conversationKeyOfMutation,
  type ConversationOverrideMutation,
} from "./override-mutation"
import { markPendingOverrideMutation } from "./pending-overrides"
import { INBOX_WRITE_COMMANDS } from "./route"

export interface RemoteWriteOptions {
  /** Human label rendered in the offline-queue UI. */
  label?: string
}

export interface RemoteManualReplyResult {
  /** The durable queue row carrying the RPC. */
  queueRow: MobileOutboundJobRow
  /** The optimistic local message id (== `clientMessageId`). */
  messageId: string
}

/**
 * Relay a manual reply: enqueue `connector_enqueue_outbound`, then write the
 * optimistic `user` message under the client-minted id the host will reuse.
 */
export async function sendManualReplyRemotely(
  input: ManualReplyInput & { clientMessageId: string },
  options: RemoteWriteOptions = {}
): Promise<RemoteManualReplyResult> {
  const queueRow = await enqueue({
    command: INBOX_WRITE_COMMANDS.send,
    idempotencyKey: input.idempotencyKey,
    label: options.label,
    payload: {
      adapterId: input.adapterId,
      conversationKey: input.conversationKey,
      sessionId: input.sessionId,
      clientMessageId: input.clientMessageId,
      request: {
        conversationRef: input.conversationRef,
        segments: input.segments,
        metadata: { idempotencyKey: input.idempotencyKey },
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
    },
  })
  const parts = segmentsToMessageParts(input.segments)
  const row: StoredMessage = {
    id: input.clientMessageId,
    sessionId: input.sessionId,
    role: "user",
    parts: parts.length > 0 ? parts : [{ type: "text", text: "" }],
    // The host stamps `outboundJobId` on its authoritative copy; until that
    // syncs down the mirror only carries the relay key so the pill can wait.
    metadata: { relayIdempotencyKey: input.idempotencyKey },
    createdAt: Date.now(),
  }
  await getDb().messages.put(row)
  return { queueRow, messageId: input.clientMessageId }
}

/**
 * Relay a draft approval (with optional edited segments), then flip the
 * local mirror to `approved`. Idempotency key derives from the draft id so a
 * retried approval can never produce a second outbound job on the host.
 */
export async function approveDraftRemotely(
  draftId: string,
  segments: MessageSegment[] | undefined,
  options: RemoteWriteOptions = {}
): Promise<MobileOutboundJobRow> {
  const queueRow = await enqueue({
    command: INBOX_WRITE_COMMANDS.approve,
    idempotencyKey: draftApprovalIdempotencyKey({ id: draftId }),
    label: options.label,
    payload: { draftId, ...(segments ? { segments } : {}) },
  })
  const draft = await getDraft(draftId)
  if (draft?.status === "pending") await approveDraft(draftId)
  return queueRow
}

/** Relay a draft rejection, then flip the local mirror to `rejected`. */
export async function rejectDraftRemotely(
  draftId: string,
  options: RemoteWriteOptions = {}
): Promise<MobileOutboundJobRow> {
  const queueRow = await enqueue({
    command: INBOX_WRITE_COMMANDS.reject,
    idempotencyKey: `cdr-reject:${draftId}`,
    label: options.label,
    payload: { draftId },
  })
  const draft = await getDraft(draftId)
  if (draft?.status === "pending") await rejectDraft(draftId)
  return queueRow
}

/**
 * Relay an override mutation: mark the conversation key pending (so a
 * concurrent sync pull cannot clobber the optimistic write), enqueue
 * `conversation_overrides_update { mutation }`, apply the optimistic mirror,
 * release the memory marker (the queue row keeps the key pending until the
 * host has applied it — see `pending-overrides.ts`).
 */
export async function mutateOverrideRemotely(
  mutation: ConversationOverrideMutation,
  options: RemoteWriteOptions = {}
): Promise<MobileOutboundJobRow> {
  const key = conversationKeyOfMutation(mutation)
  const release = key ? markPendingOverrideMutation(key) : () => undefined
  try {
    const queueRow = await enqueue({
      command: INBOX_WRITE_COMMANDS.override,
      idempotencyKey: crypto.randomUUID(),
      label: options.label,
      payload: { mutation },
    })
    await applyOptimisticOverrideMutation(mutation)
    return queueRow
  } finally {
    release()
  }
}
