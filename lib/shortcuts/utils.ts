// Chord-normalisation, key-event capture, and platform-aware formatting.
// Extracted from `stores/canvas/keybinding-store.ts` so both the canvas
// keybinding UI and the new unified shortcut panel can share one
// implementation. Behaviour is intentionally identical to the original
// canvas helpers — see `lib/shortcuts/utils.test.ts` for the ported
// regression cases.

import type { Chord } from "./types"

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "meta"] as const

/**
 * Canonicalises a chord string so equivalent expressions compare equal:
 *   - whitespace stripped
 *   - lowercase
 *   - modifiers sorted in `ctrl → alt → shift → meta` order
 *   - non-modifier keys sorted lexicographically among themselves
 *
 * Returns the chord joined with `+`. Identity for chords already in
 * canonical form.
 */
export function normalizeKeyCombo(keyCombo: string): Chord {
  return keyCombo
    .split("+")
    .map((key) => key.trim().toLowerCase())
    .sort((a, b) => {
      const aIdx = MODIFIER_ORDER.indexOf(a as (typeof MODIFIER_ORDER)[number])
      const bIdx = MODIFIER_ORDER.indexOf(b as (typeof MODIFIER_ORDER)[number])
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx
      if (aIdx !== -1) return -1
      if (bIdx !== -1) return 1
      return a.localeCompare(b)
    })
    .join("+")
}

/**
 * Reads a `KeyboardEvent` and returns a chord string in the same shape the
 * settings UI persists. `Ctrl` and `Meta` are folded together so a single
 * binding works on both Windows/Linux and macOS — the renderer treats them
 * as the platform-canonical "command" modifier.
 */
export function parseKeyEvent(event: KeyboardEvent): Chord {
  const parts: string[] = []

  if (event.ctrlKey || event.metaKey) parts.push("Ctrl")
  if (event.altKey) parts.push("Alt")
  if (event.shiftKey) parts.push("Shift")

  // The Space key reports `event.key === " "`, which would normalize to an empty
  // token; name it so chords like `ctrl+shift+space` round-trip (matching the
  // Rust chord grammar). `+` and `_` are the Shift-variants of the `=` and `-`
  // physical keys — fold them to the unshifted key so a chord can never contain
  // `+` (which is also the token separator) and so e.g. Ctrl+= and Ctrl+Shift+=
  // address the same binding, the convention VS Code uses for zoom.
  const raw =
    event.key === " " ? "Space" : event.key === "+" ? "=" : event.key === "_" ? "-" : event.key
  const key = raw.length === 1 ? raw.toUpperCase() : raw
  if (!["Control", "Alt", "Shift", "Meta"].includes(key)) {
    parts.push(key)
  }

  return parts.join("+")
}

/**
 * `ctrl` and `meta` are folded together when a chord is captured (see
 * `parseKeyEvent`), so on macOS both render as `⌘` — the stored chord names the
 * platform's command modifier, not a specific physical key.
 */
const MAC_GLYPHS: Record<string, string> = {
  ctrl: "⌘",
  control: "⌘",
  cmd: "⌘",
  meta: "⌘",
  super: "⌘",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
}

const PC_LABELS: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  cmd: "Win",
  meta: "Win",
  super: "Win",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
}

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.includes("Mac")
}

/**
 * Renders a stored chord using platform-appropriate glyphs. On macOS the
 * modifiers collapse to symbols (`⌘ ⌥ ⇧`) with no `+` separator, matching
 * the OS menu-bar convention; everywhere else the `+`-separated form is
 * kept. Single-character keys are upper-cased, as both conventions write them.
 *
 * @param isMac Override the platform sniff. The selection-toolbar overlay has
 *   to pass this: it renders in a window that never hydrates the app stores and
 *   already resolves the platform itself, and two renderings of one stored
 *   chord — `⌃` here, `⌘` in Settings — is exactly the drift this shared
 *   implementation exists to prevent.
 */
export function formatKeybinding(keyCombo: Chord, isMac: boolean = isMacPlatform()): string {
  const glyphs = isMac ? MAC_GLYPHS : PC_LABELS

  return keyCombo
    .split("+")
    .map((key) => {
      const lower = key.trim().toLowerCase()
      const glyph = glyphs[lower]
      if (glyph) return glyph
      return lower.length === 1 ? lower.toUpperCase() : key.trim()
    })
    .join(isMac ? "" : "+")
}
