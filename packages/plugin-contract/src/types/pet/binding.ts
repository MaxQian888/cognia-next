// Per-character appearance override. When a bound Character is active in chat,
// the renderer prefers this override's fields over the global bones, letting each
// persona carry its own pet look without changing the global identity.

import type { PetBodyType, PetEyes, PetHat, PetPalette, PetSpecies } from "./bones"
import type { PetSkinSelection } from "./skin"

export interface PetCharacterBinding {
  /** Primary key — the Character id this binding decorates. */
  characterId: string
  /** Optional overrides; any field left undefined falls back to global bones. */
  species?: PetSpecies
  eyes?: PetEyes
  hat?: PetHat
  bodyType?: PetBodyType
  palette?: PetPalette
  /**
   * Per-character Live2D model override. When set, the skin resolver prefers
   * this over the global `PetSettings.activeLive2dModelId`.
   */
  live2dModelId?: string
  /** Typed appearance override. Absent means inherit global appearance. */
  skin?: PetSkinSelection
  /** ISO 8601. */
  updatedAt: string
}
