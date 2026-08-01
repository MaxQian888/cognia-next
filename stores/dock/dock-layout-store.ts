/**
 * Persisted dock layouts, keyed by `account + host + contextId`.
 *
 * The store is deliberately thin: it holds envelopes and delegates every
 * mutation to `lib/dock/transaction`, which is the single writer. Nothing here
 * edits an envelope in place — a caller hands over a pure `apply` and the
 * transaction engine decides whether it is allowed to land. That is what keeps
 * dockview's continuous `onDidLayoutChange` stream from racing the app's own
 * intentional changes.
 *
 * Ownership boundary with the stores it will eventually replace:
 *   - `cognia-dock-layout-v1` (here) owns the grid, the instance table and the
 *     shell edge/size/collapsed state for hosts running on the dock kernel.
 *   - `cognia-context-workbench-v1` stays authoritative for every host still on
 *     `ContextWorkbench`, and is a read-only migration source for those that
 *     are not. Nothing here writes to it.
 *   - `cognia-artifact-dock-layout` keeps its runtime-only reveal intents and
 *     the mobile sheet flag. Its four persisted sizing fields become read-only
 *     while the chat host's dock flag is on.
 *
 * History is in-memory only, by design (`lib/dock/transaction`).
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import {
  canRedoDockLayout,
  canUndoDockLayout,
  commitDockTransaction,
  EMPTY_DOCK_HISTORY,
  redoDockLayout,
  undoDockLayout,
  type DockHistoryState,
  type DockTransaction,
  type DockTransactionRejection,
} from "@/lib/dock/transaction"
import {
  clampDockShellSize,
  DEFAULT_DOCK_SHELL_STATE,
  DOCK_LAYOUT_SCHEMA_VERSION,
  dockLayoutKeyOf,
  type DockLayoutEnvelope,
  type DockLayoutKey,
  type DockSerializedGrid,
  type DockShellEdge,
} from "@/types/dock/layout"
import type { DockPanelInstance } from "@/types/dock/instance"

/** Layouts kept before the least-recently-used ones are pruned. */
export const DOCK_LAYOUT_LIMIT = 200
/** Layouts untouched for this long are dropped on rehydrate. */
export const DOCK_LAYOUT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface DockLayoutStoreState {
  envelopes: Record<string, DockLayoutEnvelope>
  /** In-session undo stacks, one per layout. Never persisted. */
  histories: Record<string, DockHistoryState>
  /** The most recent rejection per layout, for diagnostics. Never persisted. */
  lastRejection: Record<string, DockTransactionRejection>

  ensureLayout: (key: DockLayoutKey) => DockLayoutEnvelope
  getLayout: (key: DockLayoutKey) => DockLayoutEnvelope | undefined
  /** Seed a layout from a one-way legacy read. No-op if one already exists. */
  adoptLayout: (envelope: DockLayoutEnvelope) => boolean
  commit: (key: DockLayoutKey, transaction: DockTransaction) => boolean

  setGrid: (key: DockLayoutKey, grid: DockSerializedGrid | null) => boolean
  setInstances: (key: DockLayoutKey, instances: DockPanelInstance[]) => boolean
  setShellSize: (key: DockLayoutKey, sizePercent: number) => boolean
  setShellCollapsed: (key: DockLayoutKey, collapsed: boolean, railOnly?: boolean) => boolean
  setShellEdge: (key: DockLayoutKey, edge: DockShellEdge) => boolean

  undo: (key: DockLayoutKey) => boolean
  redo: (key: DockLayoutKey) => boolean
  canUndo: (key: DockLayoutKey) => boolean
  canRedo: (key: DockLayoutKey) => boolean

  removeLayout: (key: DockLayoutKey) => void
  resetLayout: (key: DockLayoutKey) => void
}

export function createEmptyDockLayout(key: DockLayoutKey, now: number): DockLayoutEnvelope {
  return {
    schemaVersion: DOCK_LAYOUT_SCHEMA_VERSION,
    key,
    grid: null,
    instances: [],
    shell: { ...DEFAULT_DOCK_SHELL_STATE },
    revision: 0,
    updatedAt: now,
  }
}

/**
 * LRU + age prune, applied at the persistence boundary.
 *
 * Same policy as the Context Workbench's 200-entry / 30-day rule, for the same
 * reason: a layout per project file across a long-lived install grows without
 * bound otherwise, and localStorage has no eviction of its own.
 */
export function pruneDockLayouts(
  envelopes: Record<string, DockLayoutEnvelope>,
  now: number
): Record<string, DockLayoutEnvelope> {
  const fresh = Object.entries(envelopes).filter(
    ([, envelope]) => now - envelope.updatedAt <= DOCK_LAYOUT_MAX_AGE_MS
  )
  if (fresh.length <= DOCK_LAYOUT_LIMIT) return Object.fromEntries(fresh)
  const kept = fresh.sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, DOCK_LAYOUT_LIMIT)
  return Object.fromEntries(kept)
}

