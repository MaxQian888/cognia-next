"use client"

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { listSkillsByIds, resolveEffectiveSkills, type EffectiveSkillRef } from "@/lib/db/skills"
import type { Skill } from "@cognia/agent-config-types"

/** A resolved effective-skill entry with its hydrated Dexie row. */
export interface EffectiveSkillItem extends EffectiveSkillRef {
  skill: Skill
}

export interface EffectiveSkillsView {
  /** All resolved entries (character ∪ ephemeral, deduped), hydrated + tagged. */
  items: EffectiveSkillItem[]
  /** Count of entries that will actually be injected (not inert). */
  activeCount: number
  /** Total resolved entries (active + inert). */
  totalCount: number
}

/**
 * Hydrate + tag the effective skill set for a chat surface. Wraps the shared
 * `resolveEffectiveSkills` precedence (the same one `build-options` uses on
 * the send path) and looks up each row from Dexie, so the composer chips and
 * the per-session badge render exactly what the next send will inject —
 * including which attachments are inert because the session disabled them.
 *
 * Rows that no longer exist (e.g. a skill deleted from the panel while still
 * referenced by a stale id) are dropped from `items`.
 */
export function useEffectiveSkills(input: {
  characterSkillIds?: readonly string[]
  ephemeralSkillIds?: readonly string[]
  disabledIds?: readonly string[]
}): EffectiveSkillsView {
  const refs = useMemo(
    () =>
      resolveEffectiveSkills({
        characterSkillIds: input.characterSkillIds,
        ephemeralSkillIds: input.ephemeralSkillIds,
        disabledIds: input.disabledIds,
      }),
    [input.characterSkillIds, input.ephemeralSkillIds, input.disabledIds]
  )
  const ids = refs.map((r) => r.id)
  const idsKey = ids.join(",")
  const liveRows = useLiveQuery(
    () => (ids.length > 0 ? listSkillsByIds(ids) : Promise.resolve([])),
    [idsKey]
  )

  return useMemo(() => {
    const rows = liveRows ?? []
    const byId = new Map(rows.map((s) => [s.id, s]))
    const items = refs
      .map((r) => {
        const skill = byId.get(r.id)
        return skill ? { ...r, skill } : null
      })
      .filter((r): r is EffectiveSkillItem => r != null)
    return {
      items,
      activeCount: items.filter((i) => !i.inert).length,
      totalCount: items.length,
    }
  }, [refs, liveRows])
}
