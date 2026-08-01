/**
 * Turn a live layout into a preset, and a preset back into a layout.
 *
 * The round trip is deliberately lossy in one direction: capturing throws away
 * every instance id and resource binding, keeping only "which panel, in which
 * group, at what proportion". Applying then mints fresh instances. That is what
 * makes a preset safe to carry between contexts — apply the same arrangement to
 * a different session and you get that session's panels, not a dangling
 * reference to another one's.
 *
 * The generated grid is handed to `sanitizeDockGrid` before dockview sees it,
 * so a bug here can produce a wrong layout but never an unsafe one.
 */

import type { DockLayoutEnvelope, DockSerializedGrid } from "@/types/dock/layout"
import type { DockPanelInstance } from "@/types/dock/instance"
import {
  DOCK_PRESET_SCHEMA_VERSION,
  type DockPreset,
  type DockPresetNode,
  type DockPresetSlot,
} from "@/types/dock/preset"
import { DOCK_PANEL_COMPONENT, DOCK_TAB_COMPONENT } from "../sanitize-grid"

interface GridLeaf {
  type: "leaf"
  data: { id: string; views: string[]; activeView?: string }
  size?: number
}
interface GridBranch {
  type: "branch"
  data: GridNode[]
  size?: number
}
type GridNode = GridLeaf | GridBranch

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Read a persisted grid back into the preset tree.
 *
 * Works off the grid rather than the instance table because the table has no
 * notion of grouping — it is a flat list, and "these three were tabs of one
 * group" only exists in the grid.
 */
function gridToPresetNode(
  node: unknown,
  instancesById: ReadonlyMap<string, DockPanelInstance>,
  orientation: "horizontal" | "vertical"
): DockPresetNode | null {
  if (!isRecord(node)) return null

  if (node.type === "branch" && Array.isArray(node.data)) {
    // dockview alternates orientation with depth; a branch's children are laid
    // out across the axis opposite its parent.
    const childOrientation = orientation === "horizontal" ? "vertical" : "horizontal"
    const children = node.data
      .map((child) => gridToPresetNode(child, instancesById, childOrientation))
      .filter((child): child is DockPresetNode => child !== null)
    if (children.length === 0) return null
    if (children.length === 1) return children[0]!
    return {
      type: "split",
      orientation,
      children,
      ...(typeof node.size === "number" ? { size: node.size } : {}),
    }
  }

  if (node.type !== "leaf" || !isRecord(node.data)) return null
  const views = Array.isArray(node.data.views) ? node.data.views : []
  const panels: DockPresetSlot[] = []
  for (const view of views) {
    if (typeof view !== "string") continue
    const instance = instancesById.get(view)
    if (!instance) continue
    panels.push({ panelId: instance.panelId, mode: instance.mode })
  }
  if (panels.length === 0) return null
  return { type: "group", panels, ...(typeof node.size === "number" ? { size: node.size } : {}) }
}

export interface CaptureDockPresetInput {
  envelope: DockLayoutEnvelope
  name: string
  id: string
  now: number
}

/** Snapshot the arrangement of `envelope` as a reusable template. */
export function captureDockPreset(input: CaptureDockPresetInput): DockPreset {
  const { envelope, name, id, now } = input
  const instancesById = new Map(envelope.instances.map((i) => [i.instanceId, i]))
  const rawRoot =
    isRecord(envelope.grid) && isRecord(envelope.grid.grid) ? envelope.grid.grid.root : null
  const orientation =
    isRecord(envelope.grid) &&
    isRecord(envelope.grid.grid) &&
    envelope.grid.grid.orientation === "VERTICAL"
      ? "vertical"
      : "horizontal"

  return {
    id,
    name,
    host: envelope.key.host,
    schemaVersion: DOCK_PRESET_SCHEMA_VERSION,
    root: rawRoot ? gridToPresetNode(rawRoot, instancesById, orientation) : null,
    shell: { edge: envelope.shell.edge, sizePercent: envelope.shell.sizePercent },
    createdAt: now,
    updatedAt: now,
  }
}

/** The empty template: the rail, and nothing docked. */
export function createEmptyDockPreset(
  input: Pick<CaptureDockPresetInput, "id" | "name" | "now"> & {
    host: DockPreset["host"]
    edge: DockPreset["shell"]["edge"]
    sizePercent: number
  }
): DockPreset {
  return {
    id: input.id,
    name: input.name,
    host: input.host,
    schemaVersion: DOCK_PRESET_SCHEMA_VERSION,
    root: null,
    shell: { edge: input.edge, sizePercent: input.sizePercent },
    builtin: true,
    createdAt: input.now,
    updatedAt: input.now,
  }
}

export interface ApplyDockPresetInput {
  preset: DockPreset
  /** Panels that resolve here. A preset slot naming anything else is skipped. */
  availablePanelIds: ReadonlySet<string>
  createInstanceId: () => string
  /** Panel id → dock kind, so the new instances carry the right classification. */
  kindOf: (panelId: string) => DockPanelInstance["kind"]
}

export interface ApplyDockPresetResult {
  instances: DockPanelInstance[]
  grid: DockSerializedGrid | null
  /** Panel ids the preset asked for that do not resolve in this context. */
  skippedPanelIds: string[]
}

/**
 * Materialise a preset into instances and a grid.
 *
 * A panel the preset names but this context cannot offer is skipped rather than
 * faked: a chat preset applied to a project should give you the panels the
 * project has, not empty tabs promising ones it does not.
 */
export function applyDockPreset(input: ApplyDockPresetInput): ApplyDockPresetResult {
  const instances: DockPanelInstance[] = []
  const skipped: string[] = []
  let groupCounter = 0

  const build = (node: DockPresetNode): GridNode | null => {
    if (node.type === "split") {
      const children = node.children
        .map((child) => build(child))
        .filter((child): child is GridNode => child !== null)
      if (children.length === 0) return null
      if (children.length === 1) return children[0]!
      return {
        type: "branch",
        data: children,
        ...(node.size !== undefined ? { size: node.size } : {}),
      }
    }

    const views: string[] = []
    for (const slot of node.panels) {
      if (!input.availablePanelIds.has(slot.panelId)) {
        skipped.push(slot.panelId)
        continue
      }
      const instanceId = input.createInstanceId()
      instances.push({
        instanceId,
        panelId: slot.panelId,
        kind: input.kindOf(slot.panelId),
        mode: slot.mode,
        dirty: false,
        activated: false,
      })
      views.push(instanceId)
    }
    if (views.length === 0) return null
    return {
      type: "leaf",
      data: { id: `preset-group-${++groupCounter}`, views, activeView: views[0] },
      ...(node.size !== undefined ? { size: node.size } : {}),
    }
  }

  const root = input.preset.root ? build(input.preset.root) : null
  if (!root) {
    return { instances, grid: null, skippedPanelIds: skipped }
  }

  const panels: Record<string, unknown> = {}
  for (const instance of instances) {
    panels[instance.instanceId] = {
      id: instance.instanceId,
      contentComponent: DOCK_PANEL_COMPONENT,
      tabComponent: DOCK_TAB_COMPONENT,
      params: {},
    }
  }

  return {
    instances,
    grid: {
      grid: {
        root,
        width: 0,
        height: 0,
        orientation:
          input.preset.root?.type === "split" && input.preset.root.orientation === "vertical"
            ? "VERTICAL"
            : "HORIZONTAL",
      },
      panels,
    },
    skippedPanelIds: skipped,
  }
}
