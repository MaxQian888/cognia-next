/**
 * The plugin contract's share of `lib/plugin/api/pet-api.ts`, which re-exports these.
 */
import type { PetInteractionKind } from "../../pet/access/limits"
import type { PetSummary } from "../../pet/access/summary"
import type {
  PluginEmittablePetEventKind,
  PluginPetAvailability,
  PluginPetEvent,
} from "./pet-api-contract"

/**
 * PII-safe projection of the pet's public state.
 *
 * The shape moved to `lib/pet/access/summary.ts` when the agent gained the
 * same read. The alias stays because the SDK re-exports this name from this
 * path (`packages/plugin-sdk/src/api/pet.ts`), so renaming it here would break
 * every plugin that imports the type.
 */
export type PluginPetSummary = PetSummary

/** Direct nurture interactions a plugin may perform. */
export type PluginPetInteractionKind = PetInteractionKind

export interface PluginPetAPI {
  /** Live public view of the pet (null before the profile is initialized). */
  getView(): Promise<PluginPetSummary | null>
  /** Alias of getView — kept separate so a richer projection can grow later. */
  getSummary(): Promise<PluginPetSummary | null>
  /** Subscribe to sanitized pet events. Returns a disposer. */
  onEvent(cb: (event: PluginPetEvent) => void): () => void
  /**
   * Whether interactions and rewards would reach the pet right now, and if
   * not, why. A pet that is switched off, still an egg, or not set up yet
   * makes `interact`/`emitEvent` grant zero quietly; ask this first so a quest
   * is not marked claimed for a reward the pet never received.
   */
  getAvailability(): Promise<PluginPetAvailability>
  /** Remaining daily reward budget for THIS plugin (for quest UIs). */
  getRemainingBudget(): { xp: number; coins: number }
  /**
   * Emit a direct nurture interaction (rate-limited). The kind's host award
   * amounts are spent from the SAME daily budget as `emitEvent`. At zero
   * remaining budget the interaction still settles needs/mood and plays its
   * flourish, it just grants nothing. Returns what was actually granted.
   *
   * Throws `PetCooldownError` while the pet is recovering from the same action
   * (nothing is spent), `PetItemNotOwnedError` for an item this plugin's user
   * does not own, and `PetItemKindMismatchError` for an item that is not for
   * this action.
   */
  interact(
    kind: PluginPetInteractionKind,
    opts?: { itemId?: string }
  ): Promise<{ grantedXp: number; grantedCoins: number }>
  /**
   * Emit a whitelisted event with an optional XP/coin reward, clamped per
   * call (`MAX_XP_PER_EMIT`, `MAX_COINS_PER_EMIT`) and against the daily
   * budget. Returns what was actually granted. Use `pluginReward` for a
   * reward that is not itself a care action. A reward never carries an item.
   * A care kind throws `PetCooldownError` while it is cooling.
   */
  emitEvent(
    kind: PluginEmittablePetEventKind,
    opts?: { xp?: number; coins?: number; meta?: Record<string, unknown> }
  ): Promise<{ grantedXp: number; grantedCoins: number }>
}
