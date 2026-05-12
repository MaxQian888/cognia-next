/**
 * Bridge from {@link NormalizedGhEvent} to the connector bus's
 * {@link NormalizedInboundEvent} shape so PR / Issue events surface in the
 * unified Inbox alongside platform messages.
 *
 * The bridge is intentionally narrow — only event kinds where a human action
 * is plausible get bridged. The bot can keep handling check_run / push /
 * release events via workflow nodes without polluting the inbox.
 *
 * `lib/connectors/bus.dispatchInbound` is the destination; the plugin entry
 * is responsible for actually calling it after the bridge produces an event.
 */

import { buildConversationKey } from "@/types/connectors/event"
import type {
  ChannelDescriptor,
  ConversationReference,
  NormalizedInboundEvent,
  PlatformIdentity,
} from "@/types/connectors/event"
import type { NormalizedGhEvent, NormalizedGhEventKind } from "@/lib/github/types"

/** Which event kinds should appear in the Inbox. */
const INBOX_KINDS: ReadonlySet<NormalizedGhEventKind> = new Set([
  "pull_request.opened",
  "pull_request.review_requested",
  "pull_request.closed",
  "issues.opened",
  "issues.assigned",
  "issue_comment.created",
])

const ADAPTER_ID = "github-delivery"
/** Self-id is constant — the github-delivery plugin acts as a single principal. */
const SELF_ID = "github-delivery-bot"

export function shouldBridgeToInbox(kind: NormalizedGhEventKind): boolean {
  return INBOX_KINDS.has(kind)
}

/**
 * Map a NormalizedGhEvent to a NormalizedInboundEvent. Returns null when the
 * event kind isn't bridged (caller can drop it without further processing).
 */
export function ghEventToInbound(event: NormalizedGhEvent): NormalizedInboundEvent | null {
  if (!shouldBridgeToInbox(event.kind)) return null

  // The "conversation" for GitHub events is keyed by the repo plus the
  // numeric id of the PR or issue, so threads in the Inbox track per-item
  // back-and-forth (multiple comments on the same PR collapse into one).
  const remoteChatId = buildRemoteChatId(event)
  const conversationRef: ConversationReference = {
    platform: "github",
    adapterId: ADAPTER_ID,
    repoFullName: event.repoFullName,
    refKind: event.pr ? "pr" : event.issue ? "issue" : "repo",
    refNumber: event.pr?.prNumber ?? event.issue?.issueNumber,
  }
  const conversationKey = buildConversationKey("github", ADAPTER_ID, remoteChatId)

  const sender: PlatformIdentity = {
    id: `${ADAPTER_ID}:${event.senderLogin ?? "anonymous"}`,
    platform: "github",
    adapterId: ADAPTER_ID,
    remoteUserId: event.senderLogin ?? "anonymous",
    displayName: event.senderLogin,
  }

  const channel: ChannelDescriptor = {
    id: remoteChatId,
    name: event.pr
      ? `${event.repoFullName}#${event.pr.prNumber}`
      : event.issue
        ? `${event.repoFullName}#${event.issue.issueNumber}`
        : event.repoFullName,
    kind: "thread",
    platformChannelId: remoteChatId,
  }

  const plainText = describeEvent(event)

  return {
    platform: "github",
    adapterId: ADAPTER_ID,
    selfId: SELF_ID,
    messageId: event.deliveryId,
    conversationRef,
    conversationKey,
    sender,
    channel,
    segments: [{ type: "text", text: plainText }],
    plainText,
    mentions: { selfMentioned: false, users: [] },
    timestamp: event.seenAt,
    raw: event,
    channelData: { kind: event.kind, ref: event.ref },
  }
}

function buildRemoteChatId(event: NormalizedGhEvent): string {
  if (event.pr) return `${event.repoFullName}#pr-${event.pr.prNumber}`
  if (event.issue) return `${event.repoFullName}#issue-${event.issue.issueNumber}`
  return event.repoFullName
}

/**
 * Produce a one-line summary suitable for the Inbox preview row.
 */
function describeEvent(event: NormalizedGhEvent): string {
  const sender = event.senderLogin ?? "someone"
  switch (event.kind) {
    case "pull_request.opened":
      return `${sender} opened PR #${event.pr?.prNumber} in ${event.repoFullName}`
    case "pull_request.review_requested":
      return `${sender} requested review on PR #${event.pr?.prNumber} in ${event.repoFullName}`
    case "pull_request.closed":
      return `${sender} closed PR #${event.pr?.prNumber} in ${event.repoFullName}`
    case "issues.opened":
      return `${sender} opened issue #${event.issue?.issueNumber} in ${event.repoFullName}`
    case "issues.assigned":
      return `${sender} was assigned issue #${event.issue?.issueNumber} in ${event.repoFullName}`
    case "issue_comment.created":
      return `${sender} commented on #${event.issue?.issueNumber ?? event.pr?.prNumber} in ${event.repoFullName}`
    default:
      return `${event.kind} on ${event.repoFullName}`
  }
}
