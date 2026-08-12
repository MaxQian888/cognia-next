import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const gitStatusMock = jest.fn()
jest.mock("@/lib/git/commands", () => ({
  gitStatus: (...args: unknown[]) => gitStatusMock(...args),
}))
const handoffManagedMock = jest.fn()
const handoffLocalMock = jest.fn()
jest.mock("@/lib/task-workspace/handoff", () => ({
  handoffSessionToManaged: (...args: unknown[]) => handoffManagedMock(...args),
  handoffSessionToLocal: (...args: unknown[]) => handoffLocalMock(...args),
  pinSessionWorktree: jest.fn(),
  pruneSessionWorktree: jest.fn(),
  resolveSessionHandoffConflict: jest.fn(),
  restoreSessionSnapshot: jest.fn(),
  undoSessionHandoff: jest.fn(),
}))
const listRunsMock = jest.fn()
const getPatchMock = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  listTaskRuns: (...args: unknown[]) => listRunsMock(...args),
  getTaskPatchSet: (...args: unknown[]) => getPatchMock(...args),
}))
const materializeManagedMock = jest.fn()
const deleteManagedMock = jest.fn()
jest.mock("@/lib/task-workspace/managed-workspace", () => ({
  materializeManagedWorkspace: (...args: unknown[]) => materializeManagedMock(...args),
  rebindManagedWorkspace: jest.fn(),
  createManagedWorkspaceArchive: jest.fn(),
  importManagedWorkspaceArchive: jest.fn(),
  convertManagedWorkspaceToProject: jest.fn(),
  deleteManagedWorkspace: (...args: unknown[]) => deleteManagedMock(...args),
  restoreManagedWorkspace: jest.fn(),
}))
jest.mock("@/lib/files/save-export", () => ({ saveExport: jest.fn() }))

import { SessionExecutionWorkspace } from "./session-execution-workspace"
import type { ChatSession } from "@cognia/agent-config-types"

const session: ChatSession = {
  id: "session-1",
  title: "Task",
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

beforeEach(() => {
  gitStatusMock.mockReset().mockResolvedValue({
    staged: [{ path: "staged.ts" }],
    changes: [{ path: "local.ts" }],
    merge: [],
  })
  handoffManagedMock.mockReset().mockResolvedValue({
    location: "managedWorktree",
    projectId: "project-1",
    projectRoot: "/repo",
    taskWorkspace: { taskId: "task-1", workspaceKey: "session-1" },
    lifecycle: { state: "requested", createdAt: 1, updatedAt: 1, pinned: false },
  })
  handoffLocalMock.mockReset().mockResolvedValue({ state: "applied", conflicts: [] })
  listRunsMock.mockReset().mockResolvedValue([])
  getPatchMock.mockReset().mockResolvedValue(null)
  materializeManagedMock.mockReset().mockResolvedValue({
    location: "managedWorktree",
    workspaceBinding: { kind: "managed", workspaceId: "managed-workspace:session-1" },
    managedWorkspace: { availability: "available", localRoot: "/managed/session-1" },
    projectId: "",
    projectRoot: "/managed/session-1",
    taskWorkspace: {
      taskId: "task-workspace:session-1",
      workspaceKey: "managed-workspace:session-1",
    },
  })
  deleteManagedMock.mockReset().mockResolvedValue({
    location: "managedWorktree",
    workspaceBinding: { kind: "managed", workspaceId: "managed-workspace:session-1" },
    managedWorkspace: { availability: "deleted", deletedRoot: "/trash/session-1" },
    projectId: "",
    projectRoot: "",
    taskWorkspace: {
      taskId: "task-workspace:session-1",
      workspaceKey: "managed-workspace:session-1",
    },
  })
})

it("previews dirty local files before binding the task to a managed Worktree", async () => {
  render(<SessionExecutionWorkspace session={session} projectId="project-1" projectRoot="/repo" />)
  fireEvent.click(screen.getByRole("button", { name: "Move to Worktree" }))
  expect(await screen.findByText("staged.ts")).toBeInTheDocument()
  expect(screen.getByText("local.ts")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Continue" }))
  await waitFor(() =>
    expect(handoffManagedMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", projectRoot: "/repo" })
    )
  )
  expect(await screen.findByText("Managed Worktree")).toBeInTheDocument()
})

it("fails over to a non-Git shadow workspace after an explicit preview", async () => {
  gitStatusMock.mockRejectedValueOnce(new Error("not a repository"))
  render(<SessionExecutionWorkspace session={session} projectId="project-1" projectRoot="/plain" />)
  fireEvent.click(screen.getByRole("button", { name: "Move to Worktree" }))
  expect(await screen.findByText(/not a Git repository/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Continue" }))
  await waitFor(() =>
    expect(handoffManagedMock).toHaveBeenCalledWith(
      expect.objectContaining({ isGitRepository: false })
    )
  )
})

it("offers explicit materialization when a synced managed workspace is missing", async () => {
  render(
    <SessionExecutionWorkspace
      session={
        {
          ...session,
          executionContext: {
            location: "managedWorktree",
            workspaceBinding: {
              kind: "managed",
              workspaceId: "managed-workspace:session-1",
            },
            managedWorkspace: { availability: "missing-on-device" },
            projectId: "",
            projectRoot: "",
            taskWorkspace: {
              taskId: "task-workspace:session-1",
              workspaceKey: "managed-workspace:session-1",
            },
          },
        } as never
      }
    />
  )

  expect(
    screen.getByText("Missing on this device — rebind or import to continue.")
  ).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Create on this device" }))
  await waitFor(() => expect(materializeManagedMock).toHaveBeenCalledWith("session-1"))
  expect(await screen.findByText("Available on this device")).toBeInTheDocument()
})

it("keeps managed workspace deletion separate and explicitly confirmed", async () => {
  render(
    <SessionExecutionWorkspace
      session={
        {
          ...session,
          executionContext: {
            location: "managedWorktree",
            workspaceBinding: {
              kind: "managed",
              workspaceId: "managed-workspace:session-1",
            },
            managedWorkspace: { availability: "available", localRoot: "/managed/session-1" },
            projectId: "",
            projectRoot: "/managed/session-1",
            taskWorkspace: {
              taskId: "task-workspace:session-1",
              workspaceKey: "managed-workspace:session-1",
            },
          },
        } as never
      }
    />
  )

  fireEvent.click(screen.getByRole("button", { name: "Delete workspace files" }))
  expect(deleteManagedMock).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Delete files" }))
  await waitFor(() => expect(deleteManagedMock).toHaveBeenCalledWith("session-1"))
  expect(await screen.findByText("Deleted locally and available for recovery.")).toBeInTheDocument()
})
