/**
 * Lookup and filtering over the generated command index.
 *
 * Everything here is pure and synchronous: the index is a compiled-in table,
 * so `api list` / `api describe` / the derived `<group> <action>` dispatcher
 * all answer without a host and without a network round trip. That is what
 * makes `--help` honest offline and lets a malformed call fail locally.
 */

import { API_COMMANDS } from "./generated/command-index"
import type { ApiCommandEntry, ApiCommandFlag, ApiWire } from "./types"

export { API_COMMANDS }
export type { ApiCommandEntry, ApiCommandFlag, ApiWire }

const BY_NAME = new Map<string, ApiCommandEntry>(API_COMMANDS.map((entry) => [entry.name, entry]))

const BY_GROUP_ACTION = new Map<string, ApiCommandEntry>(
  API_COMMANDS.map((entry) => [`${entry.group} ${entry.action}`, entry])
)

/** Exact wire-name lookup (`plugin_list`). */
export function findCommand(name: string): ApiCommandEntry | undefined {
  return BY_NAME.get(name)
}

/**
 * Resource-style lookup (`plugin` + `list`). Also accepts the wire name in
 * the group slot so `api call plugin_list` and `plugin list` share one path.
 */
export function findByGroupAction(group: string, action: string): ApiCommandEntry | undefined {
  const direct = BY_GROUP_ACTION.get(`${group} ${action}`)
  if (direct) return direct
  return action.length === 0 ? BY_NAME.get(group) : undefined
}

/** Every distinct group, with how many commands each carries. Sorted by name. */
export function commandGroups(wire?: ApiWire): Array<{ group: string; count: number }> {
  const counts = new Map<string, number>()
  for (const entry of API_COMMANDS) {
    if (wire && !entry.wires.includes(wire)) continue
    counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0))
}

export interface CommandFilter {
  group?: string
  wire?: ApiWire
  capability?: string
  risk?: ApiCommandEntry["risk"]
  approval?: ApiCommandEntry["approval"]
  /** Case-insensitive substring over name and description. */
  search?: string
}

export function listCommands(filter: CommandFilter = {}): ApiCommandEntry[] {
  const needle = filter.search?.toLowerCase()
  return API_COMMANDS.filter((entry) => {
    if (filter.group && entry.group !== filter.group) return false
    if (filter.wire && !entry.wires.includes(filter.wire)) return false
    if (filter.capability && entry.capability !== filter.capability) return false
    if (filter.risk && entry.risk !== filter.risk) return false
    if (filter.approval && entry.approval !== filter.approval) return false
    if (needle) {
      const haystack = `${entry.name} ${entry.description ?? ""}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

/** The flag a caller types, resolved back to the request-body property name. */
export function flagToProperty(entry: ApiCommandEntry, flag: string): ApiCommandFlag | undefined {
  return entry.flags.find((candidate) => candidate.flag.length > 0 && candidate.flag === flag)
}

/**
 * Suggestions for an unknown command, ranked by shared prefix length. Feeds
 * the `Fix:` line, which is the part of a failure an agent actually reads.
 */
export function suggestCommands(name: string, limit = 5): string[] {
  const needle = name.toLowerCase().replace(/-/g, "_")
  const scored: Array<{ name: string; score: number }> = []
  for (const entry of API_COMMANDS) {
    const candidate = entry.name.toLowerCase()
    if (candidate.includes(needle) || needle.includes(candidate)) {
      scored.push({ name: entry.name, score: 1000 - Math.abs(candidate.length - needle.length) })
      continue
    }
    let shared = 0
    while (
      shared < candidate.length &&
      shared < needle.length &&
      candidate[shared] === needle[shared]
    ) {
      shared++
    }
    if (shared >= 4) scored.push({ name: entry.name, score: shared })
  }
  return scored
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1))
    .slice(0, limit)
    .map((candidate) => candidate.name)
}
