// The pet access gate's published vocabulary and per-call limits, with no
// runtime dependencies.
//
// `lib/pet/access/gate.ts` enforces these, and the plugin SDK publishes them
// (`@cognia/plugin-sdk/api/pet`) so authors can type against the kinds the host
// actually accepts and size a reward to what it will actually grant. Kept apart
// from the gate because the gate reaches the settings store, Dexie and the
// event bus, and none of that may be bundled into the SDK.

import type { PetEventKind } from "@/types/pet"

/** Nurture kinds any subject may drive directly. */
export const PET_INTERACTION_KINDS = [
  "fed",
  "played",
  "petted",
  "talked",
  "slept",
  "cleaned",
  "treated",
] as const satisfies readonly PetEventKind[]
export type PetInteractionKind = (typeof PET_INTERACTION_KINDS)[number]

/**
 * Kinds a non-user subject may reward through the gate's `requestPetReward`:
 * the seven care actions, the legacy `workflowRun`, and `pluginReward`, the
 * neutral kind for a reward that is not itself a care action.
 */
export const PET_REWARDABLE_KINDS = [
  ...PET_INTERACTION_KINDS,
  "workflowRun",
  "pluginReward",
] as const satisfies readonly PetEventKind[]
export type PetRewardableKind = (typeof PET_REWARDABLE_KINDS)[number]

/** Hard per-call XP ceiling, below the daily budget. */
export const MAX_XP_PER_REWARD = 10

/**
 * Hard per-call coin ceiling, below the daily budget (100). Without it one
 * call could take the whole day's coins at once, which is not what "clamped
 * per call" promised plugin authors.
 */
export const MAX_COINS_PER_REWARD = 20
