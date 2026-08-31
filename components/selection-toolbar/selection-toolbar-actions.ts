/**
 * The toolbar's action table — one row per button, and the only place the six
 * actions are enumerated on the renderer side.
 *
 * Three things have to agree about these actions: the capsule (icon, label,
 * order), the state machine (does clicking this leave the toolbar on screen?),
 * and the global shortcut registry (which chord fires which button). Keeping
 * them in one table is what stops those three from drifting; the Rust
 * `SelectionToolbarAction` enum and `SELECTION_ACTION_SHORTCUTS` are the
 * matching half in `src-tauri/src/selection_toolbar.rs`.
 */

import {
  ArrowRightLeftIcon,
  BrainIcon,
  ClipboardIcon,
  ExternalLinkIcon,
  LanguagesIcon,
  MailIcon,
  MessageCircleQuestionIcon,
  SearchIcon,
  SparklesIcon,
  Volume2Icon,
  type LucideIcon,
} from "lucide-react"

import type { SelectionContentType } from "@/lib/selection/classify-selection"

export const SELECTION_TRANSLATE_LOCALE_PREF = "selectionToolbar.translateLocale"
/**
 * Escape hatch for users who would rather the row never changed shape.
 * Defaults on — the contextual actions are the point of this feature — but a
 * toolbar whose buttons move is a legitimate thing to dislike.
 */
export const SELECTION_CONTEXTUAL_ACTIONS_PREF = "selectionToolbar.contextualActions"

export const TARGET_LOCALES = ["zh-CN", "en", "ja", "ko", "fr", "de", "es"] as const
export type TargetLocale = (typeof TARGET_LOCALES)[number]

export function initialTargetLocale(locale: string): TargetLocale {
  if (locale.toLowerCase().startsWith("zh")) return "zh-CN"
  const language = locale.split("-")[0]
  return TARGET_LOCALES.includes(language as TargetLocale) ? (language as TargetLocale) : "en"
}

/**
 * The six stable actions, plus four that appear only when the selection calls
 * for them. The split matters everywhere below: the six are always candidates
 * and own the `⌥⇧1`–`⌥⇧6` chords, the four never own a chord and never appear
 * unbidden.
 */
export type SelectionActionId =
  | "copy"
  | "explain"
  | "translate"
  | "ask"
  | "remember"
  | "speak"
  | "openLink"
  | "composeEmail"
  | "searchWeb"
  | "convertUnit"

/**
 * What happens to the toolbar after the action is dispatched.
 *
 * - `local`   — Rust does it (clipboard). Show a ✓, then leave.
 * - `handoff` — the main window takes over and comes forward; the user's
 *               attention has moved, so leave immediately.
 * - `await`   — the main window works in the background and reports back. Stay
 *               put: the PII gate *returns* a failure rather than throwing, so
 *               leaving here would make a blocked memory a silent no-op.
 * - `launch`  — hands off to something outside Cognia entirely (the browser,
 *               the mail client). Neither we nor the main window come forward,
 *               and the toolbar leaves at once.
 *
 * `launch` is why Rust can no longer derive "does the toolbar stay" as
 * `!focuses_main()`: it is the first mode that answers no to both.
 */
export type SelectionActionMode = "local" | "handoff" | "await" | "launch"

