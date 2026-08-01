/**
 * Validate a preset that came from outside.
 *
 * An exported preset is a file a user can hand to a colleague, which means it
 * is also a file someone can hand-edit. Everything reachable from an import
 * therefore gets checked rather than trusted: the schema version, the tree
 * shape, every panel id, and the total size.
 *
 * The check is *structural*, not a sanitiser that repairs: an import either
 * produces a preset the app would have written itself, or it is rejected with a
 * reason the UI can explain. Silently repairing a malformed file would make
 * "this preset does something odd" impossible to diagnose.
 */

import {
  DOCK_PRESET_NAME_MAX_LENGTH,
  DOCK_PRESET_SCHEMA_VERSION,
  type DockPreset,
  type DockPresetNode,
  type DockPresetSlot,
} from "@/types/dock/preset"
import type { DockHost, DockShellEdge } from "@/types/dock/layout"

/** Hard ceiling on a preset's node count — a stack-overflow / DoS guard. */
export const DOCK_PRESET_MAX_NODES = 200

export type DockPresetRejection =
  | "not-an-object"
  | "schema-version"
  | "unknown-host"
  | "invalid-name"
  | "invalid-shell"
  | "invalid-tree"
  | "too-large"
  | "unknown-panel"

export type DockPresetValidation =
  { ok: true; preset: DockPreset } | { ok: false; rejection: DockPresetRejection; panelId?: string }

const HOSTS: readonly DockHost[] = ["chat", "project", "canvas", "workflow"]
const EDGES: readonly DockShellEdge[] = ["right", "left", "bottom"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * A discriminated union rather than `{ node, rejection? }`: the latter can
 * represent "no node and no reason", a state nothing produces and every caller
 * then has to write a dead branch for.
 */
type TreeCheck =
  | { ok: true; node: DockPresetNode }
  | { ok: false; rejection: DockPresetRejection; panelId?: string }

function checkSlot(raw: unknown, allowed: ReadonlySet<string> | undefined): DockPresetSlot | null {
  if (!isRecord(raw)) return null
  if (typeof raw.panelId !== "string" || raw.panelId.length === 0) return null
  if (raw.mode !== "preview" && raw.mode !== "pinned") return null
  if (allowed && !allowed.has(raw.panelId)) return null
  return { panelId: raw.panelId, mode: raw.mode }
}

function checkTree(
  raw: unknown,
  allowed: ReadonlySet<string> | undefined,
  budget: { remaining: number }
): TreeCheck {
  if (budget.remaining <= 0) return { ok: false, rejection: "too-large" }
  budget.remaining -= 1
  if (!isRecord(raw)) return { ok: false, rejection: "invalid-tree" }

  if (raw.type === "split") {
    if (raw.orientation !== "horizontal" && raw.orientation !== "vertical") {
      return { ok: false, rejection: "invalid-tree" }
    }
    if (!Array.isArray(raw.children) || raw.children.length === 0) {
      return { ok: false, rejection: "invalid-tree" }
    }
    const children: DockPresetNode[] = []
    for (const child of raw.children) {
      const checked = checkTree(child, allowed, budget)
      // Propagate the child's own rejection: "too-large" must not be reported
      // as "invalid-tree", or the UI cannot tell the user what to fix.
      if (!checked.ok) return checked
      children.push(checked.node)
    }
    // Canonicalise: a one-child split renders as a splitter the user cannot
    // remove. `sanitizeDockGrid` and `applyDockPreset` collapse the same way,
    // so a preset that round-trips through here comes out in one shape.
    if (children.length === 1) return { ok: true, node: children[0]! }
    return {
      ok: true,
      node: {
        type: "split",
        orientation: raw.orientation,
        children,
        ...(isFiniteSize(raw.size) ? { size: raw.size } : {}),
      },
    }
  }

  if (raw.type !== "group") return { ok: false, rejection: "invalid-tree" }
  if (!Array.isArray(raw.panels) || raw.panels.length === 0) {
    return { ok: false, rejection: "invalid-tree" }
  }
  const panels: DockPresetSlot[] = []
  for (const slot of raw.panels) {
    const checked = checkSlot(slot, allowed)
    if (!checked) {
      const panelId = isRecord(slot) && typeof slot.panelId === "string" ? slot.panelId : undefined
      return {
        ok: false,
        rejection: allowed && panelId ? "unknown-panel" : "invalid-tree",
        panelId,
      }
    }
    panels.push(checked)
  }
  return {
    ok: true,
    node: { type: "group", panels, ...(isFiniteSize(raw.size) ? { size: raw.size } : {}) },
  }
}

function isFiniteSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

export interface ValidateDockPresetOptions {
  /**
   * Panel ids this build knows about. Omitted when importing into a context
   * whose panel set is not resolved yet — the tree is still checked, just not
   * against a catalogue.
   */
  allowedPanelIds?: ReadonlySet<string>
  /** Fresh id, so an import can never collide with a preset already stored. */
  id: string
  now: number
}

export function validateDockPreset(
  raw: unknown,
  options: ValidateDockPresetOptions
): DockPresetValidation {
  if (!isRecord(raw)) return { ok: false, rejection: "not-an-object" }
  if (raw.schemaVersion !== DOCK_PRESET_SCHEMA_VERSION) {
    return { ok: false, rejection: "schema-version" }
  }
  if (typeof raw.host !== "string" || !HOSTS.includes(raw.host as DockHost)) {
    return { ok: false, rejection: "unknown-host" }
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (name.length === 0 || name.length > DOCK_PRESET_NAME_MAX_LENGTH) {
    return { ok: false, rejection: "invalid-name" }
  }

  const shell = raw.shell
  if (
    !isRecord(shell) ||
    typeof shell.edge !== "string" ||
    !EDGES.includes(shell.edge as DockShellEdge) ||
    !isFiniteSize(shell.sizePercent)
  ) {
    return { ok: false, rejection: "invalid-shell" }
  }

  let root: DockPresetNode | null = null
  if (raw.root !== null && raw.root !== undefined) {
    const checked = checkTree(raw.root, options.allowedPanelIds, {
      remaining: DOCK_PRESET_MAX_NODES,
    })
    if (!checked.ok) {
      return { ok: false, rejection: checked.rejection, panelId: checked.panelId }
    }
    root = checked.node
  }

  return {
    ok: true,
    preset: {
      // A fresh id, always: importing the same file twice must give two
      // presets, not one silently overwriting the other.
      id: options.id,
      name,
      host: raw.host as DockHost,
      schemaVersion: DOCK_PRESET_SCHEMA_VERSION,
      root,
      shell: { edge: shell.edge as DockShellEdge, sizePercent: shell.sizePercent },
      // `builtin` is never honoured from a file — nothing imported is shipped.
      createdAt: options.now,
      updatedAt: options.now,
    },
  }
}
