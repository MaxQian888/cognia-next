import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChatSession, Project } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
const updateSession = jest.fn(async () => undefined)
jest.mock("@/lib/db/sessions", () => ({ updateSession: (...a: unknown[]) => updateSession(...a) }))
const toastError = jest.fn()
const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}))

import { useProjectStore } from "@/stores/project/project-store"
import { getExecutionBroker } from "@/lib/execution/broker"
import { SessionWorkspaceMove } from "./session-workspace-move"

const session = {
  id: "s1",
  projectId: "project-a",
  executionContext: {
    location: "local",
    projectId: "project-a",
    projectRoot: "/repos/a",
    taskWorkspace: { taskId: "t", workspaceKey: "w" },
  },
} as unknown as ChatSession

function seed(running = false) {
  jest.spyOn(getExecutionBroker(), "hasActiveSession").mockReturnValue(running)
  useProjectStore.setState({
    loaded: true,
    activeProjectId: "project-a",
    projects: [
      {
        id: "project-a",
        name: "Alpha",
        roots: [{ id: "ra", path: "/repos/a", isPrimary: true }],
        sessionIds: ["s1"],
      },
      {
        id: "project-b",
        name: "Beta",
        roots: [{ id: "rb", path: "/repos/b", isPrimary: true }],
        sessionIds: [],
      },
    ] as unknown as Project[],
  })
}

beforeEach(() => {
  updateSession.mockClear()
  toastError.mockClear()
  toastSuccess.mockClear()
})

describe("SessionWorkspaceMove", () => {
  it("rebinds the conversation and both workspace links", async () => {
    seed()
    render(<SessionWorkspaceMove session={session} />)

    fireEvent.click(screen.getByLabelText("label"))
    fireEvent.click(await screen.findByText("Beta"))

    await waitFor(() => expect(updateSession).toHaveBeenCalled())
    const [, patch] = updateSession.mock.calls[0] as [
      string,
      { projectId: string; executionContext: { projectRoot: string } },
    ]
    expect(patch.projectId).toBe("project-b")
    // Attribution alone would leave it running in the old project's directory.
    expect(patch.executionContext.projectRoot).toBe("/repos/b")

    // Both halves of the reverse link move, so neither workspace's session
    // list disagrees with the row.
    await waitFor(() => {
      const byId = Object.fromEntries(
        useProjectStore.getState().projects.map((project) => [project.id, project.sessionIds])
      )
      expect(byId["project-a"]).not.toContain("s1")
      expect(byId["project-b"]).toContain("s1")
    })
  })

  it("refuses while a turn is in flight and writes nothing", async () => {
    seed(true)
    render(<SessionWorkspaceMove session={session} />)
    fireEvent.click(screen.getByLabelText("label"))
    fireEvent.click(await screen.findByText("Beta"))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("refused.session-running"))
    expect(updateSession).not.toHaveBeenCalled()
  })

  it("stays out of the way when there is nowhere to move to", () => {
    useProjectStore.setState({
      loaded: true,
      activeProjectId: "project-a",
      projects: [
        { id: "project-a", name: "Alpha", roots: [], sessionIds: ["s1"] },
      ] as unknown as Project[],
    })
    render(<SessionWorkspaceMove session={session} />)
    expect(screen.queryByTestId("session-workspace-move")).not.toBeInTheDocument()
  })
})
