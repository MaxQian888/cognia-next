import { fireEvent, render, screen } from "@testing-library/react"

import { SessionEnvironmentChip } from "./session-environment-chip"

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
})
