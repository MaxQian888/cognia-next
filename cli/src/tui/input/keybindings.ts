/**
 * Customizable keyboard bindings for the chord-style actions (Ctrl-combos).
 *
 * Only the ctrl-chord actions are rebindable — the semantic keys (Return, Esc,
 * Tab, arrows, Backspace) stay hardcoded in {@link interpretKey} because
 * rebinding them would destabilize core editing. {@link DEFAULT_KEYBINDINGS}
 * reproduces the historic bindings byte-for-byte, so a user who never customizes
 * sees zero behavior change.
 *
 * Pure: parsing/matching/resolution take plain values, so the whole module
 * unit-tests without Ink. `App.tsx` and `keymap.ts` consume the resolved table.
 */
import type { KeyFlags } from "./keymap"

/** The actions a user may rebind. Order is the display order in the settings panel. */
export const KEYBINDABLE_ACTIONS = [
  "inspect",
  "agentsPanel",
  "verboseToggle",
  "collapseAll",
  "find",
  "historySearch",
  "pasteImage",
  "workflowInspect",
  "lineHome",
  "lineEnd",
  "deleteWord",
  "lineKillToStart",
  "lineKillToEnd",
  "undo",
  "redo",
  "copyLast",
  "clearScreen",
] as const

export type KeybindableAction = (typeof KEYBINDABLE_ACTIONS)[number]

/** Default key spec for each action — the historic, pre-customization bindings. */
export const DEFAULT_KEYBINDINGS: Record<KeybindableAction, string> = {
  inspect: "ctrl+g",
  agentsPanel: "ctrl+b",
  verboseToggle: "ctrl+o",
  collapseAll: "ctrl+t",
  find: "ctrl+f",
  historySearch: "ctrl+r",
  pasteImage: "ctrl+v",
  workflowInspect: "ctrl+i",
  lineHome: "ctrl+a",
  lineEnd: "ctrl+e",
  deleteWord: "ctrl+w",
  lineKillToStart: "ctrl+u",
  lineKillToEnd: "ctrl+k",
  undo: "ctrl+z",
  redo: "ctrl+y",
  copyLast: "ctrl+p",
  clearScreen: "ctrl+l",
}

/** Human-readable labels for the settings-panel rows. */
export const KEYBINDING_LABELS: Record<KeybindableAction, string> = {
  inspect: "Inspect tool output",
  agentsPanel: "Open running-agents panel",
  verboseToggle: "Toggle detail mode",
  collapseAll: "Expand / collapse all",
  find: "Find in transcript",
  historySearch: "Search composer history",
  pasteImage: "Paste image from clipboard",
  workflowInspect: "Inspect workflow step",
  lineHome: "Move to line start",
  lineEnd: "Move to line end",
  deleteWord: "Delete word left",
  lineKillToStart: "Delete to line start",
  lineKillToEnd: "Delete to line end",
  undo: "Undo edit",
  redo: "Redo edit",
  copyLast: "Copy last reply",
  clearScreen: "Clear screen",
}

export interface ParsedKeySpec {
  ctrl: boolean
  shift: boolean
  meta: boolean
  /** The base key — a single lowercase character (e.g. `"o"`). */
  key: string
}

const MODIFIERS = new Set(["ctrl", "shift", "meta", "alt", "cmd", "option"])

/**
 * Parse a key spec like `"ctrl+o"` / `"ctrl+shift+x"` into its modifiers + base
 * key. Case-insensitive; `alt`/`option` and `cmd` are treated as `meta`. Returns
 * null for an empty/modifier-only spec or a multi-character base key.
 */
export function parseKeySpec(spec: string): ParsedKeySpec | null {
  const parts = spec
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length === 0) return null
  let ctrl = false
  let shift = false
  let meta = false
  let key: string | undefined
  for (const part of parts) {
    if (part === "ctrl") ctrl = true
    else if (part === "shift") shift = true
    else if (part === "meta" || part === "alt" || part === "cmd" || part === "option") meta = true
    else if (MODIFIERS.has(part)) continue
    else key = part
  }
  if (!key || key.length !== 1) return null
  return { ctrl, shift, meta, key }
}

/** How long a leader-chord prefix stays armed before it lapses (OpenCode's
 * `leader_timeout` default). */
export const LEADER_TIMEOUT_MS = 2000

/**
 * Parse a spec that may be a single chord (`"ctrl+o"`) or an OpenCode-style
 * leader sequence (`"ctrl+x n"` — leader, then action key). Space-separated;
 * at most two steps. Null when any step is malformed.
 */
export function parseKeySequence(spec: string): ParsedKeySpec[] | null {
  const steps = spec.trim().split(/\s+/).filter(Boolean)
  if (steps.length === 0 || steps.length > 2) return null
  const parsed = steps.map(parseKeySpec)
  return parsed.every((p): p is ParsedKeySpec => p !== null) ? parsed : null
}

