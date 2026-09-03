/**
 * One rule for "is this host-owned configuration the same agent as that local
 * one?", shared by every surface that has to answer it.
 *
 * The rule existed before this module, inline in the settings panel's copy
 * menu, and nowhere else. So the menu correctly refused to copy Pi to the host
 * twice, while the runtime picker happily listed both copies as two unrelated
 * agents: one under "External agents" and one under "Host-owned agents", with
 * the same name, the same protocol and the same binary behind them. On a
 * browser paired to a headless Host both rows even run the process on the SAME
 * machine, so there was nothing a user could read off the list to tell them
 * apart.
 *
 * Two keys, in order:
 *
 *   1. **Provenance.** A copy records the local agent id it came from, so the
 *      pairing survives a rename on either side. This is the durable answer.
 *   2. **Name.** The fallback, and the only key available for configurations
 *      copied before provenance was recorded. It is what the copy menu always
 *      used, kept for exactly that reason.
 *
 * Id is deliberately NOT a key: the host mints its own `eac_*` on import, so a
 * copied agent never carries the local id back in `config.id`.
 */

import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

/**
 * Metadata key holding the local agent id a host configuration was copied from.
 *
 * Lives in `config.metadata`, which is free-form and already carries the
 * ecosystem projection, rather than as a typed column: it is provenance for a
 * UI join, not something admission or readiness may ever read.
 */
export const IMPORTED_FROM_AGENT_ID = "importedFromAgentId"

/** The minimum a local agent has to expose to take part in a pairing. */
export interface PairableLocalAgent {
  id: string
  name?: string
}

/** The local agent a host configuration was copied from, when it recorded one. */
export function hostConfigOriginAgentId(record: ExternalAgentConfigRecord): string | null {
  const metadata = record.config.metadata
  if (!metadata || typeof metadata !== "object") return null
  const value = (metadata as Record<string, unknown>)[IMPORTED_FROM_AGENT_ID]
  return typeof value === "string" && value.length > 0 ? value : null
}

/** Normalized name key. Absent and blank both mean "cannot pair on name". */
function nameKey(name: string | undefined): string | null {
  const trimmed = name?.trim()
  return trimmed ? trimmed.toLocaleLowerCase() : null
}

export interface RuntimePairing<L extends PairableLocalAgent> {
  /** The same agent, held on both sides. */
  paired: Array<{ local: L; host: ExternalAgentConfigRecord }>
  /** Configured here only. These are what the copy menu may offer. */
  localOnly: L[]
  /** Held by the host only. */
  hostOnly: ExternalAgentConfigRecord[]
}

/**
 * Split the two lists into paired, local-only and host-only.
 *
 * A host record pairs with at most one local agent and vice versa: two local
 * agents sharing a name is possible (the store mints a fresh id per add and
 * checks nothing), and pairing both against one host record would render the
 * same host row twice. First match wins, in the order given, so the caller's
 * sort decides which one it is rather than a hash iteration order.
 */
export function pairRuntimeConfigs<L extends PairableLocalAgent>(
  localAgents: readonly L[],
  hostConfigs: readonly ExternalAgentConfigRecord[]
): RuntimePairing<L> {
  const byOrigin = new Map<string, ExternalAgentConfigRecord>()
  const byName = new Map<string, ExternalAgentConfigRecord>()
  for (const record of hostConfigs) {
    const origin = hostConfigOriginAgentId(record)
    if (origin && !byOrigin.has(origin)) byOrigin.set(origin, record)
    const key = nameKey(record.config.name)
    if (key && !byName.has(key)) byName.set(key, record)
  }

  const claimed = new Set<string>()
  const paired: Array<{ local: L; host: ExternalAgentConfigRecord }> = []
  const localOnly: L[] = []

  for (const local of localAgents) {
    const key = nameKey(local.name)
    const match = byOrigin.get(local.id) ?? (key ? byName.get(key) : undefined)
    if (match && !claimed.has(match.configId)) {
      claimed.add(match.configId)
      paired.push({ local, host: match })
      continue
    }
    localOnly.push(local)
  }

  return {
    paired,
    localOnly,
    hostOnly: hostConfigs.filter((record) => !claimed.has(record.configId)),
  }
}
