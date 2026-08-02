// Parametric cursor art.
//
// A cursor theme normally means hand-drawing every role (arrow, hand, I-beam,
// grab, deny, busy, crosshair) once per pack — 8 drawings × N packs, all of
// which then drift apart. This module inverts that: a pack contributes a single
// *silhouette* (the arrow), and every other role is composed generically from
// that silhouette plus the pack's four-color palette. Adding a pack costs one
// path string; the eight roles stay visually consistent by construction.
//
// Composition rules (deliberate, not shortcuts):
//   default    — the silhouette.
//   pointer    — silhouette + an accent ring badge. Packs of this kind read as
//                "the arrow, but clickable"; a separate hand glyph would break
//                the family resemblance the whole approach is built on.
//   progress   — silhouette + an accent arc badge.
//   text       — an outlined I-beam (body fill over the outline stroke, so it
//                stays legible on a same-colored surface).
//   grab       — an open accent ring with grip ticks; grabbing contracts it to
//                a filled disc. Same glyph, two states.
//   notAllowed — a red circle-slash. This one role ignores the palette on
//                purpose: "forbidden" is a safety affordance, and a pink
//                pastel deny sign is a worse cursor than an off-palette one.
//   crosshair  — four ticks + an accent centre dot.
//
// Everything is authored in a 32×32 box and scaled at build time. The output is
// an SVG string; `render-cursor.ts` turns it into something the `cursor:`
// property will accept.

import type { CursorPalette, CursorRole, CursorShapeId } from "@/types/appearance"

/** Authoring viewBox edge, in user units. */
export const CURSOR_VIEWBOX = 32

/**
 * Universal deny red. Fixed rather than palette-derived — see the header note.
 * Matches the `destructive` hue family used across the app's themes.
 */
export const CURSOR_DENY_COLOR = "#e5484d"

export interface CursorShapeDef {
  id: CursorShapeId
  /** Silhouette path data in the 32×32 authoring box. */
  path: string
  /** Hotspot in authoring units — the pixel the OS treats as "the pointer". */
  hotspot: { x: number; y: number }
  /**
   * `solid` fills the body and draws the outline behind it. `outline` leaves
   * the body hollow and draws only the stroke — used by the neon/HUD packs
   * where the glow does the visual work.
   */
  render: "solid" | "outline"
  /** Disables anti-aliasing. Only the pixel-art pack wants this. */
  crisp?: boolean
  /** Extra markup layered over the silhouette on arrow-family roles. */
  ornament?: (palette: CursorPalette) => string
}

// ---------------------------------------------------------------------------
// Silhouettes
// ---------------------------------------------------------------------------

/** Classic wide arrow with a tail — the shape every desktop OS started from. */
const ARROW_PATH = "M3 2 L3 24.5 L9 18.6 L12.9 27.4 L16.9 25.5 L13 17 L20.8 17 Z"

/** Slimmer, longer arrow — the modern macOS proportion. */
const GRAPHITE_PATH = "M4 2 L4 22.8 L9.2 17.8 L12.5 25.6 L15.9 24 L12.7 16.4 L19.6 16.4 Z"

/**
 * Stair-stepped arrow on a 2-unit grid, so every edge lands on a whole pixel
 * at the 1× (24px) render size and the shape stays crisp when scaled by even
 * multiples. Drawn as an explicit h/v walk rather than diagonals — a diagonal
 * would be re-sampled and lose the pixel look at exactly the size that matters.
 */
const PIXEL_PATH = [
  "M4 2",
  "h2 v2 h2 v2 h2 v2 h2 v2 h2 v2 h2 v2 h-6",
  "v2 h2 v2 h2 v2 h-4",
  "v-2 h-2 v-2 h-2 v-2",
  "h-2 v2 h-2 v2 h-2",
  "Z",
].join(" ")

/** Hollow arrow — reads as a HUD/neon outline once the glow is applied. */
const NEON_PATH = "M3.5 2.5 L3.5 24 L9 18.4 L12.7 26.6 L16.2 25 L12.6 17 L20 17 Z"

/** Tapered brush stroke — a bellied edge and a flat one meeting at a sharp tip. */
const INK_PATH =
  "M3.2 2.2 C9 8.6 13.6 15 18.4 22 C14.6 20.8 10.8 21.4 7.4 23.6 C9.8 17.2 7 8.8 3.2 2.2 Z"

