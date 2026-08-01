/**
 * A one-way read of the pre-Dock layout stores.
 *
 * The first time a host opens on the Dock kernel there is no envelope for its
 * `DockLayoutKey`, and starting from an empty grid would silently throw away
 * the arrangement the user has been working in — the panel they had open, how
 * wide they had dragged the column, whether it was collapsed to the rail. This
 * reads that state out of `cognia-context-workbench-v1` and
 * `cognia-artifact-dock-layout` and seeds the envelope with it.
 *
 * Three properties are load-bearing:
 *
 * - **One-way.** Nothing here writes to the legacy stores. They stay the
 *   authority for every host still on the workbench, and they are the rollback
 *   path for the hosts that moved — a user who turns the flag back off finds
 *   their layout exactly as they left it.
 * - **Idempotent, per key.** Guarded on `envelopes[key] === undefined`, so a
 *   second run after the user has rearranged the Dock cannot resurrect the old
 *   arrangement over the new one.
 * - **Untrusted input.** localStorage is user-editable and can hold a shape
 *   from a build years old. Every field is checked; anything unrecognised falls
 *   back to the default rather than propagating into the envelope.
 *
 * The one thing deliberately *not* carried over is the grid. The workbench had
 * no grid — it showed one panel at a time — so there is nothing to translate,
 * and a seeded instance with no grid is exactly what `DockHost` turns into a
 * single-group layout on first render.
 */

import {
  DEFAULT_DOCK_SHELL_STATE,
  DOCK_LAYOUT_SCHEMA_VERSION,
  clampDockShellSize,
  type DockLayoutEnvelope,
  type DockLayoutKey,
  type DockShellState,
} from "@/types/dock/layout"
import type { DockPanelInstance } from "@/types/dock/instance"
import type { ResolvedDockPanel } from "@/types/dock/panel"

export const LEGACY_CONTEXT_WORKBENCH_KEY = "cognia-context-workbench-v1"
export const LEGACY_ARTIFACT_DOCK_KEY = "cognia-artifact-dock-layout"

/** What `migrateLegacyDockLayout` records in `migratedFrom`. */
export const LEGACY_MIGRATION_SOURCE = "context-workbench-v1"

interface LegacyWorkbenchLayout {
  activePanelId: string | null
  activatedPanelIds: string[]
  userPinned: boolean
}

function readJson(storageKey: string): unknown {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(storageKey)
    return raw ? JSON.parse(raw) : null
  } catch {
    // A corrupt or quota-blocked read is not worth failing a mount over; the
    // host starts from the default layout, which is a working dock.
    return null
  }
}

/** Zustand's `persist` wraps the partialized state in `{ state, version }`. */
function persistedState(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null
  const state = (raw as { state?: unknown }).state
  return state && typeof state === "object" ? (state as Record<string, unknown>) : null
}

function readLegacyWorkbenchLayout(scopeKey: string): LegacyWorkbenchLayout | null {
  const state = persistedState(readJson(LEGACY_CONTEXT_WORKBENCH_KEY))
  const layouts = state?.layouts
  if (!layouts || typeof layouts !== "object") return null
  const layout = (layouts as Record<string, unknown>)[scopeKey]
  if (!layout || typeof layout !== "object") return null
  const record = layout as Record<string, unknown>
  const activated = Array.isArray(record.activatedPanelIds)
    ? record.activatedPanelIds.filter((id): id is string => typeof id === "string")
    : []
  return {
    activePanelId: typeof record.activePanelId === "string" ? record.activePanelId : null,
    activatedPanelIds: activated,
    userPinned: record.userPinned === true,
  }
}

/**
 * The chat dock's own chrome, as the legacy store recorded it.
 *
 * `railOnly` is not read from anywhere: the legacy store's `dockCollapsed` says
 * *whether* the dock is shut, while what it shrinks to was a render-time
 * decision made from the workbench-rail setting, which lives in Dexie and is
 * still authoritative. Carrying a guess here would let a stale localStorage
 * value override a live setting.
 */
function readLegacyShell(): Partial<DockShellState> {
  const state = persistedState(readJson(LEGACY_ARTIFACT_DOCK_KEY))
  if (!state) return {}
  const shell: Partial<DockShellState> = {}
  if (typeof state.dockSize === "number") shell.sizePercent = clampDockShellSize(state.dockSize)
  if (typeof state.dockCollapsed === "boolean") shell.collapsed = state.dockCollapsed
  return shell
}

export interface MigrateLegacyDockLayoutOptions {
  key: DockLayoutKey
  /**
   * The workbench scope key this host used before the Dock — the same string
   * `ContextWorkbench` keyed its layouts by. Hosts build it themselves because
   * only they know their workbench instance id.
   */
  legacyScopeKey: string
  /** Panels this host can currently offer; anything else is dropped. */
  available: ReadonlyMap<string, ResolvedDockPanel>
  createInstanceId: () => string
  now: number
}

/**
 * Build the envelope a host should start from, or `null` when there is nothing
 * worth carrying over and the default layout is the honest answer.
 *
 * Only the panels the user actually opened become instances, and only the one
 * that was in front is left active — a workbench scope accumulates
 * `activatedPanelIds` over its whole life, so restoring all of them would greet
 * the user with eight tabs they never asked to see at once.
 */
export function migrateLegacyDockLayout(
  options: MigrateLegacyDockLayoutOptions
): DockLayoutEnvelope | null {
  const legacy = readLegacyWorkbenchLayout(options.legacyScopeKey)
  const shell = readLegacyShell()
  if (!legacy && Object.keys(shell).length === 0) return null

  const instances: DockPanelInstance[] = []
  const activePanelId = legacy?.activePanelId
  if (activePanelId) {
    const panel = options.available.get(activePanelId)
    if (panel) {
      instances.push({
        instanceId: options.createInstanceId(),
        panelId: panel.definition.id,
        kind: panel.meta.kind,
        // Pinned, not preview: this is a panel the user chose and came back to
        // across reloads. Seeding it as a preview tab would let the next reveal
        // replace it, which is the opposite of what carrying it over is for.
        mode: "pinned",
        dirty: false,
        // Not activated: the panel is being mounted fresh in a new engine, so
        // it gets `onFirstActivate` rather than `onRestore`. Claiming it was
        // already activated would skip the setup a panel does exactly once.
        activated: false,
      })
    }
  }

  return {
    schemaVersion: DOCK_LAYOUT_SCHEMA_VERSION,
    key: options.key,
    // No grid: the workbench had none to translate. `DockHost` lays a single
    // group out from the instance table on first render.
    grid: null,
    instances,
    shell: { ...DEFAULT_DOCK_SHELL_STATE, ...shell },
    revision: 1,
    migratedFrom: LEGACY_MIGRATION_SOURCE,
    updatedAt: options.now,
  }
}
