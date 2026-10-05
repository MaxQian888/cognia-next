/**
 * How the phone tells several configurations of one runtime apart (ADR-0216).
 *
 * A user may keep a read-only Codex next to a workspace-write one, or one CLI
 * on two accounts. On a 375px screen those are two cards with the same mark
 * and nearly the same name, so the list groups them by runtime, the detail
 * screen names its siblings, and both say what actually differs.
 *
 * The family rules themselves (which configurations are one runtime, what
 * differs between two of them) are the shared ones in
 * `lib/ai/agent/external/config/instance-family.ts`, so the phone and the
 * desktop can never group or compare differently. This module only adapts a
 * Host record to them — the record's id is the configuration id, not the
 * config's own — and keeps the record attached to the answer.
 */

import {
  groupByRuntimeFamily,
  instanceDifferences,
  runtimeFamilyKey,
  runtimeSiblings,
  type InstanceDifference,
  type InstanceFamilyConfig,
} from "@/lib/ai/agent/external/config/instance-family"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import type { ExternalAgentStateIsolation } from "@/types/agent/external-agent"

/** The configuration's recorded preset, or `null` for a custom agent. */
export function presetOf(record: ExternalAgentConfigRecord): string | null {
  const preset = record.config.metadata?.preset
  return typeof preset === "string" && preset !== "custom" ? preset : null
}

/** The configuration's display name, falling back to its id. */
export function hostAgentName(record: ExternalAgentConfigRecord): string {
  return record.config.name?.trim() || record.configId
}

/**
 * A Host record as the family rules read it: under its configuration id. The
 * shared rules already treat the add form's `"custom"` preset marker as no
 * preset.
 */
function familyConfig(record: ExternalAgentConfigRecord): InstanceFamilyConfig {
  return { ...record.config, id: record.configId } as unknown as InstanceFamilyConfig
}

/**
 * Which runtime a configuration runs, as the shared family key plus what a
 * header needs to name it: the configuration's preset id, a launch command,
 * or nothing (an endpoint or protocol family is named after its first
 * configuration).
 */
export type HostAgentRuntimeKey =
  | { kind: "preset"; id: string; key: string }
  | { kind: "command"; command: string; key: string }
  | { kind: "single"; key: string }

export function runtimeKeyOf(record: ExternalAgentConfigRecord): HostAgentRuntimeKey {
  const key = runtimeFamilyKey(familyConfig(record))
  // The key names the preset FAMILY (`codex`, `codex-acp` and `codex-app-server`
  // are one runtime); a header names it after the configuration's own preset.
  if (key.startsWith("preset:")) {
    return { kind: "preset", id: presetOf(record) ?? key.slice("preset:".length), key }
  }
  if (key.startsWith("command:")) {
    return { kind: "command", command: key.slice("command:".length), key }
  }
  return { kind: "single", key }
}

/** Configurations of the same runtime as `record`, `record` excluded, in list order. */
export function siblingsOf(
  record: ExternalAgentConfigRecord,
  records: readonly ExternalAgentConfigRecord[]
): ExternalAgentConfigRecord[] {
  const byId = new Map(records.map((row) => [row.configId, row]))
  return runtimeSiblings(familyConfig(record), records.map(familyConfig)).flatMap((config) => {
    const row = byId.get(config.id)
    return row ? [row] : []
  })
}

export interface HostAgentGroup {
  runtime: HostAgentRuntimeKey
  records: ExternalAgentConfigRecord[]
}

/**
 * The list in runtime groups, in the order each runtime first appears. A
 * runtime with a single configuration is still a group of one; the caller
 * decides to draw a header only for groups of two or more.
 */
export function groupHostConfigsByRuntime(
  records: readonly ExternalAgentConfigRecord[]
): HostAgentGroup[] {
  const byId = new Map(records.map((row) => [row.configId, row]))
  return groupByRuntimeFamily(records.map(familyConfig)).map((family) => {
    const members = family.members.flatMap((config) => {
      const row = byId.get(config.id)
      return row ? [row] : []
    })
    return { runtime: runtimeKeyOf(members[0]!), records: members }
  })
}

/**
 * The isolation in force. Absent means `shared`: every configuration saved
 * before the field existed keeps the runtime's shared home (ADR-0216).
 */
export function stateIsolationOf(record: ExternalAgentConfigRecord): ExternalAgentStateIsolation {
  return record.config.stateIsolation === "isolated" ? "isolated" : "shared"
}

/**
 * The configuration `record` was duplicated from: the record when the Host
 * still has it, `"removed"` when lineage names one that is gone, `null` when
 * `record` is not a copy.
 */
export function lineageSourceOf(
  record: ExternalAgentConfigRecord,
  records: readonly ExternalAgentConfigRecord[]
): ExternalAgentConfigRecord | "removed" | null {
  const sourceId = record.config.duplicatedFromAgentId
  if (!sourceId) return null
  return records.find((other) => other.configId === sourceId) ?? "removed"
}

/**
 * What `sibling` sets differently from `current`, with the sibling's values
 * (`value`) — the line under a sibling's name on the detail screen. Empty when
 * the two differ in nothing the family rules compare.
 */
export function siblingDifferences(
  current: ExternalAgentConfigRecord,
  sibling: ExternalAgentConfigRecord
): InstanceDifference[] {
  return instanceDifferences(familyConfig(sibling), familyConfig(current))
}
