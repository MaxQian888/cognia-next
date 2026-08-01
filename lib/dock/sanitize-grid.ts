/**
 * Treat a serialized dockview grid as untrusted input.
 *
 * A grid reaches the app from three places: localStorage (which a user or a
 * misbehaving extension can edit), an imported preset file, and — later — a
 * cross-window envelope. dockview will happily deserialize whatever it is
 * handed, including a panel whose `contentComponent` names a renderer the host
 * never registered and whose `params` carry arbitrary values straight into that
 * renderer's props.
 *
 * So the kernel never round-trips a grid it did not just produce. Every restore
 * runs through here first, and the rule is: the *instance table* is the source
 * of truth for what exists, and the grid only says where those things sit.
 * A panel the instance table does not know about is dropped, `params` are
 * replaced wholesale rather than filtered, and the component name is forced to
 * the single renderer the host registered.
 *
 * The pruning is structural too: dropping a panel can empty a leaf, and an
 * empty leaf left in the tree makes dockview restore a group with no tabs that
 * the user cannot close.
 */

import type { DockSerializedGrid } from "@/types/dock/layout"

/** The one content renderer the dock registers. See `components/dock/dock-host`. */
export const DOCK_PANEL_COMPONENT = "dock-panel"
/** The one tab renderer the dock registers. */
export const DOCK_TAB_COMPONENT = "dock-tab"

export interface SanitizeGridResult {
  grid: DockSerializedGrid | null
  /** Panel ids present in the grid that the instance table does not know. */
  droppedPanelIds: string[]
  /** Instance ids the grid never mentions — they need re-adding. */
  missingInstanceIds: string[]
}

/**
 * The narrow shape sanitisation produces. Typed rather than left as `unknown`
 * so the collectors below cannot need defensive re-checks — anything they see
 * has already been through `sanitizeNode`.
 */
interface SanitizedLeaf {
  type: "leaf"
  data: { id: string; views: string[]; activeView: string; locked?: boolean }
  size?: number
  visible?: boolean
}

interface SanitizedBranch {
  type: "branch"
  data: SanitizedNode[]
  size?: number
  visible?: boolean
}

type SanitizedNode = SanitizedLeaf | SanitizedBranch

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Rewrite a panel entry to the only shape the host can render.
 *
 * `params` is *replaced*, never merged: an allowlist over an attacker-supplied
 * object is a game of catching every key, and there is nothing the dock needs
 * from a persisted params bag anyway — the instance table already holds
 * everything the renderer reads.
 */
function sanitizePanel(id: string, raw: unknown): Record<string, unknown> {
  const source = isRecord(raw) ? raw : {}
  const title = typeof source.title === "string" ? source.title : undefined
  return {
    id,
    contentComponent: DOCK_PANEL_COMPONENT,
    tabComponent: DOCK_TAB_COMPONENT,
    ...(title ? { title } : {}),
    params: {},
  }
}

/**
 * Prune a node to the panels that survived, returning `null` when nothing is
 * left. Collapsing here rather than after the walk is what stops an empty group
 * reaching dockview.
 */
function sanitizeNode(
  node: unknown,
  allowed: ReadonlySet<string>,
  dropped: Set<string>
): SanitizedNode | null {
  if (!isRecord(node)) return null

  if (node.type === "branch") {
    const children = Array.isArray(node.data) ? node.data : []
    const kept = children
      .map((child) => sanitizeNode(child, allowed, dropped))
      .filter((child): child is SanitizedNode => child !== null)
    if (kept.length === 0) return null
    // A branch with one child is a branch that renders as its child; keeping it
    // would add a phantom splitter the user cannot remove.
    if (kept.length === 1) {
      const only = kept[0]!
      return { ...only, size: typeof node.size === "number" ? node.size : only.size }
    }
    return { type: "branch", data: kept, ...sizeOf(node) }
  }

  if (node.type !== "leaf" || !isRecord(node.data)) return null
  const leaf = node.data
  const views = Array.isArray(leaf.views) ? leaf.views : []
  const kept: string[] = []
  for (const view of views) {
    if (typeof view !== "string") continue
    if (allowed.has(view)) kept.push(view)
    else dropped.add(view)
  }
  const first = kept[0]
  if (first === undefined) return null

  const activeView =
    typeof leaf.activeView === "string" && kept.includes(leaf.activeView) ? leaf.activeView : first

  return {
    type: "leaf",
    data: {
      id: typeof leaf.id === "string" ? leaf.id : `group-${first}`,
      views: kept,
      activeView,
      ...(typeof leaf.locked === "boolean" ? { locked: leaf.locked } : {}),
    },
    ...sizeOf(node),
  }
}

function sizeOf(node: Record<string, unknown>): { size?: number; visible?: boolean } {
  const out: { size?: number; visible?: boolean } = {}
  if (typeof node.size === "number" && Number.isFinite(node.size)) out.size = node.size
  if (typeof node.visible === "boolean") out.visible = node.visible
  return out
}

/** Collect every group id the surviving tree contains. */
function collectGroupIds(node: SanitizedNode, into: Set<string>): void {
  if (node.type === "branch") {
    for (const child of node.data) collectGroupIds(child, into)
    return
  }
  into.add(node.data.id)
}

/**
 * Reduce a persisted grid to something safe to hand back to dockview.
 *
 * Returns `null` for the grid when nothing survives, which the host reads as
 * "build the default layout" rather than "restore an empty one".
 */
export function sanitizeDockGrid(
  raw: unknown,
  allowedInstanceIds: readonly string[]
): SanitizeGridResult {
  const allowed = new Set(allowedInstanceIds)
  const dropped = new Set<string>()

  if (!isRecord(raw) || !isRecord(raw.grid)) {
    return { grid: null, droppedPanelIds: [], missingInstanceIds: [...allowed] }
  }

  const root = sanitizeNode(raw.grid.root, allowed, dropped)
  if (!root) {
    return { grid: null, droppedPanelIds: [...dropped], missingInstanceIds: [...allowed] }
  }

  const present = new Set<string>()
  collectViews(root, present)

  const panels: Record<string, unknown> = {}
  const rawPanels = isRecord(raw.panels) ? raw.panels : {}
  for (const id of present) {
    panels[id] = sanitizePanel(id, rawPanels[id])
  }

  const groupIds = new Set<string>()
  collectGroupIds(root, groupIds)

  const grid: DockSerializedGrid = {
    grid: {
      root,
      width: numberOr(raw.grid.width, 0),
      height: numberOr(raw.grid.height, 0),
      orientation: raw.grid.orientation === "VERTICAL" ? "VERTICAL" : "HORIZONTAL",
    },
    panels,
  }

  if (typeof raw.activeGroup === "string" && groupIds.has(raw.activeGroup)) {
    grid.activeGroup = raw.activeGroup
  }

  return {
    grid,
    droppedPanelIds: [...dropped],
    // Floating and popout groups are deliberately not carried through here:
    // they reference geometry and, on Tauri, a window that no longer exists.
    // The host re-materialises them from its own records.
    missingInstanceIds: [...allowed].filter((id) => !present.has(id)),
  }
}

function collectViews(node: SanitizedNode, into: Set<string>): void {
  if (node.type === "branch") {
    for (const child of node.data) collectViews(child, into)
    return
  }
  for (const view of node.data.views) into.add(view)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}
