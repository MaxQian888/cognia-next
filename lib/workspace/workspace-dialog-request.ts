/**
 * Ask the always-mounted workspace dialog host to open one of the four
 * workspace editors, from anywhere in the shell.
 *
 * The four dialogs (folder picker, new workspace, adopt, manage roots) are
 * owned by `useWorkspacePickerDialogs`, which returns an element its caller has
 * to mount. Until now the only callers were the rail popover and the mobile
 * drawer, both of which unmount their children on close, which is why that hook
 * insists the element be mounted OUTSIDE the container.
 *
 * The command palette has the same problem in a harder form: it closes itself
 * before running an action, so it cannot mount anything the action opens. A DOM
 * event on `window` is the seam both sides agree on, exactly as
 * `lib/shell/command-palette-request.ts` does for the palette itself. No store,
 * and no import cycle between a provider and the workspace dialogs.
 */

export const WORKSPACE_DIALOG_REQUEST_EVENT = "cognia:workspace-dialog:request"

/**
 * Which editor to open.
 *
 * `openFolder` is the one that is not purely a dialog: on the desktop it is the
 * OS folder chooser, and on a paired client it is the in-app picker that walks
 * the HOST's filesystem. The host component decides which, because that is the
 * decision `WorkspacePickerList` already makes and there must not be a second
 * answer to it.
 */
export type WorkspaceDialogKind = "openFolder" | "newWorkspace" | "adopt" | "manage"

export interface WorkspaceDialogRequestDetail {
  kind: WorkspaceDialogKind
}

export function requestWorkspaceDialog(kind: WorkspaceDialogKind): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<WorkspaceDialogRequestDetail>(WORKSPACE_DIALOG_REQUEST_EVENT, {
      detail: { kind },
    })
  )
}

/** Subscribe the host. Returns the unsubscribe. */
export function onWorkspaceDialogRequest(
  handler: (detail: WorkspaceDialogRequestDetail) => void
): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<WorkspaceDialogRequestDetail>).detail
    if (detail && typeof detail === "object" && detail.kind) handler(detail)
  }
  window.addEventListener(WORKSPACE_DIALOG_REQUEST_EVENT, listener)
  return () => window.removeEventListener(WORKSPACE_DIALOG_REQUEST_EVENT, listener)
}
