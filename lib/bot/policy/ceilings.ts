/**
 * Intersect every Bot policy layer into one ceiling.
 *
 * The rule the whole Bot control plane rests on: a lower layer may only
 * NARROW. An organisation policy, the plugin's own declaration, the definition,
 * the installation's grant and the individual run request each get a say, and
 * the answer is the strictest of them. Nothing here can widen anything, which
 * is why the fold is a fold and not a merge.
 *
 * Authority and autonomy reuse `narrowAuthority` and `narrowAutonomy` from
 * ADR-0117 rather than reimplementing rank comparison, and autonomy feeds
 * `autonomyAuthorityCap` as one more authority ceiling in the same fold, so a
 * Bot cannot ask for `observe` autonomy and `bypassPermissions` authority.
 */

import {
  autonomyAuthorityCap,
  narrowAuthority,
  narrowAutonomy,
  type AgentAuthority,
  type AutonomyLevel,
} from "@cognia/agent-config-types/agent-composition"

import type { PluginBotPolicyV1 } from "@/types/plugin/plugin-bot"

/**
 * The layers, outermost first. Order is the audit story, not the arithmetic:
 * intersection is commutative, but "which layer set this" is what a user needs
 * when a Bot refuses to do something.
 */
export const BOT_POLICY_LAYERS = [
  "organization",
  "plugin",
  "definition",
  "installation",
  "request",
] as const

export type BotPolicyLayerName = (typeof BOT_POLICY_LAYERS)[number]

export interface BotPolicyLayer {
  name: BotPolicyLayerName
  policy?: PluginBotPolicyV1
}

/**
 * Which layer supplied each resolved value.
 *
 * `undefined` means no layer had an opinion, which is a different answer from
 * "the default won" and is why the map is partial rather than defaulted.
 */
export type BotPolicyProvenance = Partial<Record<keyof PluginBotPolicyV1, BotPolicyLayerName>>

export interface ResolvedBotPolicy {
  /** The effective ceiling. Every field is the strictest any layer asked for. */
  policy: PluginBotPolicyV1
  provenance: BotPolicyProvenance
  /**
   * Layers that asked to widen something and were overruled, for the settings
   * UI. An escalation is refused, never recorded as a value.
   */
  refusals: Array<{ layer: BotPolicyLayerName; field: keyof PluginBotPolicyV1 }>
}

/** The strictest of two optional numbers. Absent means "no ceiling". */
function narrowMax(current: number | undefined, incoming: number | undefined): number | undefined {
  if (incoming === undefined) return current
  if (current === undefined) return incoming
  return Math.min(current, incoming)
}

export function resolveBotPolicy(layers: readonly BotPolicyLayer[]): ResolvedBotPolicy {
  const policy: PluginBotPolicyV1 = {}
  const provenance: BotPolicyProvenance = {}
  const refusals: ResolvedBotPolicy["refusals"] = []

  const note = (field: keyof PluginBotPolicyV1, layer: BotPolicyLayerName) => {
    provenance[field] = layer
  }
  const refuse = (field: keyof PluginBotPolicyV1, layer: BotPolicyLayerName) => {
    refusals.push({ layer, field })
  }

  for (const { name, policy: incoming } of layers) {
    if (!incoming) continue

    if (incoming.maxAuthority !== undefined) {
      const before = policy.maxAuthority
      const next = (
        before === undefined
          ? incoming.maxAuthority
          : narrowAuthority(before, incoming.maxAuthority)
      ) as AgentAuthority
      if (before !== undefined && next === before && incoming.maxAuthority !== before) {
        refuse("maxAuthority", name)
      } else if (next !== before) {
        note("maxAuthority", name)
      }
      policy.maxAuthority = next
    }

    if (incoming.maxAutonomy !== undefined) {
      const before = policy.maxAutonomy
      const next = (
        before === undefined ? incoming.maxAutonomy : narrowAutonomy(before, incoming.maxAutonomy)
      ) as AutonomyLevel
      if (before !== undefined && next === before && incoming.maxAutonomy !== before) {
        refuse("maxAutonomy", name)
      } else if (next !== before) {
        note("maxAutonomy", name)
      }
      policy.maxAutonomy = next
    }

    // Requiring approval is a tightening, so any layer that asks for it wins
    // and no layer can turn it back off.
    if (incoming.requireApprovalForWrites === true && policy.requireApprovalForWrites !== true) {
      policy.requireApprovalForWrites = true
      note("requireApprovalForWrites", name)
    } else if (incoming.requireApprovalForWrites === false && policy.requireApprovalForWrites) {
      refuse("requireApprovalForWrites", name)
    }

    for (const field of ["maxRunDurationMs", "maxRunCostUsd", "maxConcurrentRuns"] as const) {
      if (incoming[field] === undefined) continue
      const before = policy[field]
      const next = narrowMax(before, incoming[field])
      if (before !== undefined && next === before && incoming[field] !== before) {
        refuse(field, name)
      } else if (next !== before) {
        note(field, name)
      }
      policy[field] = next
    }

    // Self-triggering is off unless EVERY layer that has an opinion allows it.
    // A Bot that answers its own comments is a loop, so the safe answer has to
    // be the one a silent layer produces.
    if (incoming.allowSelfTriggering === false && policy.allowSelfTriggering !== false) {
      policy.allowSelfTriggering = false
      note("allowSelfTriggering", name)
    } else if (incoming.allowSelfTriggering === true) {
      if (policy.allowSelfTriggering === false) {
        refuse("allowSelfTriggering", name)
      } else if (policy.allowSelfTriggering === undefined) {
        policy.allowSelfTriggering = true
        note("allowSelfTriggering", name)
      }
    }
  }

  // Autonomy caps authority as one more ceiling, in the same fold rather than
  // at a second enforcement point.
  if (policy.maxAutonomy !== undefined) {
    const cap = autonomyAuthorityCap(policy.maxAutonomy)
    if (cap !== undefined) {
      const capped = narrowAuthority(cap, policy.maxAuthority) as AgentAuthority
      if (capped !== policy.maxAuthority) {
        policy.maxAuthority = capped
        provenance.maxAuthority = provenance.maxAutonomy
      }
    }
  }

  return { policy, provenance, refusals }
}

/** Does the resolved ceiling permit a run this Bot's own activity produced? */
export function allowsSelfTriggering(policy: PluginBotPolicyV1): boolean {
  return policy.allowSelfTriggering === true
}
