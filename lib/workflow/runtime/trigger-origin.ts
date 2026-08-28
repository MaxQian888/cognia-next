/**
 * Who and where is driving the current turn, as a `WorkflowTriggeredFrom`.
 *
 * A workflow started from inside an IM conversation has to carry two facts
 * the caller cannot invent: the conversation it belongs to, and the VERIFIED
 * human whose message is driving this turn. The second is the security-
 * relevant one — the initiator feeds both the run's `initiator` field and the
 * actor scope on any approval binding the run creates, and the callback
 * authorization guard only lets that user (or a configured operator) tap
 * Approve. Derived wrongly, an approval button becomes tappable by the wrong
 * person.
 *
 * This lived inside the workflow-ai plugin, reading `getDb().sessions` and
 * `getDb().connectorInboundJobs` directly. It belongs to the host: a second
 * implementation is a second chance to widen the scope by accident.
 */

import { getDb } from "@/lib/db/schema"
import type { CallbackActorScope } from "@/types/connectors/interaction"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"

/**
 * The conversation's `running` inbound job carries the verified sender, plus
 * the resolved principal/account stamp when the identity registry is on. Only
 * the most recent running job counts: an older one is a turn that already
 * finished, and attributing to it would credit the wrong human.
 */
async function resolveTurnInitiator(
  conversationKey: string
): Promise<Pick<WorkflowTriggeredFrom, "initiator">> {
  const jobs = await getDb()
    .connectorInboundJobs.where("conversationKey")
    .equals(conversationKey)
    .filter((row) => row.status === "running")
    .toArray()
  const current = jobs.sort((a, b) => b.receivedAt - a.receivedAt)[0]
  if (!current) return {}
  const sender = current.event.sender
  return {
    initiator: {
      platformIdentityId: sender.id,
      remoteUserId: sender.remoteUserId,
      displayName: sender.displayName,
      ...(current.principalId && current.accountId
        ? { principalId: current.principalId, accountId: current.accountId }
        : {}),
    },
  }
}

/**
 * `null` when the session is absent or is not bound to an IM conversation —
 * i.e. the run was started from the editor, and there is no remote origin to
 * attribute it to.
 */
export async function resolveWorkflowTriggerOrigin(
  sessionId: string | undefined
): Promise<WorkflowTriggeredFrom | null> {
  if (!sessionId) return null
  const session = await getDb().sessions.get(sessionId)
  const binding = session?.platformBinding
  if (!binding) return null
  return {
    source: "im",
    adapterId: binding.adapterId,
    conversationKey: binding.conversationKey,
    sessionId,
    ...(await resolveTurnInitiator(binding.conversationKey)),
  }
}

/**
 * Actor scope for an approval binding: the turn initiator when there is one,
 * otherwise operators. Never "anyone" — an approval nobody is named on is one
 * any reader of the conversation can tap.
 */
export function approvalActorScope(triggeredFrom: WorkflowTriggeredFrom): CallbackActorScope {
  const initiatorId = triggeredFrom.initiator?.remoteUserId
  return initiatorId ? { mode: "initiator", allowedUserIds: [initiatorId] } : { mode: "operators" }
}
