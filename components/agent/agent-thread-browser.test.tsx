import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => [] }))
jest.mock("@/lib/db/sessions", () => ({ listSessions: jest.fn() }))
let forest: unknown[] = []
const promoteMock = jest.fn()
jest.mock("@/lib/agent/thread-browser", () => ({
  buildAgentThreadForest: () => forest,
  promoteSubagentSession: (...args: unknown[]) => promoteMock(...args),
}))
const setActiveSession = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ sessions: {} }),
    {
      getState: () => ({ setActiveSession }),
    }
  ),
}))
const setActiveProject = jest.fn()
const addSessionToProject = jest.fn()
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: {
    getState: () => ({ activeProjectId: null, setActiveProject, addSessionToProject }),
  },
}))
const setSelectedGuild = jest.fn()
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: { getState: () => ({ setSelectedGuild }) },
}))

import { AgentThreadBrowser } from "./agent-thread-browser"
import { TooltipProvider } from "@/components/ui/tooltip"

const renderBrowser = () =>
  render(
    <TooltipProvider>
      <AgentThreadBrowser />
    </TooltipProvider>
  )

beforeEach(() => {
  forest = []
  promoteMock.mockReset()
  setActiveSession.mockReset()
  setActiveProject.mockReset()
  addSessionToProject.mockReset()
  setSelectedGuild.mockReset()
})

it("opens the global thread browser and shows its empty state", () => {
  renderBrowser()
  fireEvent.click(screen.getByRole("button", { name: "Browse agent threads" }))
  expect(screen.getByText("Agent threads")).toBeInTheDocument()
  expect(screen.getByText("No agent threads have been created yet.")).toBeInTheDocument()
})

it("navigates across projects and promotes a completed child as a new task snapshot", async () => {
  const child = {
    session: { id: "child-1", title: "Research child", kind: "subagent", projectId: "project-2" },
    children: [],
    running: false,
  }
  forest = [
    {
      session: { id: "parent-1", title: "Parent", kind: "direct" },
      children: [child],
      running: false,
    },
  ]
  promoteMock.mockResolvedValue({
    id: "promoted-1",
    title: "Promoted",
    kind: "direct",
    projectId: "project-2",
  })
  renderBrowser()
  fireEvent.click(screen.getByRole("button", { name: "Browse agent threads" }))
  fireEvent.click(
    screen.getByRole("button", { name: "Promote Research child to a new task snapshot" })
  )
  await waitFor(() => expect(promoteMock).toHaveBeenCalledWith("child-1", false))
  expect(addSessionToProject).toHaveBeenCalledWith("project-2", "promoted-1")
  expect(setActiveProject).toHaveBeenCalledWith("project-2")
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
  expect(setActiveSession).toHaveBeenCalledWith("promoted-1")
})

it("shows running child state and blocks snapshot promotion", () => {
  forest = [
    {
      session: { id: "parent-1", title: "Parent", kind: "direct" },
      children: [
        {
          session: { id: "child-1", title: "Running child", kind: "subagent" },
          children: [],
          running: true,
        },
      ],
      running: false,
    },
  ]
  renderBrowser()
  fireEvent.click(screen.getByRole("button", { name: "Browse agent threads" }))
  expect(screen.getAllByText("Running child")).toHaveLength(2)
  expect(
    screen.getByRole("button", { name: "Promote Running child to a new task snapshot" })
  ).toBeDisabled()
})
