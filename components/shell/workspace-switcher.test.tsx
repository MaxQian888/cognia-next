/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@tauri-apps/plugin-dialog", () => ({ open: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/logging", () => ({
  loggers: { shell: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}))
jest.mock("@/lib/db/projects", () => ({
  getAllProjects: jest.fn(async () => []),
  loadActiveProjectId: jest.fn(async () => null),
  putProject: jest.fn(async () => undefined),
  deleteProjectRow: jest.fn(async () => undefined),
  persistActiveProjectId: jest.fn(async () => undefined),
}))
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchProjectCreate: jest.fn(async () => undefined),
    dispatchProjectUpdate: jest.fn(async () => undefined),
    dispatchProjectDelete: jest.fn(async () => undefined),
    dispatchProjectSwitch: jest.fn(),
    dispatchKnowledgeFileAdd: jest.fn(async () => undefined),
    dispatchKnowledgeFileRemove: jest.fn(),
    dispatchSessionLinked: jest.fn(),
    dispatchSessionUnlinked: jest.fn(),
  }),
}))

import { WorkspaceSwitcher } from "./workspace-switcher"
import { useProjectStore } from "@/stores/project/project-store"

function makeProject(id: string, over: Record<string, unknown> = {}) {
  const now = new Date()
  return {
    id,
    name: id,
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    ...over,
  } as never
}

beforeEach(() => {
  act(() => {
    useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  })
})

function renderSwitcher() {
  return render(
    <TooltipProvider>
      <WorkspaceSwitcher />
    </TooltipProvider>
  )
}

describe("WorkspaceSwitcher", () => {
  it("labels the trigger 'none' with a folder icon when no workspace is active", () => {
    renderSwitcher()
    expect(screen.getByTestId("workspace-switcher")).toHaveAttribute("aria-label", "none")
  })

  it("shows the active workspace initial and 'active' label", () => {
    act(() => {
      useProjectStore.setState({
        projects: [makeProject("p1", { name: "Backend", rootDir: "/srv" })],
        activeProjectId: "p1",
      })
    })
    renderSwitcher()
    const trigger = screen.getByTestId("workspace-switcher")
    expect(trigger).toHaveAttribute("aria-label", "active")
    expect(trigger).toHaveTextContent("B")
  })

  it("lists workspaces and switches the active one on click", () => {
    act(() => {
      useProjectStore.setState({
        projects: [
          makeProject("p1", { name: "Alpha", rootDir: "/a" }),
          makeProject("p2", { name: "Beta", rootDir: "/b" }),
        ],
        activeProjectId: "p1",
      })
    })
    renderSwitcher()
    fireEvent.click(screen.getByTestId("workspace-switcher"))
    fireEvent.click(screen.getByTestId("workspace-switch-p2"))
    expect(useProjectStore.getState().activeProjectId).toBe("p2")
  })

  it("shows the empty state when there are no workspaces", () => {
    renderSwitcher()
    fireEvent.click(screen.getByTestId("workspace-switcher"))
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("opens the manage dialog (browse) without creating anything", () => {
    renderSwitcher()
    fireEvent.click(screen.getByTestId("workspace-switcher"))
    fireEvent.click(screen.getByTestId("workspace-switcher-manage"))
    // The manage dialog mounts its own "New" affordance.
    expect(screen.getByTestId("workspace-new")).toBeInTheDocument()
    expect(useProjectStore.getState().projects).toHaveLength(0)
  })

  it("'New workspace' creates a workspace and jumps into the editor", () => {
    renderSwitcher()
    fireEvent.click(screen.getByTestId("workspace-switcher"))
    fireEvent.click(screen.getByTestId("workspace-switcher-new"))
    expect(useProjectStore.getState().projects).toHaveLength(1)
    // Editor for the new workspace is shown.
    expect(screen.getByLabelText("nameLabel")).toBeInTheDocument()
  })
})
