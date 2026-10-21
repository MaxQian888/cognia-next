// The pet access gate's published vocabulary and per-call limits, with no
// runtime dependencies.
//
// `lib/pet/access/gate.ts` enforces these, and the plugin SDK publishes them
// (`@cognia/plugin-sdk/api/pet`) so authors can type against the kinds the host
// actually accepts and size a reward to what it will actually grant. Kept apart
// from the gate because the gate reaches the settings store, Dexie and the
// event bus, and none of that may be bundled into the SDK.

import type { PetEventKind } from "../../../types/pet"

export type PetInteractionKind = (typeof PET_INTERACTION_KINDS)[number]

export type PetRewardableKind = (typeof PET_REWARDABLE_KINDS)[number]

export const PET_INTERACTION_KINDS = [
  "fed",
  "played",
  "petted",
  "talked",
  "slept",
  "cleaned",
  "treated",
] as const satisfies readonly PetEventKind[]

export const PET_REWARDABLE_KINDS = [
  ...PET_INTERACTION_KINDS,
  "workflowRun",
  "pluginReward",
] as const satisfies readonly PetEventKind[]

export const MAX_XP_PER_REWARD = 10

export const MAX_COINS_PER_REWARD = 20
