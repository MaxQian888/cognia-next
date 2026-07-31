/**
 * Translate a stored canvas keybinding string (e.g. `"Ctrl+Shift+S"`,
 * `"Alt+]"`, or the chord `"Ctrl+K Ctrl+0"`) into a Monaco keybinding number
 * (`KeyMod | KeyCode`, or `KeyMod.chord(a, b)` for two-stroke chords).
 *
 * The keybinding store (`stores/canvas/keybinding-store.ts`) persists combos in
 * the shared `lib/shortcuts/utils.ts` shape: `+`-joined parts, whitespace
 * separating the two strokes of a chord, `Ctrl`/`Meta` folded to the canonical
 * "command" modifier. Monaco is dynamic-imported, so the caller passes the live
 * `monaco` namespace and we read `KeyMod`/`KeyCode` off it.
 *
 * Returns `null` when any stroke has no resolvable non-modifier key (an empty
 * combo, a modifier-only combo, or an unmapped key) so callers can skip
 * registering that action rather than binding a bogus keycode.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Monaco is dynamic-imported; its types aren't reliably available at this layer.
type MonacoNamespace = any

/** Non-letter/digit key-name → Monaco `KeyCode` member name. */
const KEY_CODE_NAME: Record<string, string> = {
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "UpArrow",
  arrowup: "UpArrow",
  down: "DownArrow",
  arrowdown: "DownArrow",
  left: "LeftArrow",
  arrowleft: "LeftArrow",
  right: "RightArrow",
  arrowright: "RightArrow",
  "]": "BracketRight",
  "[": "BracketLeft",
  ".": "Period",
  ",": "Comma",
  "/": "Slash",
  "\\": "Backslash",
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  ";": "Semicolon",
  "'": "Quote",
}

const MODIFIERS = new Set(["ctrl", "control", "meta", "cmd", "command", "alt", "option", "shift"])

/** Resolve a single non-modifier key token to a Monaco `KeyCode` value, or null. */
function resolveKeyCode(token: string, monaco: MonacoNamespace): number | null {
  const KeyCode = monaco?.KeyCode
  if (!KeyCode) return null
  const lower = token.toLowerCase()

  // Single letter a–z.
  if (/^[a-z]$/.test(lower)) {
    const code = KeyCode[`Key${lower.toUpperCase()}`]
    return typeof code === "number" ? code : null
  }
  // Single digit 0–9.
  if (/^[0-9]$/.test(lower)) {
    const code = KeyCode[`Digit${lower}`]
    return typeof code === "number" ? code : null
  }
  // Function keys F1–F19.
  const fnMatch = /^f([1-9]|1[0-9])$/.exec(lower)
  if (fnMatch) {
    const code = KeyCode[`F${fnMatch[1]}`]
    return typeof code === "number" ? code : null
  }
  // Named / punctuation keys.
  const name = KEY_CODE_NAME[lower]
  if (name) {
    const code = KeyCode[name]
    return typeof code === "number" ? code : null
  }
  return null
}

/** Combine one stroke's `+`-joined parts into a `KeyMod | KeyCode` number, or null. */
function resolveStroke(stroke: string, monaco: MonacoNamespace): number | null {
  const KeyMod = monaco?.KeyMod
  if (!KeyMod) return null

  const parts = stroke
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null

  let mods = 0
  let keyCode: number | null = null

  for (const part of parts) {
    const lower = part.toLowerCase()
    if (MODIFIERS.has(lower)) {
      if (
        lower === "ctrl" ||
        lower === "control" ||
        lower === "meta" ||
        lower === "cmd" ||
        lower === "command"
      ) {
        mods |= KeyMod.CtrlCmd
      } else if (lower === "alt" || lower === "option") {
        mods |= KeyMod.Alt
      } else if (lower === "shift") {
        mods |= KeyMod.Shift
      }
      continue
    }
    // Only one non-modifier key per stroke is meaningful; last one wins.
    const resolved = resolveKeyCode(part, monaco)
    if (resolved === null) return null
    keyCode = resolved
  }

  if (keyCode === null) return null
  return mods | keyCode
}

export function keyComboToMonaco(combo: string, monaco: MonacoNamespace): number | null {
  if (!combo || !monaco?.KeyMod || !monaco?.KeyCode) return null

  // Chords are whitespace-separated ("Ctrl+K Ctrl+0"); at most two strokes.
  const strokes = combo.trim().split(/\s+/).filter(Boolean)
  if (strokes.length === 0) return null

  if (strokes.length === 1) {
    return resolveStroke(strokes[0], monaco)
  }

  const first = resolveStroke(strokes[0], monaco)
  const second = resolveStroke(strokes[1], monaco)
  if (first === null || second === null) return null
  return monaco.KeyMod.chord(first, second)
}
