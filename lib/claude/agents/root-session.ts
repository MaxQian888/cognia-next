/**
 * The session a person is actually looking at, for any session an agent runs in.
 *
 * Three kinds of session never open in a pane of their own:
 *
 * - a team room member's sub-session (`<team>::char::<member>::<turn>`),
 *   whose root is the team session;
 * - a dispatched subagent's ephemeral session, whose route names the chat
 *   session that dispatched it;
 * - a subagent dispatched by another subagent, whose parent is itself
 *   ephemeral. Its route carries the root recorded at dispatch time, so the
 *   chain still resolves after the middle run has finished and cleared its
 *   own route (a backgrounded grandchild routinely outlives its parent).
 *
 * Approvals bucket under the root (`stores/chat/chat-store.ts`), and the
 * outbound policy engine (ADR-0239) scopes its fence and instruction grants to
 * it, so a subagent and a teammate of the same request share one fence.
 *
 * An Agent Team run (`lib/ai/agent/team/`) executes under its run id, which is
 * not a session id; its root is the team's `sessionId`, which the caller reads
 * from the team record.
 */

import { decodeSubSession } from "@/lib/claude/team-session-id"

import { getSubagentApprovalRoute } from "./subagent-approval-routes"

/** Deeper than any dispatch nesting the settings allow; a cycle guard, not a limit. */
const MAX_HOPS = 32

/** The root session of `sessionId`; `sessionId` itself when it is a root. */
export function resolveRootSessionId(sessionId: string): string {
  const seen = new Set<string>()
  let current = sessionId
  for (let hop = 0; hop < MAX_HOPS && !seen.has(current); hop += 1) {
    seen.add(current)
    const team = decodeSubSession(current)?.teamSessionId
    if (team) {
      current = team
      continue
    }
    const route = getSubagentApprovalRoute(current)
    if (route) {
      current = route.rootSessionId ?? route.parentSessionId
      continue
    }
    return current
  }
  return current
}
