"use client"

/**
 * Live IM effective-configuration lookup, running the SAME
 * `resolveImEffectiveConfig` the bus, `/status` and the override dialog run.
 *
 * The chip, the override dialog and the routing pipeline must never disagree
 * about what a conversation currently behaves like, so none of them may
 * re-derive it. This hook is the one adapter between the resolver (pure, takes
 * rows) and a React surface (needs the adapter row loaded from Dexie).
 *
 * ## Why the caller supplies the override row
 *
 * Liveness is the caller's choice, not this hook's. The conversation header
 * wants a live row so the chip updates the moment an SLA step or another shell
 * rewrites the mode. The override dialog deliberately holds the row it opened
 * with, so its form does not re-seed under the operator mid-edit. Reading the
 * row here would take that choice away from both.
 *
 * ## Why `rule: null`
 *
 * A dispatch rule matches the NEXT inbound message by its text, sender and
 * channel. A UI has no such event in hand, so there is no honest rule hit to
 * pass, and inventing one would report a route the bot may never take.
 * `renderStatus`'s closing line already says this out loud to end users.
 * Consequence worth knowing: for a conversation routed by a dispatch rule, the
 * chip shows the layer BELOW the rule, which is what "no message pending" means.
 */

import { useLiveQuery } from "dexie-react-hooks"

import { resolveImEffectiveConfig } from "@/lib/connectors/effective-config"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"

export type ImEffectiveConfig = ReturnType<typeof resolveImEffectiveConfig>

export interface UseImEffectiveConfigInput {
  /** Omit (or pass empty) before the conversation key has been parsed. */
  adapterId: string | null | undefined
  /**
   * The conversation's override row, or `null` when it has none. `undefined`
   * is treated as "none" rather than "still loading": the resolver answers
   * correctly from the adapter defaults either way, and blocking on it would
   * leave the chip blank on every conversation that never pinned anything.
   */
  override: ConversationOverrideRow | null | undefined
}

/**
 * Returns `undefined` while the adapter row has not loaded, and for an unknown
 * adapter id. A resolved config without its adapter would be a fabricated
 * answer, not a partial one.
 */
export function useImEffectiveConfig(
  input: UseImEffectiveConfigInput
): ImEffectiveConfig | undefined {
  const { adapterId, override } = input
  return useLiveQuery<ImEffectiveConfig | undefined>(async () => {
    if (typeof window === "undefined" || !adapterId) return undefined
    const adapter = await getDb().adapterInstances.get(adapterId)
    if (!adapter) return undefined
    return resolveImEffectiveConfig({
      adapter,
      override: override ?? null,
      rule: null,
      system: { mode: adapter.defaultMode ?? "auto", characterId: adapter.defaultCharacterId },
    })
    // `override` is depended on by identity: Dexie hands back a fresh object on
    // every write, so a re-resolve is exactly what a changed row should cause.
  }, [adapterId, override])
}
