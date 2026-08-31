/** @jest-environment jsdom */

import { act, render, screen } from "@testing-library/react"

jest.mock("next/dynamic", () => ({
  __esModule: true,
  // The real `dynamic` defers the import, which is the whole point of the
  // split. For the test the mount is stubbed so this file can assert the
  // listener half without dragging in the picker's module graph.
  default: () => {
    const Stub = ({ request }: { request: { kind: string; seq: number } | null }) => (
      <div data-testid="workspace-dialog-mount">
        {request ? `${request.kind}:${request.seq}` : "none"}
      </div>
    )
    return Stub
  },
}))

import { requestWorkspaceDialog } from "@/lib/workspace/workspace-dialog-request"
import { WorkspaceDialogHost } from "./workspace-dialog-host"

describe("WorkspaceDialogHost", () => {
  /**
   * The editors reach `useAdoptionCandidates`, which calls the host on mount,
   * and this component sits on every route in both shells. Loading them before
   * anybody asks would make every session pay for a dialog most never open.
   */
  it("renders nothing until something asks for an editor", () => {
    const { container } = render(<WorkspaceDialogHost />)
    expect(container).toBeEmptyDOMElement()
  })

  it("mounts the editors on the first request and passes the kind through", () => {
    render(<WorkspaceDialogHost />)
    act(() => requestWorkspaceDialog("adopt"))
    expect(screen.getByTestId("workspace-dialog-mount")).toHaveTextContent("adopt:1")
  })

  /**
   * Asking for the same editor twice has to re-open it, so the request needs an
   * identity that changes even when the kind does not.
   */
  it("gives a repeated request a new identity", () => {
    render(<WorkspaceDialogHost />)
    act(() => requestWorkspaceDialog("manage"))
    act(() => requestWorkspaceDialog("manage"))
    expect(screen.getByTestId("workspace-dialog-mount")).toHaveTextContent("manage:2")
  })
})
