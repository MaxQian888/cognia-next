/**
 * Route an external agent's blocking decisions into the chat surface.
 *
 * The Composer's external branch streamed events through
 * `applyExternalAgentEventToParts`, which deliberately does NOT turn a
 * `permission_request` into a message part — its docstring says the caller
 * routes those "through dedicated UI channels (e.g. the existing
 * pendingApprovals store)". Nothing did. So on the chat surface an external
 * agent that asked for permission got no dialog and no answer: the adapter
 * waited until its own timeout and the turn stalled. The only working decision
 * UI lived on the External Agents manager page, which a user in the Composer is
 * not looking at.
 *
 * This matters most for Pi, whose native `edit` / `write` / `bash` calls are
 * intercepted by the bundled Cognia extension precisely so they can be asked
 * about (ADR-0119). Under `default` or `acceptEdits`, "ask" is the expected
 * verdict for those tools, so the unanswered path was the common path.
 *
 * The same is true of `elicitation_request` — the question a Pi `confirm` /
 * `select` / `input` / `editor` call arrives as. Both kinds are handled here,
 * but they ride different transports on purpose: an approval is a
 * `PendingApproval` and joins the chat store's existing per-session queue
 * (which already gives it the durable journal and the attention sorting),
 * while an elicitation carries a schema the chat store has no shape for and
 * lives in its own small store instead of widening a slice five call sites
 * deep.
 *
 * The shape here is the one the two existing in-renderer approval families
 * already use (`lib/skills/built-in/desktop-hitl.ts`,
 * `lib/voice/live/approval.ts`): a prefixed requestId that
 * `respondToApproval` recognises and resolves locally, and which must never
 * reach `approveTool` — there is no sidecar-side waiter for these, so
 * forwarding one would hang the dialog and leave the agent waiting anyway.
 *
 * `allow_always` gets the same treatment as the voice path, for the same
 * reason: `deriveAllowRuleFromApproval` writes rules the **sidecar** consumes,
 * and an external agent never talks to the sidecar. Persisting a grant there
 * would record the user's choice and then ignore it forever. Instead the
 * remembered choice is expressed in the protocol the agent actually speaks —
 * an `allow_always` option when the agent offers one, plus
 * `rememberChoice`/`scope` on the response.
 */

import type {
  AcpElicitationResponse,
  AcpPermissionOption,
  AcpPermissionResponse,
  ExternalAgentElicitationRequestEvent,
  ExternalAgentPermissionRequestEvent,
} from "@/types/agent/external-agent"
import type { PendingExternalElicitation } from "@/stores/agent/external-elicitation-store"
import type { ApprovalDecision, PendingApproval } from "@cognia/agent-config-types"

/**
 * Marks a requestId as belonging to an external agent session.
 * `respondToApproval` branches on this and answers the adapter directly.
 */
export const EXTERNAL_AGENT_APPROVAL_PREFIX = "external-agent:"

export function isExternalAgentApprovalRequestId(requestId: string): boolean {
  return requestId.startsWith(EXTERNAL_AGENT_APPROVAL_PREFIX)
}

/** Where an answer has to be delivered, captured when the request arrives. */
export interface ExternalApprovalTarget {
  /** The manager's agent id — `respondToPermission`'s first argument. */
  agentId: string
  /**
   * The agent's OWN session id, which is not the chat session id. The answer
   * goes to the session that asked, so a user switching panes mid-turn cannot
   * misroute it.
   */
  externalSessionId: string
  /** The id the adapter is waiting on (`request.requestId ?? request.id`). */
  responseRequestId: string
  /** The chat session whose pane shows the dialog; used only for cleanup. */
  chatSessionId: string
  options?: AcpPermissionOption[]
  /**
   * Set when the agent is running on a paired HOST rather than in this shell.
   *
   * The answer then cannot go through the local manager — there is no adapter
   * here to hand it to — so it travels as `external_agent_resolve_decision`
   * instead. Its presence is what the caller branches on; everything else about
   * the entry, including the dialog it renders, is identical.
   */
  remoteDecisionId?: string
}

const targets = new Map<string, ExternalApprovalTarget>()

