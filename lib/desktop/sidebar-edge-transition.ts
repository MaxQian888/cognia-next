/**
 * Run a conversation-sidebar collapse/expand as one View Transition.
 *
 * The gesture redraws a whole row at once — the rail aside, the sidebar, the
 * workspace column and the title-bar outlets above all of them — and until it
 * ran under a single transition the pieces disagreed about timing: the sidebar
 * tweens its width on the compositor while the workspace reflows live and the
 * outlets jump whenever their measured columns update. Capturing every part in
 * one `document.startViewTransition` animates old/new snapshots in lock-step
 * on the same clock, so nothing can run ahead of or flash behind its
 * neighbour.
 *
 * Every `sidebarCollapsed` write — toggle button, keyboard shortcut, View
 * menu, edge peek — is funnelled through here by `stores/ui/ui-store.ts`, so
 * the store action stays the single place the DOM mutation is issued.
 *
 * View Transitions are progressive enhancement. An engine without them (and
 * jsdom, and any scope containing a pinned native Pro IDE webview) takes the
 * instant path: the sidebar's own `useEdgePanelTransition` still animates its
 * column exactly as it did before this wrapper existed.
 */

import { runShellViewTransition } from "@/lib/ui/shell-view-transition"
import { useSettingsStore } from "@/stores/settings"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { DEFAULT_SIDEBAR_SIDE } from "@/types/shell/sidebar"

const TITLE_BAR_ZONES = ["start", "center", "end"] as const

/**
 * @param apply mutates the DOM to the gesture's final state — the
 *   `sidebarCollapsed` store write plus its plugin-event dispatch. Runs inside
 *   the transition's update callback, or synchronously on every bail-out.
 * @param sidebarTargetPx the width the sidebar is animating *to* — `0` when
 *   collapsing, the persisted `sidebarWidth` when expanding. The caller knows
 *   the gesture's direction; this module cannot read it back off the store
 *   without a circular import, and cannot read it off the DOM before the
 *   commit lands.
 */
export function runSidebarGesture(apply: () => void, sidebarTargetPx: number): void {
  if (typeof document === "undefined") {
    apply()
    return
  }
  const aside = document.getElementById("conversation-sidebar")
  const workspace = document.querySelector<HTMLElement>('[data-testid="artifact-workspace-dock"]')
  if (!aside || !workspace) {
    apply()
    return
  }
  // The aside's width *before* the commit — the row gains exactly this much
  // minus the sidebar's resting width. Measured now because the store write
  // below commits in a microtask: anything read afterwards is still the
  // pre-gesture layout.
  const asidePrePx = aside.getBoundingClientRect().width

  // Tells `app/globals.css` which window edge the sidebar is pinned to, so the
  // capture rules can anchor each snapshot's content at the edge that does not
  // move during the gesture. Mirrors a persisted preference — setting it again
  // before each gesture is idempotent and it is intentionally left in place.
  document.documentElement.dataset.shellEdge =
    useSettingsStore.getState().settings?.sidebarSide ?? DEFAULT_SIDEBAR_SIDE

  const rail = document.querySelector<HTMLElement>('[data-variant="rail"]')
  const [outletStart, outletCenter, outletEnd] = TITLE_BAR_ZONES.map((zone) =>
    document.querySelector<HTMLElement>(`[data-title-bar-outlet="${zone}"]`)
  )

  runShellViewTransition({
    scope: workspace,
    captures: [
      { element: aside, name: "cognia-shell-sidebar" },
      { element: rail, name: "cognia-shell-rail" },
      { element: workspace, name: "cognia-shell-workspace" },
      { element: outletStart, name: "cognia-shell-outlet-start" },
      { element: outletCenter, name: "cognia-shell-outlet-center" },
      { element: outletEnd, name: "cognia-shell-outlet-end" },
    ],
    apply: () => {
      apply()
      // The artifact dock resizes with the workspace row but runs no gesture
      // of its own — publish its settled width so the end outlet lands on the
      // same final geometry the snapshot shows instead of snapping to a stale
      // measurement when the transition ends. The store write above only
      // *schedules* the row's new layout (React commits it in a microtask), so
      // the settled width is computed rather than measured: the dock holds a
      // fixed percentage of its resizable group, and the group grows by what
      // the sidebar frees. The summary aside is a fixed-width sibling outside
      // the group — while it owns the reported column its width does not move.
      const summary = document.getElementById("session-summary-dock")
      if (summary && summary.getBoundingClientRect().width > 0) {
        useShellColumnsStore
          .getState()
          .setColumnTarget("dock", summary.getBoundingClientRect().width)
        return
      }
      const dockPanel = workspace
        .querySelector<HTMLElement>('[data-testid="artifact-dock-wrapper"]')
        ?.closest<HTMLElement>("[data-panel]")
      const group = dockPanel?.parentElement
      const groupPrePx = group?.getBoundingClientRect().width ?? 0
      if (!dockPanel || !groupPrePx) return
      const dockPrePx = dockPanel.getBoundingClientRect().width
      // A pixel-sized dock (the persistent workbench rail, a workspace floor)
      // holds its width as the group changes; a percentage one scales with it.
      const dockPostPx = dockPanel.getAttribute("data-size")?.endsWith("px")
        ? dockPrePx
        : Math.max(0, (dockPrePx / groupPrePx) * (groupPrePx + asidePrePx - sidebarTargetPx))
      useShellColumnsStore.getState().setColumnTarget("dock", dockPostPx)
    },
    onDone: () => useShellColumnsStore.getState().setColumnTarget("dock", null),
  })
}
