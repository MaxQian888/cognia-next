// Coin awards per PetEvent kind — the economy sibling of `lib/pet/xp/award-table.ts`.
// Interactions are weighted UP relative to their XP (daily care is the coin
// faucet), work milestones sit at roughly half their XP, and lifecycle/radar
// kinds mint nothing. Streak multipliers apply on top in `applyPetEvent`.

import type { PetEventKind } from "@/types/pet"

export const COIN_AWARD: Partial<Record<PetEventKind, number>> = {
  // Direct care interactions (the faucet).
  fed: 2,
  played: 3,
  petted: 1,
  talked: 1,
  slept: 2,
  cleaned: 2,
  treated: 2,
  // Work milestones (~xp × 0.5).
  review: 1,
  success: 1,
  goalProgress: 3,
  goalComplete: 12,
  teamRun: 4,
  workflowRun: 2,
  scheduledRun: 1,
  // inboundMessage / radar / twin / lifecycle kinds mint nothing.
}

/**
 * Coins minted by an event. An explicit amount (plugin rewards carried on
 * `meta.coins`, already budget-clamped by the plugin API) wins over the table,
 * mirroring `xpForEvent(kind, explicit)`.
 */
export function coinsForEvent(kind: PetEventKind, explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(0, Math.floor(explicit))
  }
  return COIN_AWARD[kind] ?? 0
}
