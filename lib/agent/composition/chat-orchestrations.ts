/**
 * Which executors the main chat surface can actually run, and why not for the
 * rest.
 *
 * `resolveComposition` already knows how to narrow an unsupported orchestration
 * down to `direct` with a warning (`supportedOrchestrations`), but no chat
 * caller ever told it what this surface supports, so every policy looked
 * selectable and three of them did nothing. Picking "Workflow" in the composer
 * ran an ordinary single-agent turn and said so nowhere.
 *
 * The unsupported policies are not equivalent, and the UI should not pretend
 * they are:
 *
 *  - `subagent` and `workflow` are real and reachable, through `@mention` and
 *    `/workflow` respectively. They are simply not driven from this axis, so
 *    the honest thing is to name the way in, not to hide them.
 *  - `verified-fresh-agent` runs from this axis (`armVerifiedFreshAgentFollowup`
 *    in `./verified-fresh-agent`), but only on a shell that owns the sidecar.
 *    On a companion shell it stays visible and disabled with that reason, and
 *    the follow-up refuses to arm with the same reason.
 *
 * Keep this list in step with what actually consumes the axis. Adding a policy
 * here without a consumer re-creates exactly the dormant control it removes.
 */

import {
  AGENT_ORCHESTRATION_POLICIES,
  type AgentOrchestrationPolicy,
} from "@cognia/agent-config-types/agent-composition"
import type { HostProfile } from "@/lib/platform/capabilities"
import { verificationAvailableOn } from "./verified-fresh-agent"

/**
 * Executors a chat turn can be handed to today.
 *
 * `direct` is the ordinary single-agent turn. `team` routes through
 * `startSquadRun`, and `verified-fresh-agent` arms an independent verifier
 * after the direct turn. Both are wired in `use-claude-chat-controller`.
 */
export const CHAT_SUPPORTED_ORCHESTRATIONS: readonly AgentOrchestrationPolicy[] = [
  "direct",
  "team",
  "verified-fresh-agent",
]

/** Why a policy is not selectable here. Each maps to its own i18n hint. */
export type OrchestrationUnavailableReason =
  "viaMention" | "viaSlashCommand" | "notImplemented" | "companionShell"

const REASONS: Partial<Record<AgentOrchestrationPolicy, OrchestrationUnavailableReason>> = {
  subagent: "viaMention",
  workflow: "viaSlashCommand",
}

export interface OrchestrationAvailabilityContext {
  /** The shell asking. Absent means "assume a shell that owns the sidecar". */
  hostProfile?: HostProfile
}

/**
 * `null` when the policy is selectable in chat. Never invents a reason for a
 * supported policy, so the two halves cannot drift apart. A supported policy
 * can still be unavailable on THIS shell, which is the one case where the
 * answer depends on more than the policy.
 */
export function chatOrchestrationUnavailableReason(
  policy: AgentOrchestrationPolicy,
  context: OrchestrationAvailabilityContext = {}
): OrchestrationUnavailableReason | null {
  if (CHAT_SUPPORTED_ORCHESTRATIONS.includes(policy)) {
    if (
      policy === "verified-fresh-agent" &&
      context.hostProfile &&
      !verificationAvailableOn(context.hostProfile)
    ) {
      return "companionShell"
    }
    return null
  }
  return REASONS[policy] ?? "notImplemented"
}

/** Every policy, in declaration order. Supported ones first is NOT assumed. */
export function allOrchestrations(): readonly AgentOrchestrationPolicy[] {
  return AGENT_ORCHESTRATION_POLICIES
}
