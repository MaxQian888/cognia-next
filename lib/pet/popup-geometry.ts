// Size estimate for the desktop-pet click popup window (label "pet-popup").
//
// Placement itself is owned by the native side (`src-tauri/src/pet_window/
// popup.rs:resolve_popup_placement`): the sprite hands over the physical
// rectangle of the pet's box, Rust puts the popup above it (flipping below
// when there is no room, clamped to the work area of that monitor) and
// re-places it every time the popup fits itself to its card. Computing the
// placement here once, from this estimate, left the popup growing from a
// fixed top-left afterwards: off the bottom of the screen when the composer
// opened below the pet, or hovering far above it when the card came out
// shorter than the estimate.

/**
 * Initial LOGICAL size the popup window opens at. The popup's own
 * `ResizeObserver` fits the window to its card afterwards, so these only need
 * to be a sane estimate — generous enough that the panel fits without a
 * visible jump on the first frame.
 */
export const POPUP_INITIAL_WIDTH = 330
export const POPUP_INITIAL_HEIGHT = 460
