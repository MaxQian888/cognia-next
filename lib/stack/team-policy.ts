/**
 * When an Agent Team run publishes as a stack.
 *
 * The policy has two flags — `enabled` and `stackedPullRequests` — and three
 * readers, and until this file existed each reader decided for itself what the
 * pair meant: the run tail checked only `enabled`, so it imported and ran the
 * publisher for a policy that would then decline inside; the publisher checked
 * both. The combination "enabled, not stacked" was therefore reachable, cost a
 * dynamic import and a Dexie read per completed run, and did nothing.
 *
 * One predicate, one set of defaults, and the settings switch writes both flags
 * at once so the half-on state cannot be created in the first place.
 */

import type { AgentTeamGithubDeliveryPolicy } from "@/types/agent/agent-team-runtime"

/**
 * What the settings switch writes when stacked delivery is turned on.
 *
 * `minLayers` is floored at 2 by the publisher — one branch is not a stack —
 * and `maxLayers` capped at 100 there. These are defaults, not those limits.
 */
export const STACKED_DELIVERY_DEFAULTS: AgentTeamGithubDeliveryPolicy = {
  enabled: true,
  stackedPullRequests: true,
  minLayers: 2,
  maxLayers: 10,
  mergeMode: "approved-bottom-up",
}

/** Whether a completed run should be published as a stack. */
export function stackedDeliveryOn(policy: AgentTeamGithubDeliveryPolicy | undefined): boolean {
  return policy?.enabled === true && policy.stackedPullRequests === true
}
