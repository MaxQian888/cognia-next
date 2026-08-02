// Turning an authored tray-panel action + the form values the user typed into
// a request the main window can execute — plus the validation that stops a
// half-formed one from ever leaving the panel.
//
// This is the only place that knows how the declarative action model becomes
// something runnable, so it is also where the model's rules live: which
// trigger/effect combinations are legal, which placeholders are allowed, and
// what "empty" means for each effect kind.

import { evaluateWhen } from "@/lib/tray/when"
import type { TrayStateSnapshot } from "@/lib/tray/types"

import { extractPlaceholders, formatFieldValue, interpolate, isFieldEmpty } from "./template"
import type {
  TrayPanelAction,
  TrayPanelDelegateTarget,
  TrayPanelEffect,
  TrayPanelEffectKind,
  TrayPanelResolvedEffect,
  TrayPanelRunRequest,
  TrayPanelValues,
} from "./types"

const DELEGATE_TARGETS: readonly TrayPanelDelegateTarget[] = ["newSession", "activeSession"]

/** A single reason an action cannot run, in a shape the UI can translate. */
export type TrayPanelValidationError =
  | { kind: "required"; fieldId: string }
  | { kind: "unknownPlaceholder"; ids: string[] }
  | { kind: "emptyEffect" }
  | { kind: "badTarget"; value: string }
  | { kind: "illegalTrigger" }

export type ResolveResult =
  { ok: true; request: TrayPanelRunRequest } | { ok: false; errors: TrayPanelValidationError[] }

/** Whether an effect kind should raise the main window when it has no override. */
export function defaultFocusForEffect(kind: TrayPanelEffectKind): boolean {
  switch (kind) {
    // The user asked for work to happen or for a page — they want to see it.
    case "delegate":
    case "navigate":
    case "slash":
      return true
    // A plugin command (screenshot, clipboard) fired from the tray is
    // precisely the case where stealing focus would be wrong, and the native
    // actions that need the window already raise it inside Rust.
    case "command":
    case "native":
      return false
  }
}

/**
 * `open`-triggered actions run with no user gesture every time the panel
 * appears, so they may only have read-only effects. A delegate on `open` would
 * start a billed turn each time the user glanced at the tray.
 */
export function isTriggerLegal(action: TrayPanelAction): boolean {
  if (action.trigger.kind !== "open") return true
  return action.effect.kind === "navigate" || action.effect.kind === "command"
}

/** Resolve a `boolean | "{{field}}"` effect member. */
function resolveBoolean(
  raw: boolean | string,
  values: TrayPanelValues,
  known: ReadonlySet<string>,
  errors: TrayPanelValidationError[]
): boolean {
  if (typeof raw === "boolean") return raw
  const { text, missing } = interpolate(raw, values, known)
  if (missing.length > 0) errors.push({ kind: "unknownPlaceholder", ids: missing })
  return text === "true"
}

/** Resolve a `TrayPanelDelegateTarget | "{{field}}"` effect member. */
function resolveTarget(
  raw: string,
  values: TrayPanelValues,
  known: ReadonlySet<string>,
  errors: TrayPanelValidationError[]
): TrayPanelDelegateTarget {
  const { text, missing } = interpolate(raw, values, known)
  if (missing.length > 0) errors.push({ kind: "unknownPlaceholder", ids: missing })
  if ((DELEGATE_TARGETS as readonly string[]).includes(text)) {
    return text as TrayPanelDelegateTarget
  }
  // A select bound to the wrong option list, or a typo in a hand-edited
  // config. Never guess — a prompt landing in the wrong conversation is worse
  // than a visible error.
  errors.push({ kind: "badTarget", value: text })
  return "newSession"
}

