/**
 * The plugin contract's share of `lib/workflow/editor/auto-layout.ts`, which re-exports these.
 */
import type { ELK_DIRECTIONS } from "@/lib/workflow/editor/auto-layout"

export type AutoLayoutDirection = keyof typeof ELK_DIRECTIONS
