"use client"

/**
 * The dock shell: a 48px activity rail beside a dockview grid.
 *
 * Two things here are load-bearing and easy to get wrong.
 *
 * **dockview's component registry must be static.** It resolves
 * `contentComponent` / `tabComponent` by name against an object it is handed,
 * and rebuilding that object per render remounts every panel. So the two
 * renderers are module-level and read what they need from `DockHostContext` —
 * closures over props would force a new registry on every render.
 *
 * **dockview is an emitter, never a writer.** `onDidLayoutChange` fires on
 * every intermediate frame of a drag with no way to suppress it. Those events
 * go through `createDockDragGate`, which drops them mid-gesture and releases
 * one settled change, and only that settled change becomes a transaction. The
 * store's revision check is the backstop if one still arrives out of order.
 *
 * Restore never trusts what it reads: the persisted grid goes through
 * `sanitizeDockGrid` against the instance table before dockview sees it.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  DockviewReact,
  type DockviewApi,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react"
import { cn } from "@/lib/utils"
import { createDockDragGate } from "@/lib/dock/drag-gate"
import {
  DOCK_PANEL_COMPONENT,
  DOCK_TAB_COMPONENT,
  sanitizeDockGrid,
} from "@/lib/dock/sanitize-grid"
import { useDockLayout, type UseDockLayoutOptions } from "@/hooks/dock/use-dock-layout"
import { useDockLayoutStore } from "@/stores/dock/dock-layout-store"
import { DockPanelSurface } from "./dock-panel-surface"
import { DockTab } from "./dock-tab"
import { WORKBENCH_ACTIVITY_ICONS } from "@/lib/shell/workbench-rail"
import {
  CONTEXT_ACTIVITY_RAIL_ORDER,
  type ContextActivity,
  type ContextResource,
} from "@/types/context-workbench"
import type { DockPanelInstance } from "@/types/dock/instance"
import type { ResolvedDockPanel } from "@/types/dock/panel"

interface DockHostContextValue {
  instancesById: Map<string, DockPanelInstance>
  panelsById: Map<string, ResolvedDockPanel>
  resource: ContextResource
  workbenchInstanceId: string
  activeInstanceId: string | null
  pin: (instanceId: string) => void
  close: (instanceId: string) => void
  select: (instanceId: string) => void
  markActivated: (instanceId: string) => void
  titleFor: (instance: DockPanelInstance) => string
}

const DockHostContext = createContext<DockHostContextValue | null>(null)

function useDockHost(): DockHostContextValue {
  const value = useContext(DockHostContext)
  if (!value) throw new Error("Dock panel rendered outside a DockHost")
  return value
}

function DockPanelComponent(props: IDockviewPanelProps) {
  const host = useDockHost()
  const instance = host.instancesById.get(props.api.id)
  if (!instance) return null
  return (
    <DockPanelSurface
      instance={instance}
      panel={host.panelsById.get(instance.panelId)}
      resource={host.resource}
      workbenchInstanceId={host.workbenchInstanceId}
      active={host.activeInstanceId === instance.instanceId}
      onActivated={host.markActivated}
    />
  )
}

function DockTabComponent(props: IDockviewPanelHeaderProps) {
  const host = useDockHost()
  const instance = host.instancesById.get(props.api.id)
  if (!instance) return null
  return (
    <DockTab
      instance={instance}
      title={host.titleFor(instance)}
      active={host.activeInstanceId === instance.instanceId}
      onPin={host.pin}
      onSelect={host.select}
      onRequestClose={host.close}
    />
  )
}

/**
 * Static registries — see the note at the top of the file. Exported so tests
 * can render a panel outside the provider and prove the guard, which is the
 * only way a dockview portal escaping the tree would surface.
 */
export const DOCK_COMPONENTS = { [DOCK_PANEL_COMPONENT]: DockPanelComponent }
export const DOCK_TAB_COMPONENTS = { [DOCK_TAB_COMPONENT]: DockTabComponent }

