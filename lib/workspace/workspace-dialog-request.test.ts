/** @jest-environment jsdom */

import {
  onWorkspaceDialogRequest,
  requestWorkspaceDialog,
  type WorkspaceDialogKind,
} from "./workspace-dialog-request"

describe("workspace dialog request", () => {
  it("delivers the requested editor to a listener", () => {
    const seen: WorkspaceDialogKind[] = []
    const stop = onWorkspaceDialogRequest(({ kind }) => seen.push(kind))
    requestWorkspaceDialog("newWorkspace")
    requestWorkspaceDialog("manage")
    stop()
    expect(seen).toEqual(["newWorkspace", "manage"])
  })

  it("stops delivering once unsubscribed", () => {
    const seen: WorkspaceDialogKind[] = []
    const stop = onWorkspaceDialogRequest(({ kind }) => seen.push(kind))
    stop()
    requestWorkspaceDialog("adopt")
    expect(seen).toEqual([])
  })

  /**
   * The seam is a bare `window` event, so anything on the page can dispatch it.
   * A malformed detail must not reach a handler that will index into it.
   */
  it("ignores an event carrying no kind", () => {
    const handler = jest.fn()
    const stop = onWorkspaceDialogRequest(handler)
    window.dispatchEvent(new CustomEvent("cognia:workspace-dialog:request", { detail: {} }))
    window.dispatchEvent(new CustomEvent("cognia:workspace-dialog:request"))
    stop()
    expect(handler).not.toHaveBeenCalled()
  })
})
