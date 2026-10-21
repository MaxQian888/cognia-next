/**
 * The plugin contract's share of `lib/chat/composer-skin.ts`, which re-exports these.
 */
import type { COMPOSER_SKIN_IDS } from "@/lib/chat/composer-skin"

export type ComposerSkinId = (typeof COMPOSER_SKIN_IDS)[number]

/**
 * Where the status toolbar sits, and how much of its roster is spelled out.
 *
 *  - `detached`  — below the box (today's wide desktop layout)
 *  - `embedded`  — inside the box, tail packed into "⋯"
 *  - `rail`      — inside the box as a quiet monospace status line
 *  - `expanded`  — inline, every chip labelled, plus an ambient cost/context rail
 *  - `folded`    — only the model glyph inline; everything else behind "⋯"
 */
export type ComposerToolbarLayout = "detached" | "embedded" | "rail" | "expanded" | "folded"

/** Shape of the send/stop control. */
export type ComposerSendShape = "circle" | "rounded"

/** User overrides layered on top of the chosen preset. All optional. */
export interface ComposerSkinOverrides {
  radiusPx?: number
  padXPx?: number
  padYPx?: number
  mono?: boolean
  sendShape?: ComposerSendShape
  toolbarLayout?: ComposerToolbarLayout
}