/** Resolve every `{{placeholder}}` in an effect against the form values. */
function resolveEffect(
  effect: TrayPanelEffect,
  values: TrayPanelValues,
  known: ReadonlySet<string>,
  errors: TrayPanelValidationError[]
): TrayPanelResolvedEffect {
  switch (effect.kind) {
    case "delegate": {
      const { text, missing } = interpolate(effect.prompt, values, known)
      if (missing.length > 0) errors.push({ kind: "unknownPlaceholder", ids: missing })
      const prompt = text.trim()
      if (prompt.length === 0) errors.push({ kind: "emptyEffect" })
      return {
        kind: "delegate",
        prompt,
        target: resolveTarget(effect.target, values, known, errors),
        autoSend: resolveBoolean(effect.autoSend, values, known, errors),
      }
    }
    case "slash": {
      const { text, missing } = interpolate(effect.command, values, known)
      if (missing.length > 0) errors.push({ kind: "unknownPlaceholder", ids: missing })
      const trimmed = text.trim()
      if (trimmed.length === 0) errors.push({ kind: "emptyEffect" })
      // Normalise once, here, so the main window never has to guess whether the
      // author wrote the leading slash.
      const line = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
      return { kind: "slash", line }
    }
    case "navigate": {
      const { text, missing } = interpolate(effect.path, values, known)
      if (missing.length > 0) errors.push({ kind: "unknownPlaceholder", ids: missing })
      const trimmed = text.trim()
      if (trimmed.length === 0) errors.push({ kind: "emptyEffect" })
      return { kind: "navigate", path: trimmed.startsWith("/") ? trimmed : `/${trimmed}` }
    }
    case "command": {
      const { text, missing } = interpolate(effect.commandId, values, known)
      if (missing.length > 0) errors.push({ kind: "unknownPlaceholder", ids: missing })
      const commandId = text.trim()
      if (commandId.length === 0) errors.push({ kind: "emptyEffect" })
      return { kind: "command", commandId }
    }
    case "native":
      // Native actions are a closed enum picked from a dropdown — nothing to
      // interpolate, and nothing a template could usefully vary.
      return { kind: "native", action: effect.action }
  }
}

/**
 * Validate + resolve an action into a request the main window can run.
 *
 * `requestId` is injected rather than generated here so callers stay pure and
 * tests are deterministic.
 */
export function resolveAction(
  action: TrayPanelAction,
  values: TrayPanelValues,
  requestId: string,
  label: string = action.label
): ResolveResult {
  const errors: TrayPanelValidationError[] = []

  if (!isTriggerLegal(action)) errors.push({ kind: "illegalTrigger" })

  for (const field of action.fields) {
    if (field.required && isFieldEmpty(field, values[field.id])) {
      errors.push({ kind: "required", fieldId: field.id })
    }
  }

  const known = new Set(action.fields.map((f) => f.id))
  const effect = resolveEffect(action.effect, values, known, errors)

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    request: {
      requestId,
      actionId: action.id,
      actionLabel: label,
      effect,
      focusMainWindow: action.focusMainWindow ?? defaultFocusForEffect(action.effect.kind),
    },
  }
}

/* ── Authoring-time validation ────────────────────────────────────────── */

/** A problem with an action as *authored*, independent of any form values. */
export type TrayPanelDraftIssue =
  | { kind: "missingLabel" }
  | { kind: "duplicateFieldId"; fieldId: string }
  | { kind: "invalidFieldId"; fieldId: string }
  | { kind: "unknownPlaceholder"; ids: string[] }
  | { kind: "emptyEffect" }
  | { kind: "illegalTrigger" }
  | { kind: "missingChord" }
  | { kind: "emptySelect"; fieldId: string }

/** Every template string an effect carries, for placeholder checking. */
function effectTemplates(effect: TrayPanelEffect): string[] {
  switch (effect.kind) {
    case "delegate":
      return [
        effect.prompt,
        typeof effect.target === "string" ? effect.target : "",
        typeof effect.autoSend === "string" ? effect.autoSend : "",
      ]
    case "slash":
      return [effect.command]
    case "command":
      return [effect.commandId]
    case "navigate":
      return [effect.path]
    case "native":
      return []
  }
}

/**
 * Check an action the user is authoring in settings, before it can be saved.
 *
 * Separate from `resolveAction` on purpose: that one answers "can this run with
 * the values in front of me", which a half-written draft can legitimately fail.
 * This one answers "is this action well-formed at all", which is what the
 * editor's save button needs.
 */
