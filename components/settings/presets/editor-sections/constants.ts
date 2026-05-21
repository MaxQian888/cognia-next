// Shared constants for the preset editor sections. Extracted from the
// pre-split `components/settings/presets/preset-editor.tsx` so each section
// can import without pulling in the whole editor module.

import type { SendOptions } from "@/lib/claude/types"

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

export const EFFORT_LEVELS: NonNullable<SendOptions["effort"]>[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]
