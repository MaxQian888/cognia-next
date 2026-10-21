/**
 * The plugin contract's share of `lib/pet/access/limits.ts`, which re-exports these.
 */
import type { PET_INTERACTION_KINDS, PET_REWARDABLE_KINDS } from "@/lib/pet/access/limits"

export type PetInteractionKind = (typeof PET_INTERACTION_KINDS)[number]

export type PetRewardableKind = (typeof PET_REWARDABLE_KINDS)[number]