/** Sakura petal: a broad lobe with the tip notch a cherry-blossom petal has. */
const PETAL_PATH =
  "M2.8 2 C11.4 5 19.6 11.2 24.6 20.2 C21.6 20.8 18.8 22.4 16.8 25 C16.4 22 14.6 19.8 11.8 19 C10.8 12.2 7.2 6.2 2.8 2 Z"

/** Magic wand: a slim tapered rod running from the tip down to the grip. */
const WAND_PATH = "M3 2.4 L6.4 2 L22.6 24.4 C23.4 25.5 22.6 26.9 21.3 26.7 L19.1 26.4 Z"

/** Cat paw: the big pad plus a single lead toe that carries the hotspot. */
const PAW_PATH = [
  // lead toe (top-left) — the hotspot sits on its outer edge
  "M5.4 3.2 C8.4 2 11 3.8 11 6.8 C11 9.5 9.1 11.4 6.8 11.4 C4.5 11.4 3 9.6 3 7.2 C3 5.4 3.9 3.9 5.4 3.2 Z",
  // second + third toes
  "M14.2 5.2 C16.8 5.2 18.4 7 18.4 9.5 C18.4 11.8 16.9 13.4 14.8 13.4 C12.6 13.4 11.2 11.8 11.2 9.6 C11.2 7.1 12.5 5.2 14.2 5.2 Z",
  "M22.6 10.4 C24.9 10.4 26.4 12.1 26.4 14.4 C26.4 16.6 25 18.2 22.9 18.2 C20.8 18.2 19.4 16.6 19.4 14.4 C19.4 12.1 20.8 10.4 22.6 10.4 Z",
  // main pad
  "M13.4 15.6 C18.6 15.6 23.6 19.4 23.6 23.6 C23.6 27 20.8 29 17 29 C13.6 29 12 27.6 9.6 27.6 C7 27.6 5 26 5 23.2 C5 19.2 8.6 15.6 13.4 15.6 Z",
].join(" ")

/** Angular targeting bracket — mecha HUD. */
const RETICLE_PATH =
  "M3 2 L3 15.6 L6.4 12.2 L6.4 6.6 L12 6.6 L15.4 3.2 Z M12.6 14.2 L26 27.6 L27.4 22.4 L22.2 21 L18.8 17.6 Z"

/** Katana-style blade: a long sharp edge with a guard notch at the grip. */
const BLADE_PATH =
  "M2.4 2 L6.4 2.8 L21.6 21.4 L24.4 19.6 L26.2 23.4 L23.2 25.2 L24.6 28.4 L18.6 26.2 L17 22.2 Z"

/** A four-point sparkle used as the wand pack's ornament. */
function sparkleOrnament(palette: CursorPalette): string {
  return [
    `<path d="M25 4 L26.4 9.2 L31.4 10.6 L26.4 12 L25 17.2 L23.6 12 L18.6 10.6 L23.6 9.2 Z"`,
    ` fill="${esc(palette.accent)}" stroke="${esc(palette.stroke)}" stroke-width="0.8"`,
    ` stroke-linejoin="round"/>`,
  ].join("")
}

export const CURSOR_SHAPE_DEFS: Record<CursorShapeId, CursorShapeDef> = {
  arrow: { id: "arrow", path: ARROW_PATH, hotspot: { x: 3, y: 2 }, render: "solid" },
  graphite: { id: "graphite", path: GRAPHITE_PATH, hotspot: { x: 4, y: 2 }, render: "solid" },
  pixel: {
    id: "pixel",
    path: PIXEL_PATH,
    hotspot: { x: 4, y: 2 },
    render: "solid",
    crisp: true,
  },
  neon: { id: "neon", path: NEON_PATH, hotspot: { x: 3.5, y: 2.5 }, render: "outline" },
  ink: { id: "ink", path: INK_PATH, hotspot: { x: 3.6, y: 2.6 }, render: "solid" },
  petal: { id: "petal", path: PETAL_PATH, hotspot: { x: 3.4, y: 2.6 }, render: "solid" },
  wand: {
    id: "wand",
    path: WAND_PATH,
    hotspot: { x: 3, y: 2.4 },
    render: "solid",
    ornament: sparkleOrnament,
  },
  paw: { id: "paw", path: PAW_PATH, hotspot: { x: 4.2, y: 4 }, render: "solid" },
  reticle: { id: "reticle", path: RETICLE_PATH, hotspot: { x: 3, y: 2 }, render: "outline" },
  blade: { id: "blade", path: BLADE_PATH, hotspot: { x: 2.6, y: 2.2 }, render: "solid" },
}

