/**
 * Shell-agnostic Inbox write facade — ADR-0131 cross-shell inbox relay.
 *
 * Components never branch on the shell. They call one of the four writes
 * below; {@link resolveInboxWriteRoute} picks the executor:
 *
 *   - `"local"`  → `local.ts`   (this process owns the connector runtime)
 *   - `"remote"` → `remote.ts`  (durable `mobileOutboundQueue` → paired host RPC,
 *                                plus an optimistic local mirror)
 *   - `"unavailable"` → throws {@link InboxWriteUnavailableError}
 *
 * Every write also checks the relayed command's availability against the
 * host manifest so a thin client paired to a pre-relay host fails fast with
 * a typed error instead of a dead-lettered queue row.
 *
 * Consumers: `components/chat/composer.tsx`, `components/inbox/draft-editor.tsx`,
 * `components/mobile/connector/draft-approval-panel.tsx`, every override
 * control under `components/inbox/`, `lib/inbox/manual-send.ts` (Slice 1E
 * "send to IM"), and the host arms in `lib/companion/desktop-write-source.ts`
 * (which call `local.ts` directly).
 */

import type { OperationAvailability } from "@/lib/runtime/operation-availability"
import type { ConversationReference } from "@/types/connectors/event"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import {
  approveDraftLocally,
  rejectDraftLocally,
  sendManualReplyLocally,
  type ApproveDraftLocallyOptions,
  type ManualReplyResult,
} from "./local"
import {
  approveDraftRemotely,
  mutateOverrideRemotely,
  rejectDraftRemotely,
  sendManualReplyRemotely,
} from "./remote"
import {
  applyConversationOverrideMutation,
  conversationKeyOfMutation,
  type ConversationOverrideMutation,
} from "./override-mutation"
import {
  canEnqueueInboxWrite,
  INBOX_WRITE_COMMANDS,
  resolveInboxWriteAvailability,
  resolveInboxWriteRoute,
  type InboxWriteCommand,
  type InboxWriteRoute,
} from "./route"

export class InboxWriteUnavailableError extends Error {
  readonly code = "inbox_write_unavailable"
  constructor(
    readonly command: InboxWriteCommand,
    readonly route: InboxWriteRoute,
    readonly availability: OperationAvailability
  ) {
    super(
      `inbox write "${command}" is unavailable on route "${route}" (${availability.state}: ${availability.reason})`
    )
    this.name = "InboxWriteUnavailableError"
  }
}

function resolveRouteOrThrow(command: InboxWriteCommand): Exclude<InboxWriteRoute, "unavailable"> {
  const route = resolveInboxWriteRoute()
  const availability = resolveInboxWriteAvailability(command)
  if (route === "unavailable" || (route === "remote" && !canEnqueueInboxWrite(availability))) {
    throw new InboxWriteUnavailableError(command, route, availability)
  }
  return route
}

export interface SendManualReplyInput {
  adapterId: string
  conversationKey: string
  sessionId: string
  conversationRef: ConversationReference
  /** Either `text` or `segments` (segments win when both are given). */
  text?: string
  segments?: MessageSegment[]
  replyTo?: OutboundRequest["replyTo"]
  threadId?: string
  /** Override the client-minted idempotency key (tests / callers with their own key). */
  idempotencyKey?: string
  /** Override the client-minted local message id. */
  clientMessageId?: string
  /** Offline-queue label for the remote route. */
  label?: string
}

export interface SendManualReplyOutcome extends Omit<ManualReplyResult, "jobId"> {
  route: Exclude<InboxWriteRoute, "unavailable">
  /** Set on the local route; on the remote route the host allocates it. */
  jobId?: string
  idempotencyKey: string
}

/**
 * Send a human-authored reply into a platform conversation. Local hosts
 * enqueue directly; thin clients relay through the durable queue. The
 * idempotency key is minted ONCE here and threaded through every layer.
 */
