"use client"

/**
 * The dock kernel's public API to a host.
 *
 * A host hands over its resource and its own panel definitions; it gets back
 * the resolved panels, the live instance table, and the operations a dock
 * supports. Everything underneath — resolution, reveal policy, the transaction
 * engine, persistence — is assembled here so a host never talks to the store
 * directly and cannot become a second writer.
 *
 * Every mutation goes through `commit`, so each one is a single transaction
 * against a known revision. Reads come straight from the store so the host
 * re-renders when anything lands, including a change some *other* surface made
 * to the same layout.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useDockLayoutStore } from "@/stores/dock/dock-layout-store"
import {
  getDockPanelsRevision,
  indexDockPanels,
  resolveDockPanels,
  subscribeDockPanels,
} from "@/lib/dock/panel-registry"
import {
  closeDockInstance,
  dirtyDockInstances,
  markDockInstanceActivated,
  pinDockInstance,
  planDockReveal,
  reconcileDockInstances,
  setDockInstanceDirty,
} from "@/lib/dock/instances"
import type { ContextResource } from "@/types/context-workbench"
import type { DockPanelInstance } from "@/types/dock/instance"
import type { DockLayoutKey } from "@/types/dock/layout"
import type { DockPanelDefinition, ResolvedDockPanel } from "@/types/dock/panel"
import type { DockRevealOutcome, DockRevealRequest } from "@/types/dock/reveal"

export interface UseDockLayoutOptions {
  /**
   * Named `layoutKey`, not `key`: these options are spread onto `<DockHost>`,
   * and React would swallow a prop called `key` as its own reconciliation key —
   * the dock would then receive `undefined` and silently share one layout
   * across every host.
   */
  layoutKey: DockLayoutKey
  resource: ContextResource
  /** The host's own panel definitions, exactly as `ContextWorkbench` takes them. */
  panels: readonly DockPanelDefinition[]
  /** The user pinned the layout: automatic reveals become badges. */
  userPinned?: boolean
  /** True while the user is mid-interaction elsewhere in the dock. */
  userBusy?: boolean
  /** Mints instance ids. Injected so tests and SSR stay deterministic. */
  createInstanceId?: () => string
  /**
   * Confirm losing unsaved work. Returning false cancels the close — the only
   * point at which that is still possible, since dockview removes panels
   * synchronously.
   */
  confirmDiscard?: (dirty: readonly DockPanelInstance[]) => boolean
}

export interface UseDockLayoutResult {
  panels: ResolvedDockPanel[]
  panelsById: Map<string, ResolvedDockPanel>
  instances: DockPanelInstance[]
  revision: number
  reveal: (request: DockRevealRequest) => DockRevealOutcome
  pin: (instanceId: string) => void
  close: (instanceId: string) => boolean
  setDirty: (instanceId: string, dirty: boolean) => void
  markActivated: (instanceId: string) => void
  /** Drop instances whose panel stopped resolving. Returns what was dropped. */
  reconcile: () => DockPanelInstance[]
  canUndo: boolean
  canRedo: boolean
  undo: () => boolean
  redo: () => boolean
}

const defaultCreateInstanceId = () =>
  `dock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export function useDockLayout(options: UseDockLayoutOptions): UseDockLayoutResult {
  const {
    layoutKey: key,
    resource,
    panels: nativePanels,
    userPinned = false,
    userBusy = false,
    createInstanceId = defaultCreateInstanceId,
    confirmDiscard,
  } = options

  // Re-resolve whenever the plugin registry changes: a disabled plugin has to
  // reach the dock, or it keeps rendering a panel whose renderer is gone.
  const registryRevision = useSyncExternalStore(subscribeDockPanels, getDockPanelsRevision, () => 0)

  const panels = useMemo(
    () => resolveDockPanels({ resource, native: nativePanels as DockPanelDefinition[] }),
    // `registryRevision` is the invalidation signal, not a value we read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resource, nativePanels, registryRevision]
  )
  const panelsById = useMemo(() => indexDockPanels(panels), [panels])

  const envelope = useDockLayoutStore((state) => state.getLayout(key))
  const instances = useMemo(() => envelope?.instances ?? [], [envelope])
  const revision = envelope?.revision ?? 0

  /** One transaction per mutation, always against the revision we just read. */
  const commitInstances = useCallback(
    (label: string, next: DockPanelInstance[], structural: boolean) =>
      useDockLayoutStore.getState().commit(key, {
        baseRevision: useDockLayoutStore.getState().ensureLayout(key).revision,
        label,
        structural,
        apply: (current) => ({ ...current, instances: next }),
      }),
    [key]
  )

  const reveal = useCallback(
    (request: DockRevealRequest): DockRevealOutcome => {
      const current = useDockLayoutStore.getState().ensureLayout(key)
      const plan = planDockReveal(request, {
        instances: current.instances,
        available: panelsById,
        userPinned,
        userBusy,
        createInstanceId,
      })
      if (plan.outcome.kind !== "unavailable") {
        commitInstances(
          `reveal.${plan.outcome.kind}`,
          plan.instances,
          plan.outcome.kind === "opened"
        )
      }
      return plan.outcome
    },
    [key, panelsById, userPinned, userBusy, createInstanceId, commitInstances]
  )

  const pin = useCallback(
    (instanceId: string) => {
      const current = useDockLayoutStore.getState().ensureLayout(key)
      commitInstances("tab.pin", pinDockInstance(current.instances, instanceId), false)
    },
    [key, commitInstances]
  )

  const close = useCallback(
    (instanceId: string) => {
      const current = useDockLayoutStore.getState().ensureLayout(key)
      const dirty = dirtyDockInstances(current.instances, [instanceId])
      if (dirty.length > 0 && confirmDiscard && !confirmDiscard(dirty)) return false
      commitInstances("tab.close", closeDockInstance(current.instances, instanceId), true)
      return true
    },
    [key, confirmDiscard, commitInstances]
  )

  const setDirty = useCallback(
    (instanceId: string, dirty: boolean) => {
      const current = useDockLayoutStore.getState().ensureLayout(key)
      const next = setDockInstanceDirty(current.instances, instanceId, dirty)
      if (next === current.instances) return
      commitInstances("tab.dirty", next, false)
    },
    [key, commitInstances]
  )

  const markActivated = useCallback(
    (instanceId: string) => {
      const current = useDockLayoutStore.getState().ensureLayout(key)
      const next = markDockInstanceActivated(current.instances, instanceId)
      if (next === current.instances) return
      commitInstances("tab.activated", next, false)
    },
    [key, commitInstances]
  )

  const reconcile = useCallback(() => {
    const current = useDockLayoutStore.getState().ensureLayout(key)
    const result = reconcileDockInstances(current.instances, panelsById)
    if (result.unavailable.length === 0) return []
    // The instances are dropped from the table but the *host* keeps rendering a
    // placeholder for them until it decides otherwise — see
    // `DockPanelSurface`. Returning them is how it learns which.
    commitInstances("instances.reconcile", result.instances, true)
    return result.unavailable
  }, [key, panelsById, commitInstances])

  const canUndo = useDockLayoutStore((state) => state.canUndo(key))
  const canRedo = useDockLayoutStore((state) => state.canRedo(key))
  const undo = useCallback(() => useDockLayoutStore.getState().undo(key), [key])
  const redo = useCallback(() => useDockLayoutStore.getState().redo(key), [key])

  return {
    panels,
    panelsById,
    instances,
    revision,
    reveal,
    pin,
    close,
    setDirty,
    markActivated,
    reconcile,
    canUndo,
    canRedo,
    undo,
    redo,
  }
}
