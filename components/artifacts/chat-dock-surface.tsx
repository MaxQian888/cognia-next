"use client"

/**
 * The chat dock, rendered on the unified Dock kernel (ADR-0102).
 *
 * The twin of `<ContextWorkbench>` in `artifact-dock.tsx`: same resource, same
 * panel list, different engine. Which one a user gets is
 * `isDockKernelSurfaceEnabled("chat")`, and the workbench branch stays in the
 * tree byte-for-byte as the rollback path.
 *
 * Two things happen here that `DockHost` deliberately does not do for itself.
 *
 * **Seeding from the pre-Dock stores.** The kernel has no envelope for a
 * conversation the first time it opens on the Dock, and `DockHost.onReady`
 * would create an empty one. `migrateLegacyDockLayout` runs *before* the host
 * mounts — in a `useState` initializer, the one place guaranteed to run before
 * children — so the user finds the panel they had open and the width they had
 * dragged to, rather than a bare dock.
 *
 * **Rail order.** The kernel ships the canonical order; the user's stored
 * `settings.workbenchRail` is what they actually arranged. Read here rather
 * than inside `DockHost` so the kernel keeps no dependency on the settings
 * store.
 */

import { useMemo, useState } from "react"
import { DockHost } from "@/components/dock/dock-host"
import { workbenchRailLayoutOf } from "@/components/shell/use-workbench-rail-layout"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { indexDockPanels, resolveDockPanels } from "@/lib/dock/panel-registry"
import { migrateLegacyDockLayout } from "@/lib/dock/migrate-legacy-layout"
import { isWorkbenchActivityHidden, workbenchRailIndex } from "@/lib/shell/workbench-rail"
import { useDockLayoutStore } from "@/stores/dock/dock-layout-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  CONTEXT_ACTIVITY_RAIL_ORDER,
  type ContextActivity,
  type ContextResource,
} from "@/types/context-workbench"
import type { DockLayoutKey } from "@/types/dock/layout"
import type { DockPanelDefinition } from "@/types/dock/panel"

export interface ChatDockSurfaceProps {
  workbenchInstanceId: string
  resource: ContextResource
  panels: readonly DockPanelDefinition[]
  /**
   * What scopes this dock. The conversation, for both surfaces: an artifact
   * tab switch must not hand the user a different arrangement, exactly as
   * `scope: "session"` keeps the browser and the workspace mounted across one.
   */
  contextId: string
  /** The scope key the Context Workbench used, so the seed can find it. */
  legacyScopeKey: string
  railOnly?: boolean
  className?: string
}

export function ChatDockSurface({
  workbenchInstanceId,
  resource,
  panels,
  contextId,
  legacyScopeKey,
  railOnly,
  className,
}: ChatDockSurfaceProps) {
  const layoutKey = useMemo<DockLayoutKey>(
    () => ({ accountId: getActiveAccountId(), host: "chat", contextId }),
    [contextId]
  )

  const storedRailLayout = useSettingsStore((state) => state.settings?.workbenchRail)
  const railOrder = useMemo<readonly ContextActivity[]>(() => {
    const layout = workbenchRailLayoutOf(storedRailLayout)
    return CONTEXT_ACTIVITY_RAIL_ORDER.filter(
      (activity) => !isWorkbenchActivityHidden(activity, layout)
    ).sort((left, right) => workbenchRailIndex(left, layout) - workbenchRailIndex(right, layout))
  }, [storedRailLayout])

  // Before `DockHost` mounts and calls `ensureLayout`, which would create the
  // empty envelope this seed can no longer replace. `adoptLayout` is a no-op
  // once a layout exists, so a re-run — a remount, StrictMode's double-invoke —
  // cannot resurrect the old arrangement over one the user has since made.
  useState(() => {
    const seed = migrateLegacyDockLayout({
      key: layoutKey,
      legacyScopeKey,
      available: indexDockPanels(
        resolveDockPanels({ resource, native: panels as DockPanelDefinition[] })
      ),
      createInstanceId: () =>
        `dock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      now: Date.now(),
    })
    if (seed) useDockLayoutStore.getState().adoptLayout(seed)
    return true
  })

  return (
    <DockHost
      layoutKey={layoutKey}
      resource={resource}
      panels={panels}
      workbenchInstanceId={workbenchInstanceId}
      railOnly={railOnly}
      railOrder={railOrder}
      className={className}
    />
  )
}
