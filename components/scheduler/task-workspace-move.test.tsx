/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))
const toastError = jest.fn()
const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}))
const hostTargetMock = jest.fn(() => ({ target: "local" as "local" | "paired" }))
jest.mock("@/hooks/scheduler/use-scheduler-host-target", () => ({
  useSchedulerHostTarget: () => hostTargetMock(),
}))
const updateTaskMock = jest.fn(async () => ({}) as unknown)
let executions: { taskId: string; status: string }[] = []
jest.mock("@/stores/scheduler/scheduler-store", () => ({
  useSchedulerStore: (selector: (s: unknown) => unknown) =>
    selector({ updateTask: updateTaskMock, executions }),
}))
jest.mock("@/lib/db/projects", () => ({
  getAllProjects: jest.fn(async () => []),
  loadActiveProjectId: jest.fn(async () => null),
  putProject: jest.fn(async () => undefined),
  deleteProjectRow: jest.fn(async () => undefined),
  persistActiveProjectId: jest.fn(async () => undefined),
}))
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchProjectSwitch: jest.fn() }),
}))

import { TaskWorkspaceMove } from "./task-workspace-move"
import { useProjectStore } from "@/stores/project/project-store"
import type { ScheduledTask } from "@/types/scheduler"

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "Nightly",
    status: "active",
    projectId: "ws_a",
    ...over,
  } as ScheduledTask
}

function seedProjects() {
  act(() => {
    useProjectStore.setState({
      projects: [
        { id: "ws_a", name: "Backend" },
        { id: "ws_b", name: "Docs" },
        { id: "ws_old", name: "Archived", isArchived: true },
      ] as never,
      activeProjectId: "ws_a",
      loaded: true,
    })
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  executions = []
  hostTargetMock.mockReturnValue({ target: "local" })
  seedProjects()
})

describe("TaskWorkspaceMove", () => {
  it("renders the binding a schedule already has", () => {
    render(<TaskWorkspaceMove task={task()} />)
    expect(screen.getByTestId("task-workspace-move")).toHaveTextContent("Backend")
  })

  it("writes the new binding through the update path that now accepts it", async () => {
    render(<TaskWorkspaceMove task={task()} />)

    fireEvent.click(screen.getByRole("combobox"))
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Docs" }))
    })

    expect(updateTaskMock).toHaveBeenCalledWith("t1", { projectId: "ws_b" })
  })

  it("can un-bind a schedule so it belongs to every workspace again", async () => {
    // Radix refuses "" as an item value, so this is a real option rather than
    // the absence of one.
    render(<TaskWorkspaceMove task={task()} />)

    fireEvent.click(screen.getByRole("combobox"))
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "unbound" }))
    })

    expect(updateTaskMock).toHaveBeenCalledWith("t1", { projectId: null })
  })

  it("names a workspace that no longer exists instead of rendering an empty trigger", () => {
    // Radix blanks the trigger for a value with no matching item, which would
    // make a dangling binding indistinguishable from an unbound one.
    render(<TaskWorkspaceMove task={task({ projectId: "ws_deleted" })} />)

    expect(screen.getByTestId("task-workspace-move")).toHaveTextContent(
      "missingWorkspace:ws_deleted"
    )
  })

  it("shows the binding but refuses to change it on a paired host", () => {
    // Workspace ids are local, so one picked here names nothing over there.
    hostTargetMock.mockReturnValue({ target: "paired" })
    render(<TaskWorkspaceMove task={task()} />)

    expect(screen.getByRole("combobox")).toBeDisabled()
    // The value must still be visible: hiding the control would remove the
    // only place the binding can be read.
    expect(screen.getByTestId("task-workspace-move")).toHaveTextContent("Backend")
    expect(screen.getByTestId("task-workspace-move")).toHaveTextContent("refused.remote-host")
  })

  it("refuses while an execution of this task is in flight", () => {
    executions = [{ taskId: "t1", status: "running" }]
    render(<TaskWorkspaceMove task={task()} />)

    expect(screen.getByRole("combobox")).toBeDisabled()
    expect(screen.getByTestId("task-workspace-move")).toHaveTextContent("refused.task-running")
  })

  it("ignores another task's running execution", () => {
    executions = [{ taskId: "t2", status: "running" }]
    render(<TaskWorkspaceMove task={task()} />)

    expect(screen.getByRole("combobox")).not.toBeDisabled()
  })

  it("does not offer archived workspaces as destinations", async () => {
    render(<TaskWorkspaceMove task={task()} />)
    fireEvent.click(screen.getByRole("combobox"))

    expect(screen.queryByRole("option", { name: "Archived" })).not.toBeInTheDocument()
  })
})