export function validateActionDraft(action: TrayPanelAction): TrayPanelDraftIssue[] {
  const issues: TrayPanelDraftIssue[] = []

  if (action.label.trim().length === 0 && !action.labelKey) issues.push({ kind: "missingLabel" })
  if (!isTriggerLegal(action)) issues.push({ kind: "illegalTrigger" })
  if (action.trigger.kind === "hotkey" && action.trigger.chord.trim().length === 0) {
    issues.push({ kind: "missingChord" })
  }

  const seen = new Set<string>()
  for (const field of action.fields) {
    // Ids become `{{placeholders}}`, so anything the template regex can't match
    // would be unreferenceable — reject it at authoring time rather than
    // shipping a field that silently does nothing.
    if (!/^[A-Za-z0-9_-]+$/.test(field.id))
      issues.push({ kind: "invalidFieldId", fieldId: field.id })
    if (seen.has(field.id)) issues.push({ kind: "duplicateFieldId", fieldId: field.id })
    seen.add(field.id)
    if (field.kind === "select" && field.options.length === 0) {
      issues.push({ kind: "emptySelect", fieldId: field.id })
    }
  }

  const unknown: string[] = []
  let anyContent = false
  for (const template of effectTemplates(action.effect)) {
    if (template.trim().length > 0) anyContent = true
    for (const id of extractPlaceholders(template)) {
      if (!seen.has(id) && !unknown.includes(id)) unknown.push(id)
    }
  }
  if (unknown.length > 0) issues.push({ kind: "unknownPlaceholder", ids: unknown })
  if (action.effect.kind !== "native" && !anyContent) issues.push({ kind: "emptyEffect" })

  return issues
}

/* ── Selection helpers ────────────────────────────────────────────────── */

/** Actions the panel should show, in order: not hidden and `when`-satisfied. */
export function visibleActions(
  actions: readonly TrayPanelAction[],
  snapshot: TrayStateSnapshot
): TrayPanelAction[] {
  return actions.filter((a) => !a.hidden && evaluateWhen(a.when, snapshot))
}

/**
 * The action the panel's primary button and the composer's Enter key run.
 * First visible `submit`-triggered action wins; `null` when the user has
 * hidden or deleted every one of them (the panel then shows only its list).
 */
export function resolvePrimaryAction(
  actions: readonly TrayPanelAction[],
  snapshot: TrayStateSnapshot
): TrayPanelAction | null {
  return visibleActions(actions, snapshot).find((a) => a.trigger.kind === "submit") ?? null
}

/** Visible actions that run automatically when the panel opens. */
export function openTriggeredActions(
  actions: readonly TrayPanelAction[],
  snapshot: TrayStateSnapshot
): TrayPanelAction[] {
  return visibleActions(actions, snapshot).filter(
    (a) => a.trigger.kind === "open" && isTriggerLegal(a)
  )
}

/**
 * Normalise a keyboard event into the chord syntax `hotkey` triggers use:
 * lowercase, `mod` for ⌘/Ctrl, in the fixed order `mod+alt+shift+key`.
 */
export function chordFromEvent(event: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}): string {
  const parts: string[] = []
  if (event.metaKey || event.ctrlKey) parts.push("mod")
  if (event.altKey) parts.push("alt")
  if (event.shiftKey) parts.push("shift")
  parts.push(event.key.toLowerCase())
  return parts.join("+")
}

/** The visible action bound to `chord`, if any. */
export function actionForChord(
  actions: readonly TrayPanelAction[],
  snapshot: TrayStateSnapshot,
  chord: string
): TrayPanelAction | null {
  return (
    visibleActions(actions, snapshot).find(
      (a) => a.trigger.kind === "hotkey" && a.trigger.chord.toLowerCase() === chord
    ) ?? null
  )
}

/** Human-readable summary of an effect, for the settings list rows. */
export function describeEffect(effect: TrayPanelEffect): string {
  switch (effect.kind) {
    case "delegate":
      return formatFieldValue(effect.prompt)
    case "slash":
      return effect.command.startsWith("/") ? effect.command : `/${effect.command}`
    case "command":
      return effect.commandId
    case "native":
      return effect.action
    case "navigate":
      return effect.path
  }
}