// ---------------------------------------------------------------------------
// Role composition
// ---------------------------------------------------------------------------

/** Roles that are drawn as "the silhouette, plus maybe a badge". */
const ARROW_FAMILY_ROLES = new Set<CursorRole>(["default", "pointer", "progress"])

/**
 * Hotspot for a role, in authoring units. Arrow-family roles inherit the
 * shape's tip; the symmetric glyphs (I-beam, ring, deny, crosshair) are
 * centred, which is what every platform convention expects.
 */
export function roleHotspot(role: CursorRole, shape: CursorShapeDef): { x: number; y: number } {
  if (ARROW_FAMILY_ROLES.has(role)) return shape.hotspot
  return { x: CURSOR_VIEWBOX / 2, y: CURSOR_VIEWBOX / 2 }
}

/** Escape a color/string for safe interpolation into SVG markup. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Body + outline for the silhouette, honouring the shape's render mode. */
function silhouetteMarkup(shape: CursorShapeDef, palette: CursorPalette): string {
  const d = esc(shape.path)
  const stroke = esc(palette.stroke)
  const fill = esc(palette.fill)
  if (shape.render === "outline") {
    return (
      `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="3.2" stroke-linejoin="round"/>` +
      `<path d="${d}" fill="none" stroke="${fill}" stroke-width="1.6" stroke-linejoin="round"/>`
    )
  }
  // `paint-order="stroke"` puts the outline UNDER the fill, so only its outer
  // half is visible. Without it the stroke is centred on the path and eats
  // 0.8 units inward from every edge — which is most of the body on the
  // deliberately slender silhouettes (the brush, the blade, the petal), and
  // they rendered as a bare outline with no fill left inside.
  return (
    `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="1.8"` +
    ` paint-order="stroke" stroke-linejoin="round" fill-rule="evenodd"/>`
  )
}

/** The "clickable" badge: an accent ring with a solid centre. */
function pointerBadge(palette: CursorPalette): string {
  const accent = esc(palette.accent)
  const stroke = esc(palette.stroke)
  return (
    `<circle cx="23.5" cy="9" r="5.4" fill="none" stroke="${stroke}" stroke-width="3"/>` +
    `<circle cx="23.5" cy="9" r="5.4" fill="none" stroke="${accent}" stroke-width="1.8"/>` +
    `<circle cx="23.5" cy="9" r="2" fill="${accent}"/>`
  )
}

/** The "busy" badge: a three-quarter accent arc. */
function progressBadge(palette: CursorPalette): string {
  const accent = esc(palette.accent)
  const stroke = esc(palette.stroke)
  const d = "M28.2 22.4 A5.8 5.8 0 1 1 22.4 16.6"
  return (
    `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round"/>` +
    `<path d="${d}" fill="none" stroke="${accent}" stroke-width="2.2" stroke-linecap="round"/>`
  )
}

/** Outlined I-beam. Drawn stroke-over-stroke so it survives any backdrop. */
function textGlyph(palette: CursorPalette): string {
  const stroke = esc(palette.stroke)
  const fill = esc(palette.fill)
  const accent = esc(palette.accent)
  const d = "M12.5 7.5 H19.5 M16 7.5 V24.5 M12.5 24.5 H19.5"
  return (
    `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="4.4" stroke-linecap="round"/>` +
    `<path d="${d}" fill="none" stroke="${fill}" stroke-width="2" stroke-linecap="round"/>` +
    `<circle cx="16" cy="16" r="1.4" fill="${accent}"/>`
  )
}

/** Open ring + grip ticks (grab) or contracted disc (grabbing). */
function grabGlyph(palette: CursorPalette, closed: boolean): string {
  const stroke = esc(palette.stroke)
  const fill = esc(palette.fill)
  const accent = esc(palette.accent)
  if (closed) {
    return (
      `<circle cx="16" cy="16" r="6.4" fill="${stroke}"/>` +
      `<circle cx="16" cy="16" r="5" fill="${fill}"/>` +
      `<circle cx="16" cy="16" r="2.4" fill="${accent}"/>`
    )
  }
  const ticks = "M16 4.4 V8 M16 24 V27.6 M4.4 16 H8 M24 16 H27.6"
  return (
    `<circle cx="16" cy="16" r="8.4" fill="none" stroke="${stroke}" stroke-width="4"/>` +
    `<circle cx="16" cy="16" r="8.4" fill="none" stroke="${fill}" stroke-width="2"/>` +
    `<path d="${ticks}" stroke="${stroke}" stroke-width="3.4" stroke-linecap="round"/>` +
    `<path d="${ticks}" stroke="${accent}" stroke-width="1.8" stroke-linecap="round"/>`
  )
}

