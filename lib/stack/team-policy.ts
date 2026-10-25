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

// ── A person's consent to unattended publishing (ADR-0239 phase 2) ─────────

/** The config fields consent reads: the policy and the repository bindings. */
type DeliveryConfig = {
  githubDeliveryPolicy?: AgentTeamGithubDeliveryPolicy
  repositories?: ReadonlyArray<{ path: string }>
  workingDir?: string
}

/** The paths a team publishes from: its repository bindings, else its working directory. */
export function teamBindingPaths(config: DeliveryConfig): string[] {
  if (config.repositories && config.repositories.length > 0) {
    return config.repositories.map((binding) => binding.path)
  }
  return config.workingDir ? [config.workingDir] : []
}

/** The config without a consent record, for anything a person did not flip on here. */
export function withoutDeliveryConsent<T extends DeliveryConfig>(config: T): T {
  const policy = config.githubDeliveryPolicy
  if (!policy || !("consent" in policy)) return config
  const { consent: _dropped, ...rest } = policy
  return { ...config, githubDeliveryPolicy: rest }
}

/**
 * The next config with the consent the previous one held: an edit cannot
 * write consent, and keeps a person's while stacked delivery stays on.
 * Turning it off drops it, so turning it back on asks again.
 */
export function carryDeliveryConsent<T extends DeliveryConfig>(
  previous: DeliveryConfig,
  next: T
): T {
  const stripped = withoutDeliveryConsent(next)
  const consent = previous.githubDeliveryPolicy?.consent
  if (!consent || !stackedDeliveryOn(stripped.githubDeliveryPolicy)) return stripped
  return {
    ...stripped,
    githubDeliveryPolicy: { ...stripped.githubDeliveryPolicy!, consent },
  }
}

/**
 * The config with a person's consent for the repositories bound now, or
 * unchanged when stacked delivery is off. Called only from a person's switch.
 */
export function withDeliveryConsent<T extends DeliveryConfig>(config: T, at: number): T {
  const policy = config.githubDeliveryPolicy
  if (!policy || !stackedDeliveryOn(policy)) return config
  return {
    ...config,
    githubDeliveryPolicy: {
      ...policy,
      consent: { by: "local-user", at, repositoryPaths: teamBindingPaths(config) },
    },
  }
}

/** The binding paths a person consented to publish from, or none. */
export function consentedRepositoryPaths(config: DeliveryConfig): ReadonlySet<string> {
  const policy = config.githubDeliveryPolicy
  const consent = policy?.consent
  if (!stackedDeliveryOn(policy) || consent?.by !== "local-user") return new Set()
  return new Set(Array.isArray(consent.repositoryPaths) ? consent.repositoryPaths : [])
}
