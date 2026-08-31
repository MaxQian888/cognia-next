import { fireEvent, render, screen } from "@testing-library/react"

// Whether the device can hover decides the whole disclosure. Stated per test
// rather than inherited from jsdom's ambient `matchMedia`, which reports no
// hover and so silently exercised only the touch branch.
const hasHoverMock = jest.fn(() => true)
jest.mock("@/hooks/ui/use-pointer", () => ({
  useHasHover: () => hasHoverMock(),
  useCoarsePointer: () => false,
}))

import { SessionEnvironmentChip } from "./session-environment-chip"

beforeEach(() => {
  hasHoverMock.mockReturnValue(true)
})

describe("SessionEnvironmentChip", () => {
  it("shows the managed root and base, then opens environment management", async () => {
    const onManage = jest.fn()
    render(
      <SessionEnvironmentChip
        executionContext={{
          location: "managedWorktree",
          projectId: "project-1",
          projectRoot: "/repo",
          branch: "feature/workspace",
          execution: {
            mode: "managed",
            base: { kind: "remoteDefault" },
            roots: [
              {
                logicalRootId: "root-1",
                role: "primary",
                aliasPath: "/tmp/cognia/workspace-1",
              },
            ],
          },
          taskWorkspace: { taskId: "task-1", workspaceKey: "workspace-1" },
          lifecycle: { state: "active", createdAt: 1, updatedAt: 2, pinned: false },
        }}
        onManage={onManage}
      />
    )

    fireEvent.focus(screen.getByLabelText("Worktree execution environment"))
    expect(await screen.findByText("/tmp/cognia/workspace-1")).toBeInTheDocument()
    expect(screen.getByText("Remote default")).toBeInTheDocument()
    expect(screen.getByText("feature/workspace")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Manage environment" }))
    expect(onManage).toHaveBeenCalledTimes(1)
  })

  it("surfaces a conflict state in the persistent chip", () => {
    render(
      <SessionEnvironmentChip
        executionContext={{
          location: "managedWorktree",
          projectId: "project-1",
          projectRoot: "/repo",
          taskWorkspace: { taskId: "task-1", workspaceKey: "workspace-1" },
          lifecycle: { state: "conflict", createdAt: 1, updatedAt: 2, pinned: false },
        }}
        onManage={jest.fn()}
      />
    )

    expect(screen.getByLabelText("Worktree execution environment")).toHaveClass("text-destructive")
  })
  it("never names the source checkout for a managed workspace that is not on this device", async () => {
    // `worktreePath` is a legacy mirror the bundle path no longer writes, and
    // `projectRoot` is stripped from managed sync rows — reading either made
    // the chip name a directory this device does not have.
    render(
      <SessionEnvironmentChip
        executionContext={{
          location: "managedWorktree",
          workspaceBinding: { kind: "managed", workspaceId: "workspace-9" },
          managedWorkspace: { availability: "missing-on-device" },
          projectId: "project-1",
          projectRoot: "/repo",
          worktreePath: "/stale/worktree",
          taskWorkspace: { taskId: "task-1", workspaceKey: "workspace-9" },
        }}
        onManage={jest.fn()}
      />
    )

    fireEvent.focus(screen.getByLabelText("Worktree execution environment"))
    expect(screen.queryByText("/stale/worktree")).not.toBeInTheDocument()
    expect(screen.queryByText("/repo")).not.toBeInTheDocument()
  })

  it("prefers the leased alias over the legacy worktreePath mirror", async () => {
    render(
      <SessionEnvironmentChip
        executionContext={{
          location: "managedWorktree",
          projectId: "project-1",
          projectRoot: "/repo",
          worktreePath: "/stale/worktree",
          execution: {
            mode: "managed",
            base: { kind: "workingState" },
            roots: [{ logicalRootId: "root-1", role: "primary", aliasPath: "/bundles/alias" }],
          },
          taskWorkspace: { taskId: "task-1", workspaceKey: "workspace-1" },
        }}
        onManage={jest.fn()}
      />
    )

    fireEvent.focus(screen.getByLabelText("Worktree execution environment"))
    expect(await screen.findByText("/bundles/alias")).toBeInTheDocument()
    expect(screen.queryByText("/stale/worktree")).not.toBeInTheDocument()
  })

  it("opens on a tap where there is no hover", async () => {
    // The mobile shell renders this chip through the shared ChatHeader, and it
    // was a HoverCard alone. On a phone the panel naming the branch, base and
    // lifecycle state was unreachable, and so was the Manage button that is the
    // only route from here to changing any of it.
    hasHoverMock.mockReturnValue(false)
    const onManage = jest.fn()
    render(
      <SessionEnvironmentChip
        executionContext={{
          location: "managedWorktree",
          projectId: "project-1",
          projectRoot: "/repo",
          branch: "feature/touch",
          execution: {
            mode: "managed",
            base: { kind: "remoteDefault" },
            roots: [
              { logicalRootId: "root-1", role: "primary", aliasPath: "/tmp/cognia/ws-touch" },
            ],
          },
          taskWorkspace: { taskId: "task-1", workspaceKey: "ws-touch" },
          lifecycle: { state: "active", createdAt: 1, updatedAt: 2, pinned: false },
        }}
        onManage={onManage}
      />
    )

    // A focus alone must not be enough here: that is the hover affordance.
    const trigger = screen.getByTestId("session-environment-chip")
    fireEvent.click(trigger)

    expect(await screen.findByText("/tmp/cognia/ws-touch")).toBeInTheDocument()
    expect(screen.getByText("feature/touch")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Manage environment" }))
    expect(onManage).toHaveBeenCalledTimes(1)
  })

  it("is a real button, so it is reachable by keyboard on either device", () => {
    render(
      <SessionEnvironmentChip
        executionContext={{ location: "local", projectId: "p", projectRoot: "/repo" }}
        onManage={jest.fn()}
      />
    )

    expect(screen.getByTestId("session-environment-chip").tagName).toBe("BUTTON")
  })
})
