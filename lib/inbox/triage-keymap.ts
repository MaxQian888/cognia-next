/**
 * The Inbox list's triage keymap, as pure key → command resolution.
 *
 * Mail-client keys (Gmail / Superhuman / Linear lineage) so muscle memory
 * transfers: `j`/`k` walk the list, `x` checks, `e` archives, `u` flips read.
 * The hook that binds it (`hooks/inbox/use-inbox-triage-keyboard.ts`) only
 * fires it while focus is on the list itself — the list container, a row's
 * own button or its checkbox — and never while a text field, menu or dialog
 * holds the key, so bare letters stay safe.
 *
 * Collisions checked against `lib/shortcuts/app-catalog.ts`:
 *  - `/` is `app.search.focus` (registered by the chat rail and Discover,
 *    neither mounted on `/inbox`). Inside the list it focuses the inbox search
 *    and the event is stopped, so no app-level handler also runs.
 *  - `e` / `s` are `observability.*`, mount-scoped to `/logs`.
 *  - `ctrl+a` / `escape` are `skills.*` and `a2ui.*`, mount-scoped to their
 *    own surfaces.
 *  - No catalog chord uses `j k x u p d i l o ?` or the arrows / Home / End.
 *
 * The table {@link INBOX_TRIAGE_SHORTCUTS} is what the help dialog lists, so
 * the dialog cannot advertise a key the resolver does not honour.
 */

export type TriageMoveTarget = "next" | "prev" | "first" | "last"

export type InboxTriageCommand =
  | { kind: "move"; to: TriageMoveTarget; extend: boolean }
  | { kind: "open" }
  | { kind: "toggleCheck" }
  | { kind: "selectAll" }
  | { kind: "focusSearch" }
  | { kind: "escape" }
  | { kind: "toggleRead" }
  | { kind: "togglePin" }
  | { kind: "toggleArchive" }
  | { kind: "resolve" }
  | { kind: "snooze" }
  | { kind: "assign" }
  | { kind: "label" }
  | { kind: "help" }

export type InboxTriageCommandKind = InboxTriageCommand["kind"]

export interface TriageKeyInput {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  /** An IME composition is in progress: the key belongs to the composer. */
  isComposing?: boolean
}

const LETTER_COMMANDS: Record<string, InboxTriageCommand> = {
  o: { kind: "open" },
  x: { kind: "toggleCheck" },
  u: { kind: "toggleRead" },
  p: { kind: "togglePin" },
  e: { kind: "toggleArchive" },
  d: { kind: "resolve" },
  s: { kind: "snooze" },
  i: { kind: "assign" },
  l: { kind: "label" },
}

/** Resolve one keydown to a command, or `null` when the key is not the list's. */
export function resolveTriageKey(input: TriageKeyInput): InboxTriageCommand | null {
  if (input.isComposing) return null
  // Alt chords are layout characters on many keyboards (AltGr), never ours.
  if (input.altKey) return null
  const mod = input.ctrlKey === true || input.metaKey === true
  const shift = input.shiftKey === true
  const key = input.key

  if (mod) {
    // ⌘A / Ctrl+A is the only modified chord the list claims.
    return !shift && (key === "a" || key === "A") ? { kind: "selectAll" } : null
  }

  switch (key) {
    case "ArrowDown":
      return { kind: "move", to: "next", extend: shift }
    case "ArrowUp":
      return { kind: "move", to: "prev", extend: shift }
    case "Home":
      return { kind: "move", to: "first", extend: shift }
    case "End":
      return { kind: "move", to: "last", extend: shift }
    case "Enter":
      return shift ? null : { kind: "open" }
    case "Escape":
      return { kind: "escape" }
    // `?` is Shift+/ on most layouts; it arrives as the character either way.
    case "?":
      return { kind: "help" }
    case "/":
      return shift ? null : { kind: "focusSearch" }
    default:
      break
  }

  if (key.length !== 1) return null
  const lower = key.toLowerCase()
  if (lower === "j") return { kind: "move", to: "next", extend: shift }
  if (lower === "k") return { kind: "move", to: "prev", extend: shift }
  // Shift+letter is left alone: no shifted triage letter exists, and a
  // capital is what a stuck Caps Lock types.
  if (shift || key !== lower) return null
  return LETTER_COMMANDS[lower] ?? null
}

/** Index to move to from `current` (-1 = nothing yet) in a list of `length`. */
export function triageMoveIndex(current: number, length: number, to: TriageMoveTarget): number {
  if (length <= 0) return -1
  const last = length - 1
  switch (to) {
    case "first":
      return 0
    case "last":
      return last
    case "next":
      return current < 0 ? 0 : Math.min(last, current + 1)
    case "prev":
      return current < 0 ? last : Math.max(0, current - 1)
  }
}

/**
 * One line of the help dialog. `keys` is a list of alternatives, each a list
 * of key tokens pressed together; a token is either a literal key (`j`, `/`)
 * or one of the named tokens the dialog translates (`mod`, `shift`, `enter`,
 * `escape`, `up`, `down`, `home`, `end`).
 */
export type TriageShortcutId =
  "next" | "prev" | "edges" | "extend" | Exclude<InboxTriageCommandKind, "move">

export interface TriageShortcutEntry {
  /** Also the help dialog's i18n key (`inbox.shortcuts.actions.<id>`). */
  id: TriageShortcutId
  /** Help-dialog group. */
  group: "navigate" | "select" | "triage"
  keys: ReadonlyArray<ReadonlyArray<string>>
}

export const INBOX_TRIAGE_SHORTCUTS: readonly TriageShortcutEntry[] = [
  { id: "next", group: "navigate", keys: [["j"], ["down"]] },
  { id: "prev", group: "navigate", keys: [["k"], ["up"]] },
  { id: "edges", group: "navigate", keys: [["home"], ["end"]] },
  { id: "open", group: "navigate", keys: [["enter"], ["o"]] },
  { id: "focusSearch", group: "navigate", keys: [["/"]] },
  { id: "help", group: "navigate", keys: [["?"]] },
  { id: "toggleCheck", group: "select", keys: [["x"]] },
  {
    id: "extend",
    group: "select",
    keys: [
      ["shift", "j"],
      ["shift", "k"],
    ],
  },
  { id: "selectAll", group: "select", keys: [["mod", "a"]] },
  { id: "escape", group: "select", keys: [["escape"]] },
  { id: "toggleRead", group: "triage", keys: [["u"]] },
  { id: "togglePin", group: "triage", keys: [["p"]] },
  { id: "toggleArchive", group: "triage", keys: [["e"]] },
  { id: "resolve", group: "triage", keys: [["d"]] },
  { id: "snooze", group: "triage", keys: [["s"]] },
  { id: "assign", group: "triage", keys: [["i"]] },
  { id: "label", group: "triage", keys: [["l"]] },
]
