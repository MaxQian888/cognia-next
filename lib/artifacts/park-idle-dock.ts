/**
 * Fold the artifact dock away when the conversation coming on screen has
 * nothing to show in it.
 *
 * `dockCollapsed` is persisted, and every reveal writes `false` to it — so once
 * an artifact has ever raised the dock, the column stays open for every
 * conversation after it, including ones with no artifacts at all. That is the
 * empty "No artifacts yet" panel holding a quarter of the window beside a fresh
 * chat. Claude.ai's artifact pane closes when you move to a conversation that
 * has none; this is the same rule.
 *
 * The check is deliberately narrow — every one of these must hold, or the dock
 * is left where the user put it:
 *
 * - the dock is open;
 * - the conversation has no artifact of its own, no open artifact tabs and no
 *   revision proposal awaiting review;
 * - the session surface is on its default artifact-list panel (or has no
 *   recorded panel yet). A dock parked on the browser, the workspace, memory or
 *   logs was opened *for* that panel and is not idle.
 *
 * Runs from the session-focus seam, i.e. on a conversation switch and once at
 * start-up, never on an ordinary re-render — so opening the dock by hand on an
 * empty conversation sticks until you leave that conversation.
 *
 * Parking is not a dismissal: `parkDock` leaves `userDismissed` alone, so the
 * next artifact to arrive still raises the dock (`notifyNewArtifact`), where a
 * manual close would only flag the toggle unread.
 */

import { getContextWorkbenchWindowScope } from "@/hooks/context-workbench/use-context-workbench-instance-id"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import {
  selectActiveArtifactId,
  selectOpenArtifactIds,
  useArtifactStore,
} from "@/stores/artifact/artifact-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import {
  ARTIFACT_DOCK_WORKBENCH_HOST_KEY,
  SESSION_ARTIFACT_LIST_PANEL_ID,
  sessionWorkbenchScopeKey,
} from "./session-workbench-scope-key"

/**
 * Whether `sessionId` has anything the dock exists to show — an active tab, any
 * open tab, an artifact recorded against it, or a proposal awaiting review.
 * `null` (no conversation on screen) holds nothing.
 */
export function sessionHoldsArtifacts(sessionId: string | null): boolean {
  if (!sessionId) return false
  const state = useArtifactStore.getState()
  if (selectActiveArtifactId(state, sessionId)) return true
  if (selectOpenArtifactIds(state, sessionId).length > 0) return true
  for (const artifact of Object.values(state.artifacts)) {
    if (artifact.sessionId === sessionId) return true
  }
  for (const artifactId of Object.keys(state.pendingReviews)) {
    if (state.artifacts[artifactId]?.sessionId === sessionId) return true
  }
  return false
}

/**
 * The panel the dock's session surface would show for `sessionId`, as the
 * workbench recorded it — `null` when the conversation has never had a panel
 * chosen, in which case the surface opens on the artifact list.
 */
export function sessionSurfaceActivePanelId(sessionId: string | null): string | null {
  const scopeKey = sessionWorkbenchScopeKey(
    `${getContextWorkbenchWindowScope()}:${ARTIFACT_DOCK_WORKBENCH_HOST_KEY}`,
    sessionId
  )
  return useContextWorkbenchStore.getState().layouts[scopeKey]?.activePanelId ?? null
}

/**
 * Park the dock if it is idle for `sessionId`. Returns whether it did, so the
 * seam's test can assert the decision without re-deriving it.
 */
export function parkIdleArtifactDock(sessionId: string | null): boolean {
  const dock = useArtifactDockLayoutStore.getState()
  if (dock.dockCollapsed) return false
  if (sessionHoldsArtifacts(sessionId)) return false
  const activePanelId = sessionSurfaceActivePanelId(sessionId)
  if (activePanelId && activePanelId !== SESSION_ARTIFACT_LIST_PANEL_ID) return false
  dock.parkDock()
  return true
}
