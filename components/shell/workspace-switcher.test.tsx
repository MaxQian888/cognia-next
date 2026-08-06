/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))
const openDialogMock = jest.fn()
jest.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openDialogMock(...a) }))
jest.mock("@/lib/db/trusted-workspaces", () => ({
  isWorkspaceTrusted: jest.fn(async () => true),
  trustWorkspace: jest.fn(async () => undefined),
  revokeWorkspaceTrust: jest.fn(async () => undefined),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@cognia/logging", () => ({
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
  const rootDir = (over.rootDir as string) ?? undefined
  return {
    id,
    name: id,
    roots: rootDir ? [{ id: `root-${id}`, path: rootDir, isPrimary: true }] : [],
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
  isTauriMock.mockReturnValue(true)
  openDialogMock.mockReset()
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

  it("shows the folder count for a multi-root workspace", () => {
    act(() => {
      useProjectStore.setState({
        projects: [
          makeProject("p1", {
            name: "Multi",
            roots: [
              { id: "r1", path: "/a", isPrimary: true },
              { id: "r2", path: "/b" },
            ],
          }),
        ],
        activeProjectId: "p1",
      })
    })
    renderSwitcher()
    fireEvent.click(screen.getByTestId("workspace-switcher"))
    // ICU folderCount key passthrough renders the raw key; assert the path shows.
    expect(screen.getAllByText("/a").length).toBeGreaterThan(0)
  })

  // Seed 8+ workspaces so the switcher crosses the "large" threshold that
  // enables the search field and the pinned Recent group.
  function seedManyProjects() {
    const projects = Array.from({ length: 9 }, (_, i) =>
      makeProject(`p${i}`, {
        name: `Workspace ${i}`,
        rootDir: `/repos/ws-${i}`,
        // p8 newest … p0 oldest, so the Recent group pins p8/p7/p6.
        lastAccessedAt: new Date(2020, 0, 1 + i),
      })
    )
    act(() => {
      useProjectStore.setState({ projects, activeProjectId: "p0" })
    })
  }

  it("pins a Recent group (newest first) once the list is large", () => {
    seedManyProjects()
    renderSwitcher()
    fireEvent.click(screen.getByTestId("workspace-switcher"))
    // The recent group renders prefixed rows; the newest workspace is pinned.
    expect(screen.getByTestId("workspace-switch-recent-p8")).toBeInTheDocument()
    // …and the full alphabetical list still carries the un-prefixed row.
    expect(screen.getByTestId("workspace-switch-p8")).toBeInTheDocument()
  })

  it("pins and unpins a workspace in an explicit persisted group", () => {
    act(() => {
      useProjectStore.setState({
        projects: [makeProject("p1", { name: "Alpha", rootDir: "/a" })],
        activeProjectId: "p1",
        loaded: true,
      })
    })
    renderSwitcher()
    fireEvent.click(screen.getByTestId("workspace-switcher"))
    fireEvent.click(screen.getByTestId("workspace-pin-p1"))
    expect(useProjectStore.getState().projects[0].pinned).toBe(true)
    expect(screen.getByTestId("workspace-switch-pinned-p1")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workspace-pin-pinned-p1"))
    expect(useProjectStore.getState().projects[0].pinned).toBe(false)
  })

  it("hides the search field and Recent group for a small workspace count", () => {
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
    expect(screen.queryByTestId("workspace-switcher-search")).not.toBeInTheDocument()
    expect(screen.queryByTestId("workspace-switch-recent-p1")).not.toBeInTheDocument()
  })

  it("filters the list by name via the search field", () => {
    seedManyProjects()
    renderSwitcher()
    fireEvent.click(screen.getByTestId("workspace-switcher"))
    fireEvent.change(screen.getByTestId("workspace-switcher-search"), {
      target: { value: "Workspace 3" },
    })
    expect(screen.getByTestId("workspace-switch-p3")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-switch-p4")).not.toBeInTheDocument()
    // The Recent group collapses while filtering.
    expect(screen.queryByTestId("workspace-switch-recent-p8")).not.toBeInTheDocument()
  })

  it("filters the list by folder path", () => {
    seedManyProjects()
    renderSwitcher()
    fireEvent.click(screen.getByTestId("workspace-switcher"))
    fireEvent.change(screen.getByTestId("workspace-switcher-search"), {
      target: { value: "/repos/ws-5" },
    })
    expect(screen.getByTestId("workspace-switch-p5")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-switch-p1")).not.toBeInTheDocument()
  })

  it("shows a no-matches state and clears it via the clear button", () => {
    seedManyProjects()
    renderSwitcher()
    fireEvent.click(screen.getByTestId("workspace-switcher"))
    fireEvent.change(screen.getByTestId("workspace-switcher-search"), {
      target: { value: "zzz-nothing" },
    })
    expect(screen.getByText("noMatches")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workspace-switcher-search-clear"))
    expect(screen.queryByText("noMatches")).not.toBeInTheDocument()
    expect(screen.getByTestId("workspace-switch-p1")).toBeInTheDocument()
  })

  it("open-folder creates + activates a workspace on desktop", async () => {
    openDialogMock.mockResolvedValue("/picked/ws")
    renderSwitcher()
    fireEvent.click(screen.getByTestId("workspace-switcher"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("workspace-switcher-open-folder"))
    })
    const projects = useProjectStore.getState().projects
    expect(projects).toHaveLength(1)
    expect(projects[0].rootDir).toBe("/picked/ws")
    expect(useProjectStore.getState().activeProjectId).toBe(projects[0].id)
  })

  it("hides the open-folder action on web", () => {
    isTauriMock.mockReturnValue(false)
    renderSwitcher()
    fireEvent.click(screen.getByTestId("workspace-switcher"))
    expect(screen.queryByTestId("workspace-switcher-open-folder")).not.toBeInTheDocument()
  })
})
