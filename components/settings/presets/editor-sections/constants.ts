// Shared constants for the preset editor sections. Extracted from the
// pre-split `components/settings/presets/preset-editor.tsx` so each section
// can import without pulling in the whole editor module.

import { SDK_EFFORT_LEVELS } from "@/lib/ai/thinking-level"

export const COLOR_PALETTE = [
  "oklch(0.65 0.18 245)",
  "oklch(0.7 0.15 30)",
  "oklch(0.7 0.13 150)",
  "oklch(0.78 0.16 90)",
  "oklch(0.7 0.14 320)",
  "oklch(0.7 0.16 200)",
  "oklch(0.65 0.18 350)",
  "oklch(0.7 0.14 60)",
  "oklch(0.72 0.13 280)",
  "oklch(0.7 0.16 165)",
  "oklch(0.7 0.1 250)",
  "oklch(0.65 0.15 220)",
] as const

/**
 * Effort tiers a preset can store. Presets persist a raw `SendOptions.effort`,
 * so they carry only the tiers that map 1:1 onto it — the composer's `"off"` and
 * composite `"ultracode"` tiers have no representation here. Derived from
 * `@/lib/ai/thinking-level` rather than re-listed, so the ladder has one owner.
 */
export const EFFORT_LEVELS = SDK_EFFORT_LEVELS
