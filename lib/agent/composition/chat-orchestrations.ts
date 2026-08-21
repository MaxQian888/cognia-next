/**
 * Which executors the main chat surface can actually run, and why not for the
 * rest.
 *
 * `resolveComposition` already knows how to narrow an unsupported orchestration
 * down to `direct` with a warning (`supportedOrchestrations`), but no chat
 * caller ever told it what this surface supports — so every policy looked
 * selectable and three of them did nothing. Picking "Workflow" in the composer
 * ran an ordinary single-agent turn and said so nowhere.
 *
 * The three unsupported policies are not equivalent, and the UI should not
 * pretend they are:
 *
 *  - `subagent` and `workflow` are real and reachable — through `@mention` and
 *    `/workflow` respectively. They are simply not driven from this axis, so
 *    the honest thing is to name the way in, not to hide them.
 *  - `verified-fresh-agent` has no implementation anywhere in the repo. It
 *    exists only in the type. Saying "not yet" is the only true label.
 *
 * Keep this list in step with what actually consumes the axis. Adding a policy
 * here without a consumer re-creates exactly the dormant control it removes.
 */

import {
  AGENT_ORCHESTRATION_POLICIES,
  type AgentOrchestrationPolicy,
} from "@cognia/agent-config-types/agent-composition"

/**
 * Executors a chat turn can be handed to today.
 *
 * `direct` is the ordinary single-agent turn. `team` routes through
 * `startSquadRun`, which is wired in `use-claude-chat-controller`.
 */
export const CHAT_SUPPORTED_ORCHESTRATIONS: readonly AgentOrchestrationPolicy[] = ["direct", "team"]

/** Why a policy is not selectable here. Each maps to its own i18n hint. */
export type OrchestrationUnavailableReason = "viaMention" | "viaSlashCommand" | "notImplemented"

const REASONS: Partial<Record<AgentOrchestrationPolicy, OrchestrationUnavailableReason>> = {
  subagent: "viaMention",
  workflow: "viaSlashCommand",
  "verified-fresh-agent": "notImplemented",
}

/**
 * `null` when the policy is selectable in chat. Never invents a reason for a
 * supported policy, so the two halves cannot drift apart.
 */
export function chatOrchestrationUnavailableReason(
  policy: AgentOrchestrationPolicy
): OrchestrationUnavailableReason | null {
  if (CHAT_SUPPORTED_ORCHESTRATIONS.includes(policy)) return null
  return REASONS[policy] ?? "notImplemented"
}

/** Every policy, in declaration order — supported ones first is NOT assumed. */
export function allOrchestrations(): readonly AgentOrchestrationPolicy[] {
  return AGENT_ORCHESTRATION_POLICIES
}
