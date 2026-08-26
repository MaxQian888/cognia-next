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
 * `Character` itself has no `mode` or `characterId`, but a character CAN ship
 * `platformDefaults.mode` — a recommendation for how a bot wearing it should
 * behave. That layer used to be skipped, so a character pack could declare a
 * mode that never took effect anywhere.
 */

import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type { Character } from "@cognia/agent-config-types"
import type { ConnectorMode, TriggerPolicy } from "@/types/connectors/policy"

export interface BindingResolutionInput {
  adapter: Pick<AdapterInstanceRow, "trigger" | "defaultMode" | "defaultCharacterId">
  character: Pick<Character, "platformDefaults"> | null
  override: Pick<
    ConversationOverrideRow,
    "mode" | "characterId" | "characterDisabled" | "trigger"
  > | null
}

export interface ResolvedBinding {
  mode: ConnectorMode
  /**
   * Which layer `mode` came from. Without it a character-recommended mode is
   * indistinguishable from a bot default in every read-out.
   */
  modeSource: "adapter-default" | "character-default" | "conversation-override"
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
  // Layer 2: character recommendation
  let modeSource: ResolvedBinding["modeSource"] = "adapter-default"
  const charMode = character?.platformDefaults?.mode
  if (charMode !== undefined) {
    mode = charMode
    modeSource = "character-default"
  }
  // Layer 3: override
  if (override?.mode !== undefined) {
    mode = override.mode
    modeSource = "conversation-override"
  }

  // ── characterId ───────────────────────────────────────────────────────────
  // Layer 1: adapter default
  let characterId: string | undefined = adapter.defaultCharacterId
  // Layer 2: character — a Character IS the character; no id redirect; skip
  // Layer 3: override
  if (override?.characterDisabled === true) characterId = undefined
  else if (override?.characterId !== undefined) characterId = override.characterId

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

  return { mode, modeSource, characterId, trigger }
}

export interface EffectiveTeamBinding {
  teamId: string | undefined
  /** Where the effective team came from — audited so operators can tell a
   * `/team`-bound chat from a bot-default dispatch. */
  source: "override" | "instance-default" | "none"
}

/**
 * Resolve which Agent Team (if any) answers an inbound turn.
 *
 * Precedence: `override.teamDisabled` (the `/team off` sentinel) suppresses
 * everything → explicit conversation `teamId` → the bot instance's
 * `defaultTeamId` → none. Empty/whitespace ids are treated as unset so a
 * blanked-out settings field can never dispatch to team `""`.
 *
 * Shared by the connector runtime (dispatch decision) and `/status`
 * (display) so the two can't drift.
 */
export function resolveEffectiveTeamBinding(
  adapter: Pick<AdapterInstanceRow, "defaultTeamId">,
  override: Pick<ConversationOverrideRow, "teamId" | "teamDisabled"> | null | undefined
): EffectiveTeamBinding {
  if (override?.teamDisabled === true) return { teamId: undefined, source: "none" }
  const overrideTeamId = override?.teamId?.trim()
  if (overrideTeamId) return { teamId: overrideTeamId, source: "override" }
  const instanceTeamId = adapter.defaultTeamId?.trim()
  if (instanceTeamId) return { teamId: instanceTeamId, source: "instance-default" }
  return { teamId: undefined, source: "none" }
}

/**
 * Whether an inbound turn should be suppressed before it runs, and why.
 *
 * The delivery-time twin of this lives in `outbound-runner.ts` (adapter mute →
 * conversation mute → `convOverride?.quietHours ?? adapterRow.quietHours`), and
 * the two must agree: a conversation quiet window that holds the DELIVERY but
 * lets the turn run still spends a model call on a reply nobody asked to have
 * sent now, and a muted conversation still burned one on a reply that would sit
 * deferred until someone unmuted it — possibly days later, answering a message
 * from days ago.
 *
 * Mute is OR across the layers because it is a killswitch in both places: a
 * conversation cannot un-mute a muted bot. Quiet hours REPLACE, because a
 * window is a whole statement about when this chat is awake — merging two of
 * them has no meaning.
 */
export interface InboxSuppression {
  quietHours?: NonNullable<AdapterInstanceRow["quietHours"]>
  muted: boolean
  /**
   * Which layer switched the mute on. The audit trail needs the difference:
   * "this bot is off" and "this chat is off" send a troubleshooter to two
   * different controls.
   */
  mutedScope?: "adapter" | "conversation"
}

export function resolveInboxSuppression(
  adapter: Pick<AdapterInstanceRow, "quietHours" | "muted">,
  override: Pick<ConversationOverrideRow, "quietHours" | "muted"> | null | undefined
): InboxSuppression {
  const mutedScope =
    adapter.muted === true ? "adapter" : override?.muted === true ? "conversation" : undefined
  return {
    quietHours: override?.quietHours ?? adapter.quietHours,
    muted: mutedScope !== undefined,
    ...(mutedScope ? { mutedScope } : {}),
  }
}
