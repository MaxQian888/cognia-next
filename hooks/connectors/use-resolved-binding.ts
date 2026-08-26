"use client"

/**
 * Live three-layer binding lookup — adapter row → character `platformDefaults`
 * → conversation override — running the SAME `resolveBinding` the bus runs.
 *
 * Live rather than a one-shot read, because both things it resolves are edited
 * from the very screens that display them: the mode chip sits next to the mode
 * switcher, and the policy read-out sits next to the override dialog. A
 * snapshot taken at mount describes the bot as it was before the operator
 * changed it, which is worse than showing nothing.
 *
 * Returns `null` for a session with no platform binding, and while the adapter
 * row has not loaded — a resolved binding without its adapter would be a
 * fabricated answer, not a partial one.
 */

import { useLiveQuery } from "dexie-react-hooks"

import { resolveBinding, type ResolvedBinding } from "@/lib/connectors/policy-resolve"
import { getDb } from "@/lib/db/schema"

export interface ResolvableBinding {
  adapterId: string
  conversationKey: string
  /** The session's own character, which outranks the adapter default. */
  characterId?: string
}

export function useResolvedBinding(
  binding: ResolvableBinding | null | undefined
): ResolvedBinding | null {
  const adapterId = binding?.adapterId
  const conversationKey = binding?.conversationKey
  const sessionCharacterId = binding?.characterId

  return (
    useLiveQuery<ResolvedBinding | null>(async () => {
      if (typeof window === "undefined" || !adapterId || !conversationKey) return null
      const db = getDb()
      const adapter = await db.adapterInstances.get(adapterId)
      if (!adapter) return null
      const override =
        (await db.conversationOverrides.where("conversationKey").equals(conversationKey).first()) ??
        null
      // Mirrors the bus: an explicitly disabled character contributes no
      // layer at all, rather than falling back to the adapter default.
      const characterId = override?.characterDisabled
        ? undefined
        : (override?.characterId ?? sessionCharacterId ?? adapter.defaultCharacterId)
      const character = characterId ? ((await db.characters.get(characterId)) ?? null) : null
      return resolveBinding({ adapter, character, override })
    }, [adapterId, conversationKey, sessionCharacterId]) ?? null
  )
}