/**
 * The chat-side requestId for one external request.
 *
 * The agent's own id is embedded rather than replaced by a random one so a
 * duplicate request (an adapter that re-emits after a reconnect) collapses onto
 * the same pending entry instead of stacking a second identical dialog.
 */
export function externalApprovalRequestId(agentId: string, responseRequestId: string): string {
  return `${EXTERNAL_AGENT_APPROVAL_PREFIX}${agentId}:${responseRequestId}`
}

/**
 * Pick the option id to send for a decision.
 *
 * ACP agents advertise their own option ids and some adapters require one; when
 * the agent offers no options at all the boolean `granted` carries the answer.
 * `allow_always` falls back to `allow_once` rather than to nothing: the user
 * asked to proceed, and losing the "always" nuance is better than losing the
 * approval.
 */
export function pickPermissionOptionId(
  decision: ApprovalDecision,
  options?: AcpPermissionOption[]
): string | undefined {
  if (!options?.length) return undefined
  const byKind = (kind: string) => options.find((opt) => opt.kind === kind)?.optionId

  if (decision === "deny") {
    return byKind("reject_once") ?? byKind("reject_always")
  }
  if (decision === "allow_always") {
    return byKind("allow_always") ?? byKind("allow_once")
  }
  // A default-marked allow is the agent's own recommendation; prefer it.
  const defaultAllow = options.find((opt) => opt.isDefault && opt.kind.startsWith("allow"))
  return defaultAllow?.optionId ?? byKind("allow_once") ?? byKind("allow_always")
}

/** The response to hand `respondToPermission` for a decision. */
export function toPermissionResponse(
  decision: ApprovalDecision,
  target: ExternalApprovalTarget
): AcpPermissionResponse {
  return {
    requestId: target.responseRequestId,
    granted: decision !== "deny",
    // Expressed in the agent's protocol, not in the sidecar ruleset the agent
    // cannot read. "session" rather than "always": a click in a chat pane is
    // consent for this conversation, and a persistent cross-session grant to a
    // third-party agent process should be a deliberate settings action.
    ...(decision === "allow_always" ? { rememberChoice: true, scope: "session" as const } : {}),
    optionId: pickPermissionOptionId(decision, target.options),
  }
}

/**
 * Build the chat-store entry for an incoming request, and remember where the
 * answer must go. Returns `null` when the event carries no usable id — an
 * approval with no id could never be answered, so surfacing a dialog for it
 * would be a dead end that blocks the pane.
 */
export function registerExternalApproval(params: {
  agentId: string
  chatSessionId: string
  event: ExternalAgentPermissionRequestEvent
  /** See `ExternalApprovalTarget.remoteDecisionId`. */
  remoteDecisionId?: string
}): PendingApproval | null {
  const { agentId, chatSessionId, event, remoteDecisionId } = params
  const request = event.request
  const responseRequestId = request.requestId || request.id
  if (!responseRequestId) return null

  const requestId = externalApprovalRequestId(agentId, responseRequestId)
  targets.set(requestId, {
    agentId,
    // `event.sessionId` is the agent's session; fall back to the request's own
    // copy before the chat id, which would be the wrong process entirely.
    externalSessionId: event.sessionId || request.sessionId || chatSessionId,
    responseRequestId,
    chatSessionId,
    options: request.options,
    ...(remoteDecisionId ? { remoteDecisionId } : {}),
  })

  return {
    // The dialog is rendered per chat session, so this must be the CHAT id or
    // the card never appears in the pane the user is looking at.
    sessionId: chatSessionId,
    requestId,
    toolUseID: request.toolCallId ?? responseRequestId,
    toolName: request.toolInfo?.name ?? "unknown",
    input: request.rawInput ?? request.toolInfo?.parameters ?? {},
    title: request.title,
    displayName: request.toolInfo?.name,
    description: request.toolInfo?.description ?? request.reason,
    status: "pending",
  }
}

/** The recorded target for a chat-side requestId, if it is still pending. */
export function getExternalApprovalTarget(requestId: string): ExternalApprovalTarget | undefined {
  return targets.get(requestId)
}