function matchParsed(p: ParsedKeySpec, input: string, key: KeyFlags): boolean {
  return (
    Boolean(key.ctrl) === p.ctrl &&
    Boolean(key.shift) === p.shift &&
    Boolean(key.meta) === p.meta &&
    input.toLowerCase() === p.key
  )
}

function formatParsed(p: ParsedKeySpec): string {
  const mods: string[] = []
  if (p.ctrl) mods.push("Ctrl")
  if (p.meta) mods.push("Alt")
  if (p.shift) mods.push("Shift")
  return [...mods, p.key.toUpperCase()].join("+")
}

/** Canonical display form of a spec, e.g. `"ctrl+o"` → `"Ctrl+O"`, a leader
 * sequence `"ctrl+x n"` → `"Ctrl+X N"`. Invalid → "—". */
export function formatKeySpec(spec: string): string {
  const seq = parseKeySequence(spec)
  if (!seq) return "—"
  return seq.map(formatParsed).join(" ")
}

/** Does a raw Ink key event match a parsed spec? */
export function matchKeySpec(spec: string, input: string, key: KeyFlags): boolean {
  const p = parseKeySpec(spec)
  if (!p) return false
  return (
    Boolean(key.ctrl) === p.ctrl &&
    Boolean(key.shift) === p.shift &&
    Boolean(key.meta) === p.meta &&
    input.toLowerCase() === p.key
  )
}

/**
 * Merge user overrides onto the defaults. An override that doesn't parse is
 * ignored (the default is kept), so a malformed `config.json` never breaks input.
 */
export function resolveKeybindings(
  overrides: Record<string, string> | undefined
): Record<KeybindableAction, string> {
  const out: Record<KeybindableAction, string> = { ...DEFAULT_KEYBINDINGS }
  if (!overrides) return out
  for (const action of KEYBINDABLE_ACTIONS) {
    const spec = overrides[action]
    if (typeof spec === "string" && parseKeySequence(spec)) out[action] = spec
  }
  return out
}

/** What one key event resolves to under chord-aware matching. */
export type ChordResolution =
  | { kind: "action"; action: KeybindableAction }
  /** The event armed a leader prefix (canonical form, e.g. `"Ctrl+X"`); the
   * caller stores it and passes it back with the next event. */
  | { kind: "prefix"; prefix: string }
  | { kind: "none" }

/**
 * Chord-aware event resolution. With no pending prefix: a single-step binding
 * that matches wins; otherwise an event matching the FIRST step of any
 * two-step binding arms that prefix (the event is consumed). With a pending
 * prefix: only the second steps of matching sequences are considered — a miss
 * resolves to `none` and the caller lets the key flow on normally.
 */
export function resolveChordEvent(
  bindings: Record<KeybindableAction, string>,
  input: string,
  key: KeyFlags,
  pendingPrefix: string | null
): ChordResolution {
  if (pendingPrefix) {
    for (const action of KEYBINDABLE_ACTIONS) {
      const seq = parseKeySequence(bindings[action])
      if (
        seq?.length === 2 &&
        formatParsed(seq[0]) === pendingPrefix &&
        matchParsed(seq[1], input, key)
      ) {
        return { kind: "action", action }
      }
    }
    return { kind: "none" }
  }
  for (const action of KEYBINDABLE_ACTIONS) {
    const seq = parseKeySequence(bindings[action])
    if (seq?.length === 1 && matchParsed(seq[0], input, key)) return { kind: "action", action }
  }
  for (const action of KEYBINDABLE_ACTIONS) {
    const seq = parseKeySequence(bindings[action])
    if (seq?.length === 2 && matchParsed(seq[0], input, key)) {
      return { kind: "prefix", prefix: formatParsed(seq[0]) }
    }
  }
  return { kind: "none" }
}

/**
 * Find which bound action a raw key event triggers, or undefined. The first
 * match wins (a conflict resolves to the earliest action in {@link KEYBINDABLE_ACTIONS}).
 */
export function matchAction(
  bindings: Record<KeybindableAction, string>,
  input: string,
  key: KeyFlags
): KeybindableAction | undefined {
  for (const action of KEYBINDABLE_ACTIONS) {
    if (matchKeySpec(bindings[action], input, key)) return action
  }
  return undefined
}

/** Group actions that resolve to the same canonical key (binding conflicts). */
export function findKeybindingConflicts(
  bindings: Record<KeybindableAction, string>
): Record<string, KeybindableAction[]> {
  const byKey: Record<string, KeybindableAction[]> = {}
  for (const action of KEYBINDABLE_ACTIONS) {
    const k = formatKeySpec(bindings[action])
    if (k === "—") continue
    ;(byKey[k] ??= []).push(action)
  }
  const conflicts: Record<string, KeybindableAction[]> = {}
  for (const [k, actions] of Object.entries(byKey)) {
    if (actions.length > 1) conflicts[k] = actions
  }
  return conflicts
}
