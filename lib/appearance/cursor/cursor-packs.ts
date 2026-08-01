// The built-in cursor packs.
//
// The catalogue is deliberately a survey of what desktop cursor design has
// actually converged on, rather than eleven variations of one idea:
//
//   classic — the two platform idioms (a light arrow with a dark outline, and
//             a dark arrow with a light one), the brush-drawn take, and the
//             high-visibility yellow cursor that every OS ships as an
//             accessibility option and that nobody offers inside an app.
//   playful — the pixel-art and neon-outline looks that dominate the custom
//             cursor scene.
//   anime   — the 二次元 set: sakura petal, magic wand, cat paw, mecha HUD
//             reticle, and a katana blade.
//
// A pack is a silhouette + four colors (see `cursor-art.ts`); everything else
// is composed. Packs may declare a *subset* of roles — `graphite` deliberately
// does, see its note — and undeclared roles keep the native OS cursor.

import type { CursorPack, CursorPackFamily, CursorRole } from "@/types/appearance"
import { CURSOR_ROLES, SYSTEM_CURSOR_PACK_ID } from "@/types/appearance"

/** Every role. Most packs paint the full set. */
const ALL_ROLES: readonly CursorRole[] = CURSOR_ROLES

/**
 * Platform-deferring subset. The "busy", "forbidden", and "crosshair" cursors
 * are OS affordances users read at a glance, so the pack whose whole point is
 * to look native hands those three back to the platform instead of restyling
 * them. This is also the case that keeps the subset path exercised.
 */
const NATIVE_DEFERRING_ROLES: readonly CursorRole[] = [
  "default",
  "pointer",
  "text",
  "grab",
  "grabbing",
]

export const CURSOR_PACKS: readonly CursorPack[] = [
  // ── classic ───────────────────────────────────────────────────────────────
  {
    id: "aero",
    name: "Aero",
    family: "classic",
    shape: "arrow",
    palette: { fill: "#ffffff", stroke: "#2b2b30", accent: "#2f7bf6" },
    roles: ALL_ROLES,
  },
  {
    id: "graphite",
    name: "Graphite",
    family: "classic",
    shape: "graphite",
    palette: { fill: "#1c1c1e", stroke: "#f7f7f8", accent: "#0a84ff" },
    roles: NATIVE_DEFERRING_ROLES,
  },
  {
    id: "beacon",
    name: "Beacon",
    family: "classic",
    shape: "arrow",
    // The accessibility high-visibility cursor: maximum-chroma yellow on pure
    // black, sized up by the user's scale slider. Not a novelty — it is the
    // one pack that stays findable on a busy wallpaper.
    palette: { fill: "#ffe000", stroke: "#000000", accent: "#ff5f00" },
    roles: ALL_ROLES,
  },
  {
    id: "ink",
    name: "Ink",
    family: "classic",
    shape: "ink",
    palette: { fill: "#17171a", stroke: "#f5f0e6", accent: "#c0392b" },
    roles: ALL_ROLES,
  },

  // ── playful ───────────────────────────────────────────────────────────────
  {
    id: "pixel",
    name: "Pixel",
    family: "playful",
    shape: "pixel",
    palette: { fill: "#f7f7f7", stroke: "#1a1a1a", accent: "#ff3b5c" },
    roles: ALL_ROLES,
  },
  {
    id: "neon",
    name: "Neon",
    family: "playful",
    shape: "neon",
    palette: { fill: "#6ef3ff", stroke: "#06202b", accent: "#ff4fd8", glow: "#22d3ee" },
    roles: ALL_ROLES,
  },

  // ── anime (二次元) ────────────────────────────────────────────────────────
  {
    id: "sakura",
    name: "Sakura",
    family: "anime",
    shape: "petal",
    palette: { fill: "#ffd7e6", stroke: "#a83258", accent: "#ff5f9e", glow: "#ff9ec4" },
    roles: ALL_ROLES,
  },
  {
    id: "mahou",
    name: "Mahou",
    family: "anime",
    shape: "wand",
    palette: { fill: "#f3e8ff", stroke: "#4c1d95", accent: "#a855f7", glow: "#c084fc" },
    roles: ALL_ROLES,
  },
  {
    id: "neko",
    name: "Neko",
    family: "anime",
    shape: "paw",
    palette: { fill: "#fff1e6", stroke: "#7c4a2d", accent: "#ff9f68" },
    roles: ALL_ROLES,
  },
  {
    id: "mecha",
    name: "Mecha",
    family: "anime",
    shape: "reticle",
    palette: { fill: "#d7f5ff", stroke: "#07222f", accent: "#ffd166", glow: "#38bdf8" },
    roles: ALL_ROLES,
  },
  {
    id: "katana",
    name: "Katana",
    family: "anime",
    shape: "blade",
    palette: { fill: "#f8fafc", stroke: "#1e293b", accent: "#e11d48" },
    roles: ALL_ROLES,
  },
]

export const CURSOR_PACKS_BY_ID: ReadonlyMap<string, CursorPack> = new Map(
  CURSOR_PACKS.map((p) => [p.id, p])
)

/** Display order for the picker's family sections. */
export const CURSOR_PACK_FAMILIES: readonly CursorPackFamily[] = ["classic", "playful", "anime"]

/**
 * Resolve a pack id. Returns `null` for the system sentinel and for ids that no
 * longer exist (a pack removed in an upgrade, or a settings row hand-edited) —
 * the applier reads `null` as "use the OS cursor", which is the safe direction
 * to fail in.
 */
export function getCursorPack(id: string | undefined): CursorPack | null {
  if (!id || id === SYSTEM_CURSOR_PACK_ID) return null
  return CURSOR_PACKS_BY_ID.get(id) ?? null
}

/** Packs in one family, in catalogue order. */
export function packsInFamily(family: CursorPackFamily): CursorPack[] {
  return CURSOR_PACKS.filter((p) => p.family === family)
}
