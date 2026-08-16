import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const listAgentThreadSessions = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (query: () => unknown) => {
    query()
    return []
  },
}))
jest.mock("@/lib/db/sessions", () => ({
  listAgentThreadSessions: (...args: unknown[]) => listAgentThreadSessions(...args),
}))
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

const parentWith = (child: unknown) => ({
  session: { id: "parent-1", title: "Parent", kind: "direct" },
  children: [child],
  running: false,
})

beforeEach(() => {
  forest = []
  listAgentThreadSessions.mockReset()
  promoteMock.mockReset()
  setActiveSession.mockReset()
  setActiveProject.mockReset()
  addSessionToProject.mockReset()
  setSelectedGuild.mockReset()
})

it("renders no segment at all while there is nothing to browse", () => {
  // Like the terminal segment: a workspace that never spawned a subagent must
  // not carry a permanent "Threads" control in the status bar.
  const { container } = renderBrowser()
  expect(container).toBeEmptyDOMElement()
  expect(screen.queryByTestId("status-agent-threads")).toBeNull()
})

it("reads through the subagent-scoped query, not the whole sessions table", () => {
  renderBrowser()
  expect(listAgentThreadSessions).toHaveBeenCalled()
})

it("renders as a status-bar segment and opens the global thread browser", () => {
  forest = [
    parentWith({
      session: { id: "child-1", title: "Done child", kind: "subagent" },
      children: [],
      running: false,
    }),
  ]
  renderBrowser()
  const trigger = screen.getByTestId("status-agent-threads")
  // Not the old floating action button: no `fixed` positioning, bar-height row.
  expect(trigger.className).not.toContain("fixed")
  expect(trigger.className).toContain("h-6")
  expect(trigger).toHaveAttribute("data-running", "false")
  expect(trigger).toHaveTextContent("Threads")
  fireEvent.click(screen.getByRole("button", { name: "Browse agent threads" }))
  expect(screen.getByText("Agent threads")).toBeInTheDocument()
  expect(screen.getByText("Done child")).toBeInTheDocument()
})

it("navigates across projects and promotes a completed child as a new task snapshot", async () => {
  const child = {
    session: { id: "child-1", title: "Research child", kind: "subagent", projectId: "project-2" },
    children: [],
    running: false,
  }
  forest = [parentWith(child)]
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

it("badges the running-child count on the segment, shows running state, and blocks promotion", () => {
  forest = [
    parentWith({
      session: { id: "child-1", title: "Running child", kind: "subagent" },
      children: [
        {
          session: { id: "child-2", title: "Nested running", kind: "subagent" },
          children: [],
          running: true,
        },
      ],
      running: true,
    }),
  ]
  renderBrowser()
  const trigger = screen.getByTestId("status-agent-threads")
  expect(trigger).toHaveAttribute("data-running", "true")
  // Two running subagents at different depths — the badge counts the forest.
  expect(trigger).toHaveTextContent("2")
  fireEvent.click(screen.getByRole("button", { name: "Browse agent threads" }))
  expect(screen.getAllByText("Running child")).toHaveLength(3)
  expect(
    screen.getByRole("button", { name: "Promote Running child to a new task snapshot" })
  ).toBeDisabled()
})

it("opens a thread from the dialog and switches guild + session", () => {
  forest = [
    parentWith({
      session: { id: "child-1", title: "Open me", kind: "subagent", projectId: "project-9" },
      children: [],
      running: false,
    }),
  ]
  renderBrowser()
  fireEvent.click(screen.getByRole("button", { name: "Browse agent threads" }))
  fireEvent.click(screen.getByText("Open me"))
  expect(setActiveProject).toHaveBeenCalledWith("project-9")
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
  expect(setActiveSession).toHaveBeenCalledWith("child-1")
})
