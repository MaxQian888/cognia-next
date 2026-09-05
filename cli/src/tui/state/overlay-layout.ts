/**
 * Does an open overlay take the screen, or dock into the conversation?
 *
 * Fullscreen used to drop the transcript for ANY open overlay, which is right
 * for a picker (the model list, settings, a session browser): those are places
 * you go, and the conversation behind them is not part of the decision.
 *
 * It is wrong for a prompt the AGENT raised. An approval asks whether to run a
 * command the assistant just decided on, and the reasoning that led there is in
 * the transcript, one line above. Blanking it left a screen with a bordered box
 * on an empty background, no command, no context, and no way to look. The same
 * goes for a question the agent asks. Plan review is different: the overlay
 * contains the full document and needs the measured screen region to page it
 * without competing with the transcript for rows.
 *
 * So a prompt raised BY the turn docks above the composer with the conversation
 * still visible, except for document-based plan review. Everything the user
 * navigated to also keeps the screen.
 */
import type { Overlay } from "./types"

/** Overlays that dock into the conversation instead of replacing it. */
const INLINE_OVERLAY_KINDS = new Set<Overlay["kind"]>(["permission", "askUser", "confirm"])

/** True when this overlay should replace the transcript rather than dock under it. */
export function overlayTakesScreen(overlay: Overlay): boolean {
  if (overlay.kind === "none") return false
  return !INLINE_OVERLAY_KINDS.has(overlay.kind)
}

/** True when the overlay docks above the composer, transcript still visible. */
export function overlayIsInline(overlay: Overlay): boolean {
  return overlay.kind !== "none" && !overlayTakesScreen(overlay)
}

/**
 * Row budget for a docked prompt.
 *
 * Bounded so the prompt cannot eat the conversation it exists to be read
 * against: at most a third of the viewport, and never less than the frame plus
 * its choices. A full-screen overlay keeps the whole region as before.
 */
export function inlineOverlayRows(viewportRows: number): number {
  return Math.max(9, Math.min(viewportRows, Math.floor(viewportRows / 3)))
}
