/**
 * The Context Workbench scope key standing in for "this conversation" inside
 * the chat right rail, and the id of the panel that opens on it by default.
 *
 * Built in one pure place because more than one module needs the identical
 * string: the dock's session surface uses it as its own layout scope, the
 * artifact surface hands it to the workbench so `scope: "session"` panels
 * record their activation against the conversation, and the session-focus
 * seam reads the layout under it to decide whether an idle dock should park.
 * Kept free of React so that seam (a store subscriber) can import it.
 */

/** The dock's own workbench host key — pairs with `useContextWorkbenchInstanceId`. */
export const ARTIFACT_DOCK_WORKBENCH_HOST_KEY = "artifact"

/**
 * The session surface's artifact-list panel — the one a conversation with no
 * artifacts shows as "No artifacts yet". Both dock surfaces register the list
 * under this id.
 */
export const SESSION_ARTIFACT_LIST_PANEL_ID = "artifacts"

/**
 * The desktop dock's start page (ADR-0214, D7) — what a conversation with
 * nothing recorded opens on, in place of the empty artifact list.
 */
export const NEW_TAB_PANEL_ID = "new-tab"

export function sessionWorkbenchScopeKey(
  workbenchInstanceId: string,
  activeSessionId: string | null
): string {
  return `${workbenchInstanceId}::session:${activeSessionId ?? "none"}`
}
