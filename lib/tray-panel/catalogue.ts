/**
 * The tray panel's action catalogue as stored in settings (ADR-0225 §10).
 *
 * The catalogue lives in `AppSettings.trayPanelActions`, written only by the
 * main window (the settings editor) and handed to the panel window inside the
 * glance snapshot. It is backed up and account-synced like the layout, so
 * what arrives here may come from another install or an older build:
 * `resolveTrayPanelActions` is the only reader, and it never throws.
 *
 * The edits are pure functions over the list; the settings hook
 * (`hooks/tray-panel/use-tray-panel-actions.ts`) persists their results.
 */

import {
  DEFAULT_TRAY_PANEL_ACTIONS,
  ensureBuiltInActions,
  migrateRetiredNativeEffects,
} from "./defaults"
import type { TrayPanelAction } from "./types"

/** More than any panel can show; a guard against a corrupted list, not a product limit. */
export const TRAY_PANEL_ACTIONS_MAX = 64

const ID_MAX = 200
const FIELD_KINDS = new Set(["text", "textarea", "select", "switch", "number"])
const EFFECT_KINDS = new Set(["delegate", "slash", "command", "native", "navigate"])
const TRIGGER_KINDS = new Set(["manual", "submit", "open", "hotkey"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The structure every consumer dereferences without checking: an id, a label,
 * a field list of known kinds, a known effect and a known trigger. Deeper
 * semantics (placeholders, targets, legal triggers) belong to `resolveAction`
 * and `validateActionDraft`, which report them instead of crashing.
 */
export function isTrayPanelActionShape(value: unknown): value is TrayPanelAction {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > ID_MAX) {
    return false
  }
  if (typeof value.label !== "string") return false
  if (!Array.isArray(value.fields)) return false
  for (const field of value.fields) {
    if (!isRecord(field) || typeof field.id !== "string") return false
    if (!FIELD_KINDS.has(field.kind as string)) return false
    if (field.kind === "select" && !Array.isArray(field.options)) return false
  }
  if (!isRecord(value.effect) || !EFFECT_KINDS.has(value.effect.kind as string)) return false
  if (!isRecord(value.trigger) || !TRIGGER_KINDS.has(value.trigger.kind as string)) return false
  if (value.trigger.kind === "hotkey" && typeof value.trigger.chord !== "string") return false
  return true
}

/**
 * Read a stored catalogue. Nothing stored (or nothing usable) is the shipped
 * catalogue; otherwise malformed and duplicate entries are dropped, retired
 * native effects rewritten, and built-ins this build added folded back in.
 */
export function resolveTrayPanelActions(stored: unknown): TrayPanelAction[] {
  if (!Array.isArray(stored) || stored.length === 0) return DEFAULT_TRAY_PANEL_ACTIONS
  const seen = new Set<string>()
  const valid: TrayPanelAction[] = []
  for (const item of stored.slice(0, TRAY_PANEL_ACTIONS_MAX)) {
    if (!isTrayPanelActionShape(item) || seen.has(item.id)) continue
    seen.add(item.id)
    valid.push(item)
  }
  if (valid.length === 0) return DEFAULT_TRAY_PANEL_ACTIONS
  return ensureBuiltInActions(migrateRetiredNativeEffects(valid))
}

/** Swap `index` with its neighbour in `direction`; a no-op at the ends. */
export function reorderActions(
  actions: readonly TrayPanelAction[],
  index: number,
  direction: -1 | 1
): TrayPanelAction[] {
  const target = index + direction
  if (index < 0 || index >= actions.length) return actions.slice()
  if (target < 0 || target >= actions.length) return actions.slice()
  const next = actions.slice()
  const tmp = next[index]
  next[index] = next[target]
  next[target] = tmp
  return next
}

/** Replace the action with the same id, or append a new one. */
export function upsertAction(
  actions: readonly TrayPanelAction[],
  action: TrayPanelAction
): TrayPanelAction[] {
  const index = actions.findIndex((a) => a.id === action.id)
  if (index < 0) return [...actions, action]
  const next = actions.slice()
  next[index] = action
  return next
}

/**
 * Remove a custom action. Built-ins are never removed, only hidden: their ids
 * are referenced by the shipped defaults, so a delete would be undone by the
 * next `ensureBuiltInActions` backfill and read as "it came back on its own".
 */
export function removeAction(actions: readonly TrayPanelAction[], id: string): TrayPanelAction[] {
  return actions
    .map((a) => (a.id === id && a.builtIn ? { ...a, hidden: true } : a))
    .filter((a) => a.id !== id || a.builtIn)
}

/** Move one action a place up or down. */
export function moveAction(
  actions: readonly TrayPanelAction[],
  id: string,
  direction: -1 | 1
): TrayPanelAction[] {
  return reorderActions(
    actions,
    actions.findIndex((a) => a.id === id),
    direction
  )
}
