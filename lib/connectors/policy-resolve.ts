/**
 * Three-layer binding resolver — Task 27.
 *
 * Merges adapter defaults → character platformDefaults → conversation override
 * into a single resolved (mode, characterId, trigger) triple.
 *
 * Merge semantics for trigger:
 *   - `rules` and `blockers` arrays REPLACE (no concat) when the higher layer
 *     defines them.
 *   - `storeUnmatchedInDraftMode` follows the highest layer that defines it.
 *
 * Note: the Character type does not have a `mode` field or a `characterId`
 * field — those are skipped during the character layer merge.
 */

import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type { Character } from "@/lib/claude/types"
import type { ConnectorMode, TriggerPolicy } from "@/types/connectors/policy"

export interface BindingResolutionInput {
  adapter: Pick<AdapterInstanceRow, "trigger" | "defaultMode" | "defaultCharacterId">
  character: Pick<Character, "platformDefaults"> | null
  override: Pick<ConversationOverrideRow, "mode" | "characterId" | "trigger"> | null
}

export interface ResolvedBinding {
  mode: ConnectorMode
  characterId: string | undefined
  trigger: TriggerPolicy
}

/**
 * Deep-merge a partial trigger policy on top of a base policy.
 * Arrays (rules, blockers) REPLACE when present in `patch`; scalars follow
 * the same replace-if-defined semantics.
 */
function mergeTrigger(base: TriggerPolicy, patch: Partial<TriggerPolicy>): TriggerPolicy {
  return {
    rules: patch.rules !== undefined ? patch.rules : base.rules,
    blockers: patch.blockers !== undefined ? patch.blockers : base.blockers,
    storeUnmatchedInDraftMode:
      patch.storeUnmatchedInDraftMode !== undefined
        ? patch.storeUnmatchedInDraftMode
        : base.storeUnmatchedInDraftMode,
  }
}

export function resolveBinding(input: BindingResolutionInput): ResolvedBinding {
  const { adapter, character, override } = input

  // ── mode ──────────────────────────────────────────────────────────────────
  // Layer 1: adapter default
  let mode: ConnectorMode = adapter.defaultMode
  // Layer 2: character — Character has no `mode` field; skip
  // Layer 3: override
  if (override?.mode !== undefined) mode = override.mode

  // ── characterId ───────────────────────────────────────────────────────────
  // Layer 1: adapter default
  let characterId: string | undefined = adapter.defaultCharacterId
  // Layer 2: character — a Character IS the character; no id redirect; skip
  // Layer 3: override
  if (override?.characterId !== undefined) characterId = override.characterId

  // ── trigger ───────────────────────────────────────────────────────────────
  // Layer 1: adapter trigger as base
  let trigger: TriggerPolicy = { ...adapter.trigger }

  // Layer 2: character platformDefaults.trigger (partial, REPLACE semantics per key)
  const charTrigger = character?.platformDefaults?.trigger
  if (charTrigger && Object.keys(charTrigger).length > 0) {
    trigger = mergeTrigger(trigger, charTrigger)
  }

  // Layer 3: override.trigger (partial, same REPLACE semantics)
  if (override?.trigger && Object.keys(override.trigger).length > 0) {
    trigger = mergeTrigger(trigger, override.trigger)
  }

  return { mode, characterId, trigger }
}
