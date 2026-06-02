// Barrel for the pet subsystem types. Import from `@/types/pet`.

export type {
  PetSpecies,
  PetRarity,
  PetEyes,
  PetHat,
  PetBodyType,
  PetPalette,
  PetStats,
  PetBones,
} from "./bones"
export type { PetSoul } from "./soul"
export type { PetNeedKind, PetNeeds, NeedDecayRate, NeedDecayConfig } from "./needs"
export type { PetStage, PetProfile, PetActivityRow } from "./profile"
export type { PetVisualState, PetOneShot, PetMood } from "./visual-state"
export type { PetEventSource, PetEventKind, PetEvent } from "./events"
export type { PetCharacterBinding } from "./binding"
export type {
  PetAchievementId,
  PetAchievementContext,
  PetAchievement,
  PetAchievementRecord,
} from "./achievements"
export type { PetSkin, PetSkinRenderProps } from "./skin"
export type { PetAnchor, PetMotionPreference, PetSettings } from "./settings"
export { DEFAULT_PET_SETTINGS } from "./settings"
