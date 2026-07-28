/**
 * Unread-message predicate for the team workspace.
 *
 * `AgentTeamMessage.read` and the store's `markMessageRead` /
 * `markAllMessagesRead` / `markTeamMessagesRead` / `getUnreadMessages` have
 * existed since the store was written but had no consumer — the flag was
 * maintained and never read. This module is the single definition of what
 * "unread" means, so the tab badge and the in-thread divider can never disagree.
 *
 * Two rules, both load-bearing:
 *
 * 1. The user's own messages are written with `read: true` by the dispatcher,
 *    so they fall out naturally — you cannot have unread of something you sent.
 *
 * 2. A message that is still streaming does NOT count. `writeProgress` in
 *    `team-runtime-dispatcher` re-upserts the placeholder on every delta and
 *    that placeholder hard-codes `read: false`, so a live reply would flip back
 *    to unread on every token. Counting it would make the badge flicker during
 *    a run and, worse, make a "mark read while the chat tab is open" effect fire
 *    once per token — a store write per token, which is exactly the load the
 *    workspace's tab-gated selectors exist to avoid. The final write drops the
 *    streaming flag, so a finished reply becomes unread the moment it lands.
 */

import { TEAM_MESSAGE_METADATA_KEYS } from "@/lib/agent-team/team-runtime-dispatcher"
import type { AgentTeamMessage } from "@/types/agent/agent-team"

/** True when `msg` is a settled, not-yet-read message. */
export function isUnread(msg: AgentTeamMessage): boolean {
  if (msg.read) return false
  return msg.metadata?.[TEAM_MESSAGE_METADATA_KEYS.STREAMING] !== true
}

/**
 * Count unread messages for one team.
 *
 * Deliberately returns a number rather than the matching messages: the
 * workspace subscribes to this on every store delta (one per streamed token
 * during a live run) and a scalar lets zustand bail out of the re-render unless
 * the count actually moves. Returning an array would allocate a new reference
 * per token and re-render the whole shell — the trap that the tab-gated
 * `tasks` / `messages` / `events` selectors were introduced to close.
 */
export function countUnread(
  messages: Record<string, AgentTeamMessage>,
  teamId: string | null | undefined
): number {
  if (!teamId) return 0
  let n = 0
  for (const id in messages) {
    const msg = messages[id]
    if (msg.teamId === teamId && isUnread(msg)) n += 1
  }
  return n
}

/**
 * Id of the first unread message in an already-ordered thread, or `undefined`
 * when everything is read. The chat view anchors its "new messages" divider
 * above this id.
 */
export function firstUnreadId(messages: readonly AgentTeamMessage[]): string | undefined {
  for (const msg of messages) {
    if (isUnread(msg)) return msg.id
  }
  return undefined
}