export const useDockLayoutStore = create<DockLayoutStoreState>()(
  persist(
    (set, get) => {
      /** Read-or-create without committing — callers still go through `commit`. */
      const read = (key: DockLayoutKey): DockLayoutEnvelope => {
        const id = dockLayoutKeyOf(key)
        return get().envelopes[id] ?? createEmptyDockLayout(key, Date.now())
      }

      const runCommit = (key: DockLayoutKey, transaction: DockTransaction): boolean => {
        const id = dockLayoutKeyOf(key)
        const current = read(key)
        const history = get().histories[id] ?? EMPTY_DOCK_HISTORY
        const { result, history: nextHistory } = commitDockTransaction(
          current,
          history,
          transaction,
          Date.now()
        )
        if (!result.ok) {
          set((state) => ({
            lastRejection: { ...state.lastRejection, [id]: result.rejection },
          }))
          return false
        }
        set((state) => ({
          envelopes: { ...state.envelopes, [id]: result.envelope },
          histories: { ...state.histories, [id]: nextHistory },
        }))
        return true
      }

      /** Commit a field edit against whatever revision is current. */
      const edit = (
        key: DockLayoutKey,
        label: string,
        apply: DockTransaction["apply"],
        structural = false
      ) => runCommit(key, { baseRevision: read(key).revision, label, apply, structural })

      const step = (key: DockLayoutKey, direction: "undo" | "redo"): boolean => {
        const id = dockLayoutKeyOf(key)
        const current = get().envelopes[id]
        if (!current) return false
        const history = get().histories[id] ?? EMPTY_DOCK_HISTORY
        const move = direction === "undo" ? undoDockLayout : redoDockLayout
        const stepped = move(current, history, Date.now())
        if (!stepped) return false
        set((state) => ({
          envelopes: { ...state.envelopes, [id]: stepped.envelope },
          histories: { ...state.histories, [id]: stepped.history },
        }))
        return true
      }

      return {
        envelopes: {},
        histories: {},
        lastRejection: {},

        getLayout: (key) => get().envelopes[dockLayoutKeyOf(key)],

        ensureLayout: (key) => {
          const id = dockLayoutKeyOf(key)
          const existing = get().envelopes[id]
          if (existing) return existing
          const envelope = createEmptyDockLayout(key, Date.now())
          set((state) => ({ envelopes: { ...state.envelopes, [id]: envelope } }))
          return envelope
        },

        adoptLayout: (envelope) => {
          const id = dockLayoutKeyOf(envelope.key)
          if (get().envelopes[id]) return false
          set((state) => ({ envelopes: { ...state.envelopes, [id]: envelope } }))
          return true
        },

        commit: runCommit,

        setGrid: (key, grid) =>
          edit(key, "grid.replace", (current) => ({ ...current, grid }), true),

        setInstances: (key, instances) =>
          edit(key, "instances.replace", (current) => ({ ...current, instances }), true),

        setShellSize: (key, sizePercent) =>
          edit(key, "shell.resize", (current) => ({
            ...current,
            shell: { ...current.shell, sizePercent: clampDockShellSize(sizePercent) },
          })),

        setShellCollapsed: (key, collapsed, railOnly) =>
          edit(key, "shell.collapse", (current) => ({
            ...current,
            shell: {
              ...current.shell,
              collapsed,
              railOnly: railOnly ?? current.shell.railOnly,
            },
          })),

        setShellEdge: (key, edge) =>
          edit(
            key,
            "shell.edge",
            (current) => ({
              ...current,
              shell: { ...current.shell, edge },
            }),
            true
          ),

        undo: (key) => step(key, "undo"),
        redo: (key) => step(key, "redo"),
        canUndo: (key) =>
          canUndoDockLayout(get().histories[dockLayoutKeyOf(key)] ?? EMPTY_DOCK_HISTORY),
        canRedo: (key) =>
          canRedoDockLayout(get().histories[dockLayoutKeyOf(key)] ?? EMPTY_DOCK_HISTORY),

        removeLayout: (key) => {
          const id = dockLayoutKeyOf(key)
          set((state) => {
            const { [id]: _envelope, ...envelopes } = state.envelopes
            const { [id]: _history, ...histories } = state.histories
            const { [id]: _rejection, ...lastRejection } = state.lastRejection
            return { envelopes, histories, lastRejection }
          })
        },

        resetLayout: (key) =>
          void edit(
            key,
            "layout.reset",
            (current) => ({
              ...createEmptyDockLayout(key, current.updatedAt),
              revision: current.revision,
            }),
            true
          ),
      }
    },
    {
      name: "cognia-dock-layout-v1",
      version: 1,
      storage: persistLocalStorage(),
      // Histories and rejections are runtime-only: an undo stack you cannot see
      // the other end of is not one you can meaningfully step through.
      partialize: (state) => ({ envelopes: pruneDockLayouts(state.envelopes, Date.now()) }),
      merge: (persisted, current) => {
        const incoming = (persisted as Partial<DockLayoutStoreState> | undefined)?.envelopes ?? {}
        return { ...current, envelopes: pruneDockLayouts(incoming, Date.now()) }
      },
    }
  )
)
