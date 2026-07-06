// Shared constants for the optical (snapcompact) compaction renderer.
//
// Ported 1:1 from oh-my-pi `crates/pi-natives/src/snapcompact.rs` so the pixel
// layout, palette, and control-code semantics match the reference renderer the
// SQuAD evals validated. See ADR-0063.

/** Upper bound on the frame edge — a hard stop against absurd `size*size`
 * allocations, far above any production frame. */
export const MAX_FRAME_SIZE = 16384

/**
 * Indexed palette: 0 is the white background, 1-6 are the six dark sentence
 * hues from the eval renderer (HLS l=0.22 s=0.95, h ∈ {0, .08, .3, .5, .62,
 * .78}), 7 is plain black ink (`bw` variant), 8 is the pale highlight band
 * behind repeated line copies, 9 is the dim gray ink for tool-output spans.
 */
export const PALETTE = [
  [255, 255, 255],
  [109, 2, 2], // red
  [109, 53, 2], // amber
  [24, 109, 2], // green
  [2, 109, 109], // teal
  [2, 32, 109], // blue
  [75, 2, 109], // violet
  [0, 0, 0], // bw ink
  [255, 247, 194], // repeat highlight band
  [128, 128, 128], // dim ink (tool-output spans)
]

export const INK_COLORS = 6
export const INK_BLACK = 7
export const BG_REPEAT = 8
export const INK_DIM = 9

/** Zero-width ink toggles embedded in the text stream (shift-out / shift-in). */
export const DIM_ON = 0x0e
export const DIM_OFF = 0x0f
/** FULL BLOCK: fills its whole cell box with pitch-black ink regardless of hue
 * or dim state. The normalizer folds newline runs to it. */
export const FULL_BLOCK = 0x2588
/** Line feed, meaningful only in two-column "doc" layout. */
export const LINE_FEED = 0x0a
