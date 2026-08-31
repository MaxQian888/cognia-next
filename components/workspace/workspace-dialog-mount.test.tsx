/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

const actions = {
  openFolder: jest.fn(),
  newWorkspace: jest.fn(),
  adopt: jest.fn(),
  manage: jest.fn(),
  canOpenFolder: true,
  adoptableCount: 0,
}
jest.mock("@/components/workspace/workspace-picker-list", () => ({
  // Rebuilt every render, exactly as the real hook does. That is what makes
  // keying the effect on `actions` wrong.
  useWorkspacePickerDialogs: () => ({
    actions: { ...actions },
    element: <div data-testid="picker-dialogs" />,
  }),
}))

import { WorkspaceDialogMount } from "./workspace-dialog-mount"

describe("WorkspaceDialogMount", () => {
  beforeEach(() => Object.values(actions).forEach((a) => typeof a === "function" && a.mockClear()))

  it("mounts the editors even before a request arrives", () => {
    render(<WorkspaceDialogMount request={null} />)
    expect(screen.getByTestId("picker-dialogs")).toBeInTheDocument()
    expect(actions.newWorkspace).not.toHaveBeenCalled()
  })

  it("opens the editor the request names", () => {
    render(<WorkspaceDialogMount request={{ kind: "adopt", seq: 1 }} />)
    expect(actions.adopt).toHaveBeenCalledTimes(1)
    expect(actions.manage).not.toHaveBeenCalled()
  })

  /**
   * `actions` is a fresh object every render, so an effect keyed on it would
   * re-fire on every keystroke inside the dialog it just opened.
   */
  it("does not re-open on a re-render with the same request", () => {
    const request = { kind: "manage" as const, seq: 4 }
    const { rerender } = render(<WorkspaceDialogMount request={request} />)
    rerender(<WorkspaceDialogMount request={request} />)
    rerender(<WorkspaceDialogMount request={request} />)
    expect(actions.manage).toHaveBeenCalledTimes(1)
  })

  it("re-opens when the same editor is requested again", () => {
    const { rerender } = render(<WorkspaceDialogMount request={{ kind: "manage", seq: 1 }} />)
    rerender(<WorkspaceDialogMount request={{ kind: "manage", seq: 2 }} />)
    expect(actions.manage).toHaveBeenCalledTimes(2)
  })

  /**
   * The folder chooser is the one that differs per client: native dialog on the
   * desktop, host-filesystem picker on a paired phone. The hook makes that
   * call, and this component must not make a second one.
   */
  it("hands the folder chooser to the hook rather than deciding itself", () => {
    render(<WorkspaceDialogMount request={{ kind: "openFolder", seq: 1 }} />)
    expect(actions.openFolder).toHaveBeenCalledTimes(1)
  })
})