export interface DockHostProps extends UseDockLayoutOptions {
  /** Stable per host mount; forwarded to every panel renderer. */
  workbenchInstanceId: string
  className?: string
  /**
   * Shrink to the activity rail. The grid unmounts rather than hides, because a
   * native-surface panel holds a process-wide webview lease that only an
   * unmount releases (ADR-0098).
   */
  railOnly?: boolean
  /**
   * Rail order, so a host can pass the user's stored `settings.workbenchRail`.
   * Defaults to the canonical order.
   */
  railOrder?: readonly ContextActivity[]
}

export function DockHost({
  workbenchInstanceId,
  className,
  railOnly = false,
  railOrder = CONTEXT_ACTIVITY_RAIL_ORDER,
  ...layoutOptions
}: DockHostProps) {
  const t = useTranslations("dock")
  const layout = useDockLayout(layoutOptions)
  const apiRef = useRef<DockviewApi | null>(null)
  /**
   * State, not a ref: this decides which tab renders as active, so a ref would
   * hold the right value and never repaint the strip.
   */
  const [activePanelId, setActivePanelId] = useState<string | null>(null)

  const instancesById = useMemo(
    () => new Map(layout.instances.map((instance) => [instance.instanceId, instance])),
    [layout.instances]
  )

  const titleFor = useCallback(
    (instance: DockPanelInstance) => {
      const panel = layout.panelsById.get(instance.panelId)
      return panel?.definition.label ?? instance.panelId
    },
    [layout.panelsById]
  )

  const select = useCallback((instanceId: string) => {
    apiRef.current?.getPanel(instanceId)?.api.setActive()
  }, [])

  const close = useCallback(
    (instanceId: string) => {
      // The dirty guard lives in the hook and can refuse; only remove the
      // dockview panel once the table actually let go of the instance.
      if (!layout.close(instanceId)) return
      const panel = apiRef.current?.getPanel(instanceId)
      if (panel) apiRef.current?.removePanel(panel)
    },
    [layout]
  )

  // dockview's active panel wins; otherwise the most recently opened tab, so
  // the strip never renders with nothing selected.
  const activeInstanceId =
    layout.instances.find((i) => i.instanceId === activePanelId)?.instanceId ??
    layout.instances.at(-1)?.instanceId ??
    null

  const hostValue = useMemo<DockHostContextValue>(
    () => ({
      instancesById,
      panelsById: layout.panelsById,
      resource: layoutOptions.resource,
      workbenchInstanceId,
      activeInstanceId,
      pin: layout.pin,
      close,
      select,
      markActivated: layout.markActivated,
      titleFor,
    }),
    [
      instancesById,
      layout.panelsById,
      layout.pin,
      layout.markActivated,
      layoutOptions.resource,
      workbenchInstanceId,
      activeInstanceId,
      close,
      select,
      titleFor,
    ]
  )

  /**
   * Reconcile dockview's panels with the instance table.
   *
   * The table is authoritative: dockview is told to add what it is missing and
   * remove what the table no longer has. Doing it the other way round would
   * make a mid-drag dockview state able to delete an instance.
   */
  const syncPanels = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    const wanted = new Set(layout.instances.map((i) => i.instanceId))
    for (const panel of api.panels) {
      if (!wanted.has(panel.id)) api.removePanel(panel)
    }
    for (const instance of layout.instances) {
      if (api.getPanel(instance.instanceId)) continue
      api.addPanel({
        id: instance.instanceId,
        component: DOCK_PANEL_COMPONENT,
        tabComponent: DOCK_TAB_COMPONENT,
        title: titleFor(instance),
        // `renderer: "always"` keeps a stateful panel mounted while it is in the
        // background — the Context Workbench's `<Activity>` behaviour, which
        // panels rely on to keep scroll position and in-flight work.
        renderer:
          layout.panelsById.get(instance.panelId)?.meta.retention === "ephemeral"
            ? "onlyWhenVisible"
            : "always",
      })
    }
  }, [layout.instances, layout.panelsById, titleFor])

  const onReady = useCallback(
    (event: { api: DockviewApi }) => {
      apiRef.current = event.api
      // Active-panel changes arrive on the api, not as a prop.
      event.api.onDidActivePanelChange(({ panel }) => {
        setActivePanelId(panel?.id ?? null)
      })
      const current = useDockLayoutStore.getState().ensureLayout(layoutOptions.layoutKey)
      const sanitized = sanitizeDockGrid(
        current.grid,
        current.instances.map((i) => i.instanceId)
      )
      if (sanitized.grid) {
        try {
          event.api.fromJSON(sanitized.grid as never)
        } catch (error) {
          // A grid that survived sanitisation can still be structurally
          // impossible for this viewport. Falling back to the default layout is
          // strictly better than an unusable dock.
          console.error("Dock layout restore failed; starting from the default", error)
          event.api.clear()
        }
      }
      syncPanels()
    },
    [layoutOptions.layoutKey, syncPanels]
  )

  // Runs unconditionally: while `railOnly` is on there is no dockview at all,
  // and the api guard inside is what makes that a no-op rather than a branch
  // here that would forget to re-sync when the dock reopens.
  useEffect(() => syncPanels(), [syncPanels])

  // Persist the grid, once per settled gesture.
  useEffect(() => {
    const api = apiRef.current
    // No api means the dock is collapsed to the rail: dockview is not mounted,
    // so there is nothing emitting and nothing to persist.
    if (!api) return
    const gate = createDockDragGate({
      onSettled: () => {
        useDockLayoutStore
          .getState()
          .setGrid(layoutOptions.layoutKey, api.toJSON() as unknown as Record<string, unknown>)
      },
    })
    const subscription = api.onDidLayoutChange(() => gate.notifyLayoutChange())
    return () => {
      subscription.dispose()
      gate.dispose()
    }
  }, [layoutOptions.layoutKey, railOnly])

  /**
   * One rail button per activity that actually has a panel, carrying the panel
   * it opens. Resolving the panel here rather than on click means the rail
   * cannot render a button that leads nowhere.
   */
  const railEntries = useMemo(() => {
    const firstByActivity = new Map<ContextActivity, string>()
    for (const panel of layout.panels) {
      if (!firstByActivity.has(panel.definition.activity)) {
        firstByActivity.set(panel.definition.activity, panel.definition.id)
      }
    }
    return railOrder
      .map((activity) => ({ activity, panelId: firstByActivity.get(activity) }))
      .filter(
        (entry): entry is { activity: ContextActivity; panelId: string } =>
          entry.panelId !== undefined
      )
  }, [layout.panels, railOrder])

  return (
    <div
      className={cn("flex h-full min-h-0", className)}
      data-testid="dock-host"
      aria-label={t("a11y.host")}
    >
      <nav
        className="flex w-12 shrink-0 flex-col items-center gap-1 border-r py-2"
        data-testid="dock-activity-rail"
      >
        {railEntries.map(({ activity, panelId }) => {
          const Icon = WORKBENCH_ACTIVITY_ICONS[activity as keyof typeof WORKBENCH_ACTIVITY_ICONS]
          return (
            <button
              key={activity}
              type="button"
              data-testid={`dock-rail-${activity}`}
              className="rounded p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => layout.reveal({ panelId, source: "user", focus: "focus" })}
            >
              {Icon ? <Icon className="size-4" aria-hidden /> : null}
              <span className="sr-only">{activity}</span>
            </button>
          )
        })}
      </nav>

      {railOnly ? null : (
        <div className="min-w-0 flex-1" data-testid="dock-grid">
          <DockHostContext.Provider value={hostValue}>
            <DockviewReact
              components={DOCK_COMPONENTS}
              tabComponents={DOCK_TAB_COMPONENTS}
              onReady={onReady}
            />
          </DockHostContext.Provider>
        </div>
      )}
    </div>
  )
}