export interface SelectionActionDescriptor {
  id: string
  icon: LucideIcon
  /** Key under the `selectionToolbar` namespace. */
  labelKey?: SelectionActionId
  /** Host-resolved label for plugin-contributed actions. */
  label?: string
  /**
   * Matches an id in the Rust `SELECTION_ACTION_SHORTCUTS` table.
   *
   * Absent for contextual actions on purpose. A chord that only works when the
   * selection happens to be a URL is worse than no chord: the user cannot
   * build a habit on it, and it would have to be stolen from a stable action
   * to exist at all.
   */
  shortcutId?: string
  mode: SelectionActionMode
  /** Renders the language split-button next to it. */
  hasLocalePicker?: boolean
  /**
   * Content type that must be present for this action to appear. Absent means
   * generic — always a candidate.
   */
  requires?: SelectionContentType
  /**
   * Eviction order among the generic six when contextual actions need room.
   * Higher goes first; `copy` is `0` and is never evicted.
   */
  priority: number
  pluginActionId?: string
  isMore?: boolean
  children?: Array<{ id: string; title: string }>
  /**
   * Who contributed this action, in the words the user would recognise: the
   * plugin's display name, or "Cognia" for the host's own extras.
   *
   * Rendered as the muted end of an overflow row. The panel used to derive
   * that from `pluginActionId.split(":")[0]`, which prints a registry id where
   * a product name belongs.
   */
  attribution?: string
  /**
   * Plugin-declared chord, already bound through the plugin shortcut bridge.
   *
   * Separate from `shortcutId` because the two resolve differently: the six
   * stable actions look their chord up in the live registry (the user may have
   * re-bound it), while a plugin ships a literal accelerator with its manifest.
   */
  accelerator?: string
}

export const SELECTION_ACTIONS: readonly SelectionActionDescriptor[] = [
  {
    id: "copy",
    icon: ClipboardIcon,
    labelKey: "copy",
    shortcutId: "selection.copy",
    mode: "local",
    priority: 0,
  },
  {
    id: "explain",
    icon: SparklesIcon,
    labelKey: "explain",
    shortcutId: "selection.explain",
    mode: "handoff",
    priority: 1,
  },
  {
    id: "translate",
    icon: LanguagesIcon,
    labelKey: "translate",
    shortcutId: "selection.translate",
    mode: "handoff",
    hasLocalePicker: true,
    priority: 2,
  },
  {
    id: "ask",
    icon: MessageCircleQuestionIcon,
    labelKey: "ask",
    shortcutId: "selection.ask",
    mode: "handoff",
    priority: 3,
  },
  {
    id: "remember",
    icon: BrainIcon,
    labelKey: "remember",
    shortcutId: "selection.remember",
    mode: "await",
    priority: 4,
  },
  {
    id: "speak",
    icon: Volume2Icon,
    labelKey: "speak",
    shortcutId: "selection.speak",
    mode: "await",
    priority: 5,
  },
  // Contextual. No chord, hidden unless the classifier says so.
  {
    id: "openLink",
    icon: ExternalLinkIcon,
    labelKey: "openLink",
    mode: "launch",
    requires: "url",
    priority: 100,
  },
  {
    id: "composeEmail",
    icon: MailIcon,
    labelKey: "composeEmail",
    mode: "launch",
    requires: "email",
    priority: 100,
  },
  {
    id: "searchWeb",
    icon: SearchIcon,
    labelKey: "searchWeb",
    mode: "launch",
    requires: "term",
    priority: 100,
  },
  {
    id: "convertUnit",
    icon: ArrowRightLeftIcon,
    labelKey: "convertUnit",
    mode: "handoff",
    requires: "measurement",
    priority: 100,
  },
] as const

/**
 * AX subrole of a password field.
 *
 * Rust already refuses to read secure fields, so nothing downstream of this
 * constant should ever see one. It exists so the three places that act on that
 * fact name it once instead of spelling the literal out again.
 */
export const SECURE_TEXT_FIELD_SUBROLE = "AXSecureTextField"

/** Whether this candidate came out of a password field. */
export function selectionIsSecure(candidate: { sourceSubrole?: string }): boolean {
  return candidate.sourceSubrole === SECURE_TEXT_FIELD_SUBROLE
}

/** How many buttons the capsule will show at once. */
export const MAX_VISIBLE_ACTIONS = 6
/** How many contextual actions may appear together. */
export const MAX_MATCHED_CONTEXTUAL = 2

