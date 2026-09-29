/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import type { ProjectThreadRow } from "@/hooks/project-coordinator/use-project-threads"

let rows: ProjectThreadRow[] | undefined
jest.mock("@/hooks/project-coordinator/use-project-threads", () => ({
  useProjectThreads: jest.fn(() => []),
  useThreadPrStatuses: jest.fn(() => new Map()),
  useProjectThreadRows: () => rows,
}))
jest.mock("./thread-row", () => ({
  ProjectThreadRow: ({ row }: { row: ProjectThreadRow }) => (
    <span data-testid={`row-${row.thread.id}`}>{row.thread.title}</span>
  ),
}))

import { useProjectThreads } from "@/hooks/project-coordinator/use-project-threads"
import { ProjectThreadsBoard } from "./project-threads-board"

const row = (id: string, state: ProjectThreadRow["state"]): ProjectThreadRow => ({
  thread: { id, title: `Task ${id}`, createdAt: 1, updatedAt: 1 } as ChatSession,
  status: "idle",
  pendingApprovals: 0,
  state,
})

describe("ProjectThreadsBoard", () => {
  it("loads the coordinator's threads and shows a loading state", () => {
    rows = undefined
    render(<ProjectThreadsBoard projectId="p1" coordinatorSessionId="coord" />)
    expect(useProjectThreads).toHaveBeenCalledWith("coord")
    expect(screen.getByRole("status", { name: "Loading threads" })).toBeInTheDocument()
  })

  it("says when there are no threads", () => {
    rows = []
    render(<ProjectThreadsBoard projectId="p1" coordinatorSessionId="coord" />)
    expect(screen.getByTestId("project-threads-empty")).toBeInTheDocument()
  })

  it("groups open threads by state and folds resolved ones away", () => {
    rows = [row("a", "waiting"), row("b", "working"), row("c", "waiting"), row("d", "resolved")]
    render(<ProjectThreadsBoard projectId="p1" coordinatorSessionId="coord" />)
    const waiting = screen.getByTestId("project-threads-group-waiting")
    expect(waiting.textContent).toContain("Task a")
    expect(waiting.textContent).toContain("Task c")
    expect(screen.getByTestId("project-threads-group-working").textContent).toContain("Task b")
    expect(screen.queryByTestId("row-d")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Resolved (1)" }))
    expect(screen.getByTestId("row-d")).toBeInTheDocument()
  })
})
