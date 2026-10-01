/**
 * Updating a cogset to a newer version of the cogpack it came from (ADR-0209).
 *
 * Three things are compared: the manifest the cogset was imported from, the
 * new manifest, and the cogset as it is now. What the new version changed is
 * applied; where the user changed the cogset locally since the import, the
 * local version wins unless the user picks the new one, per plugin.
 */

import { canonicalizeJson } from "@/lib/plugin/character-pack/canonical-json"
import type {
  CogpackManifestV1,
  CogpackMember,
  CogsetMember,
  CogsetRow,
} from "@/types/plugin/plugin-cogset"

export type CogpackUpdateChange =
  "added" | "removed" | "repinned" | "config-changed" | "unchanged" | "local-only"

export interface CogpackUpdateEntry {
  pluginId: string
  change: CogpackUpdateChange
  previous?: CogpackMember
  next?: CogpackMember
  /** The cogset's member now, if it has one. */
  current?: CogsetMember
  /** The user changed this plugin in the cogset since the import. */
  localEdited: boolean
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return canonicalizeJson(a ?? null) === canonicalizeJson(b ?? null)
  } catch {
    return false
  }
}

/** The cogset member an imported cogpack member becomes. */
export function cogsetMemberFromCogpack(member: CogpackMember): CogsetMember {
  return {
    pluginId: member.id,
    expectedVersion: member.version,
    ...(member.config ? { config: member.config } : {}),
    ...(member.optional ? { optional: true } : {}),
  }
}

function sameMember(a: CogsetMember | undefined, b: CogsetMember | undefined): boolean {
  if (!a || !b) return a === b
  return (
    a.expectedVersion === b.expectedVersion &&
    !!a.optional === !!b.optional &&
    sameJson(a.config, b.config)
  )
}

export function diffCogpackUpdate(
  previous: CogpackManifestV1,
  next: CogpackManifestV1,
  current: CogsetRow
): CogpackUpdateEntry[] {
  const before = new Map(previous.members.map((member) => [member.id, member]))
  const after = new Map(next.members.map((member) => [member.id, member]))
  const now = new Map(current.members.map((member) => [member.pluginId, member]))
  const ids = [...new Set([...before.keys(), ...after.keys(), ...now.keys()])].sort()

  return ids.map((pluginId) => {
    const previousMember = before.get(pluginId)
    const nextMember = after.get(pluginId)
    const currentMember = now.get(pluginId)
    const baseline = previousMember ? cogsetMemberFromCogpack(previousMember) : undefined
    const localEdited = !sameMember(baseline, currentMember)
    let change: CogpackUpdateChange
    if (!previousMember && !nextMember) change = "local-only"
    else if (!previousMember) change = "added"
    else if (!nextMember) change = "removed"
    else if (previousMember.version !== nextMember.version) change = "repinned"
    else if (
      !sameJson(previousMember.config, nextMember.config) ||
      previousMember.optional !== nextMember.optional
    )
      change = "config-changed"
    else change = "unchanged"
    return {
      pluginId,
      change,
      ...(previousMember ? { previous: previousMember } : {}),
      ...(nextMember ? { next: nextMember } : {}),
      ...(currentMember ? { current: currentMember } : {}),
      localEdited,
    }
  })
}

/**
 * The cogset's members after the update. `useNext` lists the locally edited
 * plugins for which the user chose the new version over their own.
 */
export function mergeCogpackUpdate(
  entries: readonly CogpackUpdateEntry[],
  useNext: ReadonlySet<string>
): CogsetMember[] {
  const members: CogsetMember[] = []
  for (const entry of entries) {
    const takeNext = !entry.localEdited || useNext.has(entry.pluginId)
    if (entry.change === "local-only") {
      if (entry.current) members.push(entry.current)
      continue
    }
    if (entry.change === "removed") {
      if (!takeNext && entry.current) members.push(entry.current)
      continue
    }
    if (takeNext && entry.next) members.push(cogsetMemberFromCogpack(entry.next))
    else if (entry.current) members.push(entry.current)
  }
  return members
}