export async function sendManualReply(
  input: SendManualReplyInput
): Promise<SendManualReplyOutcome> {
  const route = resolveRouteOrThrow(INBOX_WRITE_COMMANDS.send)
  const segments: MessageSegment[] =
    input.segments && input.segments.length > 0
      ? input.segments
      : [{ type: "text", text: (input.text ?? "").trim() }]
  const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID()
  const clientMessageId = input.clientMessageId ?? crypto.randomUUID()
  const shared = {
    adapterId: input.adapterId,
    conversationKey: input.conversationKey,
    sessionId: input.sessionId,
    conversationRef: input.conversationRef,
    segments,
    idempotencyKey,
    clientMessageId,
    replyTo: input.replyTo,
    threadId: input.threadId,
  }
  if (route === "local") {
    const result = await sendManualReplyLocally(shared)
    return { ...result, route, idempotencyKey }
  }
  const result = await sendManualReplyRemotely(shared, { label: input.label })
  return { route, messageId: result.messageId, reused: false, idempotencyKey }
}

export interface ApproveInboxDraftOptions extends ApproveDraftLocallyOptions {
  label?: string
}

export interface ApproveInboxDraftOutcome {
  route: Exclude<InboxWriteRoute, "unavailable">
  draftId: string
  /** Local route only — the enqueued outbound job. */
  jobId?: string
}

/** Approve a pending draft (optionally with edited segments). */
export async function approveInboxDraft(
  draft: ConnectorDraftRow | string,
  options: ApproveInboxDraftOptions = {}
): Promise<ApproveInboxDraftOutcome> {
  const draftId = typeof draft === "string" ? draft : draft.id
  const route = resolveRouteOrThrow(INBOX_WRITE_COMMANDS.approve)
  if (route === "local") {
    const result = await approveDraftLocally(draftId, {
      segments: options.segments,
      binding: options.binding,
    })
    return { route, draftId, jobId: result.jobId }
  }
  await approveDraftRemotely(draftId, options.segments, { label: options.label })
  return { route, draftId }
}

/** Reject a pending draft. */
export async function rejectInboxDraft(
  draft: ConnectorDraftRow | string,
  options: { label?: string } = {}
): Promise<{ route: Exclude<InboxWriteRoute, "unavailable">; draftId: string }> {
  const draftId = typeof draft === "string" ? draft : draft.id
  const route = resolveRouteOrThrow(INBOX_WRITE_COMMANDS.reject)
  if (route === "local") {
    await rejectDraftLocally(draftId)
  } else {
    await rejectDraftRemotely(draftId, { label: options.label })
  }
  return { route, draftId }
}

export interface MutateConversationOverrideOptions {
  /** Provenance for the assignment trail / audit when the mutation carries none. */
  via?: string
  /** Offline-queue label for the remote route. */
  label?: string
}

/**
 * Apply an override mutation: full semantics (audit + trail) on a local
 * host, optimistic mirror + relayed authoritative write on a thin client.
 */
export async function mutateConversationOverride(
  mutation: ConversationOverrideMutation,
  options: MutateConversationOverrideOptions = {}
): Promise<{
  route: Exclude<InboxWriteRoute, "unavailable">
  conversationKey: string | undefined
}> {
  const route = resolveRouteOrThrow(INBOX_WRITE_COMMANDS.override)
  if (route === "local") {
    await applyConversationOverrideMutation(mutation, { via: options.via })
  } else {
    await mutateOverrideRemotely(mutation, { label: options.label })
  }
  return { route, conversationKey: conversationKeyOfMutation(mutation) }
}

export {
  resolveInboxWriteRoute,
  resolveInboxWriteAvailability,
  canEnqueueInboxWrite,
  hostSupportsInboxRelay,
  remoteHostOperations,
  INBOX_WRITE_COMMANDS,
  INBOX_RELAY_FEATURE,
  type InboxWriteRoute,
  type InboxWriteCommand,
} from "./route"
export {
  useInboxWriteRoute,
  useInboxWriteReadiness,
  type InboxWriteReadiness,
} from "./use-inbox-write-route"
export {
  applyConversationOverrideMutation,
  applyOptimisticOverrideMutation,
  isConversationOverrideMutation,
  conversationKeyOfMutation,
  encodeOverrideMutationClears,
  decodeOverrideMutationClears,
  type ConversationOverrideMutation,
  type ConversationOverrideMutationKind,
} from "./override-mutation"
export {
  hasPendingOverrideMutation,
  pendingOverrideConversationKeys,
  markPendingOverrideMutation,
} from "./pending-overrides"
export {
  sendManualReplyLocally,
  approveDraftLocally,
  rejectDraftLocally,
  DraftNotFoundError,
  draftApprovalIdempotencyKey,
  type ManualReplyInput,
  type ManualReplyResult,
  type ApproveDraftResult,
} from "./local"