/** Red circle-slash. Palette contributes only the outline, for legibility. */
function denyGlyph(palette: CursorPalette): string {
  const stroke = esc(palette.stroke)
  return (
    `<circle cx="16" cy="16" r="9.6" fill="none" stroke="${stroke}" stroke-width="5"/>` +
    `<path d="M9.2 9.2 L22.8 22.8" stroke="${stroke}" stroke-width="5" stroke-linecap="round"/>` +
    `<circle cx="16" cy="16" r="9.6" fill="none" stroke="${CURSOR_DENY_COLOR}" stroke-width="3"/>` +
    `<path d="M9.2 9.2 L22.8 22.8" stroke="${CURSOR_DENY_COLOR}" stroke-width="3" stroke-linecap="round"/>`
  )
}

/** Four ticks around an accent centre dot. */
function crosshairGlyph(palette: CursorPalette): string {
  const stroke = esc(palette.stroke)
  const fill = esc(palette.fill)
  const accent = esc(palette.accent)
  const d = "M16 2.6 V12 M16 20 V29.4 M2.6 16 H12 M20 16 H29.4"
  return (
    `<path d="${d}" stroke="${stroke}" stroke-width="4" stroke-linecap="round"/>` +
    `<path d="${d}" stroke="${fill}" stroke-width="1.8" stroke-linecap="round"/>` +
    `<circle cx="16" cy="16" r="2.2" fill="${accent}" stroke="${stroke}" stroke-width="1"/>`
  )
}

/** Compose the drawable body (no `<svg>` wrapper) for one role. */
export function roleMarkup(
  role: CursorRole,
  shape: CursorShapeDef,
  palette: CursorPalette
): string {
  switch (role) {
    case "default":
      return silhouetteMarkup(shape, palette) + (shape.ornament?.(palette) ?? "")
    case "pointer":
      return silhouetteMarkup(shape, palette) + pointerBadge(palette)
    case "progress":
      return silhouetteMarkup(shape, palette) + progressBadge(palette)
    case "text":
      return textGlyph(palette)
    case "grab":
      return grabGlyph(palette, false)
    case "grabbing":
      return grabGlyph(palette, true)
    case "notAllowed":
      return denyGlyph(palette)
    case "crosshair":
      return crosshairGlyph(palette)
  }
}

export interface BuildCursorSvgOptions {
  role: CursorRole
  shape: CursorShapeDef
  palette: CursorPalette
  /** Rendered edge in CSS pixels. */
  sizePx: number
}

/**
 * Build the full standalone SVG document for one role.
 *
 * The glow, when the palette declares one, is a blurred copy of the body drawn
 * underneath. It is inset by widening the viewBox rather than the drawing, so
 * the hotspot maths stays in the untouched 32-unit space.
 */
export function buildCursorSvg({ role, shape, palette, sizePx }: BuildCursorSvgOptions): string {
  const body = roleMarkup(role, shape, palette)
  const crisp = shape.crisp ? ` shape-rendering="crispEdges"` : ""
  const glow = palette.glow
    ? `<g filter="url(#cg)" opacity="0.85">${body}</g>` +
      `<defs><filter id="cg" x="-40%" y="-40%" width="180%" height="180%">` +
      `<feDropShadow dx="0" dy="0" stdDeviation="1.6" flood-color="${esc(palette.glow)}"` +
      ` flood-opacity="0.95"/></filter></defs>`
    : ""
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}"` +
    ` viewBox="0 0 ${CURSOR_VIEWBOX} ${CURSOR_VIEWBOX}"${crisp}>` +
    glow +
    body +
    `</svg>`
  )
}

/**
 * Hotspot in device pixels for a rendered cursor. Browsers take integers; a
 * fractional hotspot is silently truncated, which shifts the click point by up
 * to a pixel — visible on the tall/thin blade and wand shapes, so round here.
 */
export function scaledHotspot(
  role: CursorRole,
  shape: CursorShapeDef,
  sizePx: number
): { x: number; y: number } {
  const hs = roleHotspot(role, shape)
  const k = sizePx / CURSOR_VIEWBOX
  return { x: Math.round(hs.x * k), y: Math.round(hs.y * k) }
}