/**
 * Answer one external approval. Returns false when the id is unknown — the
 * caller then leaves the entry mounted rather than silently dropping it, so a
 * request that outlived its registry entry is visible instead of invisible.
 */
export async function resolveExternalApproval(
  requestId: string,
  decision: ApprovalDecision,
  respond: (agentId: string, sessionId: string, response: AcpPermissionResponse) => Promise<void>
): Promise<boolean> {
  const target = targets.get(requestId)
  if (!target) return false
  await respond(target.agentId, target.externalSessionId, toPermissionResponse(decision, target))
  targets.delete(requestId)
  return true
}

/**
 * Drop every pending target for a chat session.
 *
 * Called when a turn ends or a session closes: the adapter's waiter is gone, so
 * an entry left behind would be an unanswerable dialog pinned over the pane.
 * Returns the chat-side request ids so the caller can clear the store entries
 * it pushed.
 */
export function releaseExternalApprovals(chatSessionId: string): string[] {
  const released: string[] = []
  for (const [requestId, target] of targets) {
    if (target.chatSessionId !== chatSessionId) continue
    released.push(requestId)
    targets.delete(requestId)
  }
  return released
}

/** Test seam: forget every registration. */
export function __resetExternalApprovalsForTests(): void {
  targets.clear()
}

// ---- Elicitations ----------------------------------------------------------

/**
 * Record a question and return the entry the pane should render, or `null`
 * when the request carries no id to answer with.
 *
 * Unlike an approval this needs no id rewriting: the elicitation dialog is a
 * dedicated component reading a dedicated store, so nothing has to distinguish
 * these ids from the sidecar's.
 */
export function registerExternalElicitation(params: {
  agentId: string
  chatSessionId: string
  event: ExternalAgentElicitationRequestEvent
  /** See `ExternalApprovalTarget.remoteDecisionId`. */
  remoteDecisionId?: string
}): PendingExternalElicitation | null {
  const { agentId, chatSessionId, event, remoteDecisionId } = params
  if (!event.request?.id) return null
  return {
    chatSessionId,
    agentId,
    request: event.request,
    ...(remoteDecisionId ? { remoteDecisionId } : {}),
  }
}

/**
 * Answer one question.
 *
 * A dismissal is a `cancel`, never a `decline` — the agent reads decline as a
 * deliberate "no" and cancel as "the user walked away". The dialog already
 * makes that distinction; this only has to preserve it.
 */
export async function resolveExternalElicitation(
  entry: PendingExternalElicitation,
  response: AcpElicitationResponse,
  respond: (agentId: string, response: AcpElicitationResponse) => Promise<void>
): Promise<void> {
  await respond(entry.agentId, response)
}

/**
 * Deliver one answer to wherever the agent actually is.
 *
 * Both shells that render the dialog call this instead of reaching for the
 * manager themselves: the branch is one fact — is this agent in this process
 * or on a paired host — and having it in two places is how the two shells
 * would eventually disagree.
 *
 * Best-effort by contract. The dialog clears the question before the answer is
 * in flight (so a second click cannot answer twice), so there is no card left
 * to put an error on, and an agent that has already gone is the ordinary case.
 */
export async function deliverExternalElicitation(
  entry: PendingExternalElicitation,
  response: AcpElicitationResponse
): Promise<void> {
  try {
    if (entry.remoteDecisionId) {
      const { resolveRemoteElicitation } = await import("./remote-run-client")
      await resolveRemoteElicitation(entry.remoteDecisionId, response)
      return
    }
    const { getExternalAgentManager } = await import("./manager")
    await getExternalAgentManager().respondToElicitation(entry.agentId, response)
  } catch {
    // See the docstring.
  }
}

/**
 * The response to send when a turn ends with a question still on screen.
 *
 * `cancel` rather than `decline` for the same reason as a dismissal: the user
 * never answered. Sent on a best-effort basis — the adapter is usually already
 * gone, which is why the caller ignores the failure.
 */
export function elicitationCancelResponse(
  entry: PendingExternalElicitation
): AcpElicitationResponse {
  return { requestId: entry.request.id, action: "cancel" }
}