/**
 * Actions that make no sense for this particular selection, whatever the
 * classifier said.
 *
 * Both rules are about trust, not taste:
 *
 * - A password field's contents must never reach an action at all. Rust
 *   already refuses to read secure fields, so this is defence in depth — but
 *   a password fragment reaching a model is not a failure worth relying on
 *   one layer for.
 * - A URL that came from OCR is the single string most likely to be
 *   misrecognized (`rn` → `m` is a real typosquat vector), and opening it
 *   acts on that mistake immediately. Searching for it cannot hurt, so
 *   `searchWeb` survives as the safe downgrade.
 */
export function isActionSuppressed(
  action: SelectionActionDescriptor,
  candidate: { origin?: string; sourceSubrole?: string }
): boolean {
  if (selectionIsSecure(candidate)) return true
  if (candidate.origin === "ocr") {
    return action.id === "openLink" || action.id === "composeEmail"
  }
  return false
}

const GENERIC_ACTIONS = SELECTION_ACTIONS.filter((action) => action.requires === undefined)
const CONTEXTUAL_ACTIONS = SELECTION_ACTIONS.filter((action) => action.requires !== undefined)

/**
 * Which buttons this selection gets, in render order.
 *
 * Contextual actions render at the tail, and eviction happens at the tail too.
 * That pairing is what keeps the capsule calm: the generic action that gets
 * dropped is the last one, and the contextual action that arrives takes
 * exactly its slot — so the row length never changes and no generic button
 * ever shifts sideways. Putting new actions at the head would have been more
 * eye-catching and would have moved all six icons every time a URL was
 * selected.
 */
export function resolveVisibleActions(input: {
  types: readonly SelectionContentType[]
  candidate: { origin?: string; sourceSubrole?: string }
  contextualEnabled: boolean
}): readonly SelectionActionDescriptor[] {
  const { types, candidate, contextualEnabled } = input

  if (selectionIsSecure(candidate)) return []
  if (!contextualEnabled) return GENERIC_ACTIONS

  const matched = CONTEXTUAL_ACTIONS.filter(
    (action) =>
      action.requires !== undefined &&
      types.includes(action.requires) &&
      !isActionSuppressed(action, candidate)
  ).slice(0, MAX_MATCHED_CONTEXTUAL)

  if (matched.length === 0) return GENERIC_ACTIONS

  // Foreign text is the one case where a generic action earns a promotion:
  // translating is now the likeliest intent, so it should not be what gets
  // evicted to make room.
  const promoteTranslate = types.includes("foreignLanguage")
  const kept = [...GENERIC_ACTIONS]
  const evictionOrder = [...kept].sort((a, b) => {
    const aPriority = promoteTranslate && a.id === "translate" ? 1 : a.priority
    const bPriority = promoteTranslate && b.id === "translate" ? 1 : b.priority
    return bPriority - aPriority
  })

  // Keyed by the descriptor's own id type, which is `string` now that plugin
  // actions share this shape. A narrower set here does not make the loop any
  // safer, it just fails to compile.
  const evicted = new Set<string>()
  for (const action of evictionOrder) {
    if (kept.length - evicted.size + matched.length <= MAX_VISIBLE_ACTIONS) break
    if (action.id === "copy") continue
    evicted.add(action.id)
  }

  return [...kept.filter((action) => !evicted.has(action.id)), ...matched]
}

/**
 * Resolve a fired chord to its action.
 *
 * Deliberately searches the WHOLE table, never the visible list: `⌥⇧6` must
 * still read aloud when `speak` has been evicted to make room for a contextual
 * action. The chords belong to the six stable ids, not to whatever the capsule
 * happens to be showing — that is the entire point of not giving contextual
 * actions chords.
 *
 * The `shortcutId` guard matters now that it is optional: without it a lookup
 * for `undefined` would match the first contextual row.
 */
export function findActionByShortcutId(
  shortcutId: string | undefined
): SelectionActionDescriptor | undefined {
  if (!shortcutId) return undefined
  return SELECTION_ACTIONS.find((action) => action.shortcutId === shortcutId)
}

export function findAction(id: string): SelectionActionDescriptor | undefined {
  return SELECTION_ACTIONS.find((action) => action.id === id)
}
