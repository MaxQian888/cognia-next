/**
 * One answer to "can this bot do X, and if not, what do I do about it?"
 *
 * `effective-capabilities.ts` already computes the truth, and three surfaces
 * already consumed it — by HIDING themselves. A Slack workspace whose grant is
 * missing `channels:history` lost the "load earlier" bar; a DingTalk bot lost
 * the reply-quoting card entirely; eight of eleven platforms lost the status
 * badge tier from a dropdown. In every case the operator saw an absence, which
 * is indistinguishable from a bug, from a feature that was never built, and
 * from a screen that failed to load.
 *
 * ## Why this is not just `suppressionFor`
 *
 * `suppressionFor` returns `undefined` for two opposite situations: the
 * capability works, and the platform never declared it in the first place.
 * Every hiding site was branching on `hasEffectiveCapability`, which collapses
 * them the same way — and the second case is the majority one. `send.reply` is
 * undeclared on 4 of 11 platforms, `presence.status` on 8, `history.fetch` on
 * 7. So a read-out built only on the five suppression reasons would have
 * nothing to say in exactly the cases that hid the most.
 *
 * `not_declared` is therefore a first-class cause here, and it is the one cause
 * that is honestly terminal: nothing the operator changes will make WeCom quote
 * a message, because WeCom has no reply primitive. Saying that plainly is the
 * whole value — it is a different sentence from "re-authorize" and it must not
 * be dressed up as one.
 */

import type { Capability } from "@/types/connectors/capability"
import type {
  CapabilitySuppression,
  EffectiveCapabilitySnapshot,
} from "@/types/connectors/effective-capability"
import { CAPABILITY_SUPPRESSION_REASONS } from "@/types/connectors/effective-capability"

/**
 * Every reason a capability is not usable, in the order the resolver decides
 * them: the five instance-level suppressions, then "the platform never offered
 * it", which can only be true when none of the others is.
 */
export const CAPABILITY_UNAVAILABLE_CAUSES = [
  ...CAPABILITY_SUPPRESSION_REASONS,
  "not_declared",
] as const

export type CapabilityUnavailableCause = (typeof CAPABILITY_UNAVAILABLE_CAUSES)[number]

/**
 * Causes with a next step the operator can actually take from this app.
 *
 * `scene_unsupported` and `not_declared` are excluded because there is nothing
 * to do — one is a property of where the conversation lives, the other of what
 * the platform implements. Offering a remedy for either would be worse than
 * saying nothing: it would send someone to re-check settings that are already
 * correct.
 */
const ACTIONABLE_CAUSES: ReadonlySet<CapabilityUnavailableCause> = new Set([
  "transport_unsupported",
  "missing_oauth_scope",
  "upstream_impl_unsupported",
  "instance_setting_off",
])

export function isActionableCause(cause: CapabilityUnavailableCause): boolean {
  return ACTIONABLE_CAUSES.has(cause)
}

export interface CapabilityUnavailable {
  available: false
  capability: Capability
  cause: CapabilityUnavailableCause
  /**
   * The suppression's machine-readable specifics (scopes, feature token,
   * setting key, scenes, transports). Absent for `not_declared`, which has no
   * specifics — the platform simply has no such primitive.
   */
  detail?: string
  /** Whether `cause` has a next step; see `ACTIONABLE_CAUSES`. */
  actionable: boolean
}

export interface CapabilityAvailable {
  available: true
  capability: Capability
}

export type CapabilityAvailability = CapabilityAvailable | CapabilityUnavailable

function fromSuppression(entry: CapabilitySuppression): CapabilityUnavailable {
  return {
    available: false,
    capability: entry.capability,
    cause: entry.reason,
    detail: entry.detail,
    actionable: isActionableCause(entry.reason),
  }
}

/**
 * Resolve one capability against a snapshot.
 *
 * Reads `capabilities` rather than recomputing anything, so this can never
 * disagree with the gate the runtime, the model's tool manifest and the
 * delivery path all use — a read-out that contradicted them would be worse
 * than the hiding it replaces.
 */
export function capabilityAvailability(
  snapshot: EffectiveCapabilitySnapshot,
  capability: Capability
): CapabilityAvailability {
  if (snapshot.capabilities.includes(capability)) return { available: true, capability }
  const suppression = snapshot.suppressed.find((entry) => entry.capability === capability)
  if (suppression) return fromSuppression(suppression)
  return { available: false, capability, cause: "not_declared", actionable: false }
}
