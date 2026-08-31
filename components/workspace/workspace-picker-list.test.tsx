/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
const isTauriMock = jest.requireMock("@/lib/tauri").isTauri as jest.Mock
jest.mock("@/lib/db/trusted-workspaces", () => ({
  isWorkspaceTrusted: jest.fn(async () => true),
}))
const openFolderAsWorkspaceMock = jest.fn()
jest.mock("@/lib/workspace/open-folder", () => ({
  openFolderAsWorkspace: (...a: unknown[]) => openFolderAsWorkspaceMock(...a),
  openPathAsWorkspace: jest.fn(),
}))
const adoptionMock = jest.fn(() => ({ candidates: [] as unknown[] }))
jest.mock("@/hooks/workspace/use-adoption-candidates", () => ({
  useAdoptionCandidates: () => adoptionMock(),
}))
const gateMock = jest.fn(() => ({ available: true, reason: null as string | null }))
jest.mock("@/hooks/workspace/use-workspace-command-gate", () => ({
  useWorkspaceCommandGate: () => gateMock,
}))
jest.mock("@/components/shell/workspace-folder-picker", () => ({
  WorkspaceFolderPicker: (p: { open: boolean }) =>
    p.open ? <div data-testid="remote-folder-picker" /> : null,
}))
jest.mock("@/components/shell/workspace-manage-dialog", () => ({
  WorkspaceManageDialog: (p: { open: boolean }) =>
    p.open ? <div data-testid="manage-dialog" /> : null,
}))
jest.mock("@/components/workspace/new-workspace-dialog", () => ({
  NewWorkspaceDialog: (p: { open: boolean }) => (p.open ? <div data-testid="new-dialog" /> : null),
}))
jest.mock("@/components/workspace/adopt-workspaces-dialog", () => ({
  AdoptWorkspacesDialog: (p: { open: boolean }) =>
    p.open ? <div data-testid="adopt-dialog" /> : null,
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
    dispatchProjectSwitch: jest.fn(),
    dispatchProjectUpdate: jest.fn(async () => undefined),
  }),
}))

import { useWorkspacePickerDialogs, WorkspacePickerList } from "./workspace-picker-list"
import { useProjectStore } from "@/stores/project/project-store"

/** Mounts the list exactly the way both real callers do. */
function Harness({ onSwitched }: { onSwitched?: () => void } = {}) {
  const { actions, element } = useWorkspacePickerDialogs()
  return (
    <>
      <WorkspacePickerList actions={actions} onSwitched={onSwitched} />
      {element}
    </>
  )
}

function seed(count: number) {
  act(() => {
    useProjectStore.setState({
      projects: Array.from({ length: count }, (_, i) => ({
        id: `p${i}`,
        name: `Workspace ${i}`,
        roots: [{ id: `r${i}`, path: `/repos/w${i}`, isPrimary: true }],
        lastAccessedAt: new Date(2020, 0, i + 1),
        updatedAt: new Date(2020, 0, i + 1),
      })) as never,
      activeProjectId: "p0",
      loaded: true,
    })
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  gateMock.mockReturnValue({ available: true, reason: null })
  adoptionMock.mockReturnValue({ candidates: [] })
  act(() => {
    useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  })
})

describe("WorkspacePickerList", () => {
  it("switches the active workspace and tells the container to close", () => {
    seed(2)
    const onSwitched = jest.fn()
    render(<Harness onSwitched={onSwitched} />)

    fireEvent.click(screen.getByTestId("workspace-switch-p1"))

    expect(useProjectStore.getState().activeProjectId).toBe("p1")
    expect(onSwitched).toHaveBeenCalled()
  })

  it("only offers search and Recent once the flat list stops being scannable", () => {
    seed(3)
    const { unmount } = render(<Harness />)
    expect(screen.queryByTestId("workspace-switcher-search")).not.toBeInTheDocument()
    unmount()

    seed(9)
    render(<Harness />)
    expect(screen.getByTestId("workspace-switcher-search")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-switch-recent-p8")).toBeInTheDocument()
  })

  it("hides the adopt entry when there is nothing to adopt", () => {
    // A permanent "Detected folders (0)" row trains the user to ignore the one
    // time it matters, so the count is the whole affordance.
    seed(1)
    render(<Harness />)
    expect(screen.queryByTestId("workspace-switcher-adopt")).not.toBeInTheDocument()

    adoptionMock.mockReturnValue({ candidates: [{ path: "/repos/x" }] })
    render(<Harness />)
    expect(screen.getAllByTestId("workspace-switcher-adopt")[0]).toHaveTextContent("1")
  })

  it("closes the container before opening a dialog", () => {
    // A Drawer unmounts its children, so a dialog opened first would be torn
    // down by the close that follows it.
    seed(1)
    const order: string[] = []
    render(<Harness onSwitched={() => order.push("closed")} />)

    fireEvent.click(screen.getByTestId("workspace-switcher-new"))

    expect(order).toEqual(["closed"])
    expect(screen.getByTestId("new-dialog")).toBeInTheDocument()
  })

  it("uses the native dialog on the desktop and the host browser on a companion", () => {
    seed(1)
    const { unmount } = render(<Harness />)
    fireEvent.click(screen.getByTestId("workspace-switcher-open-folder"))
    expect(openFolderAsWorkspaceMock).toHaveBeenCalled()
    expect(screen.queryByTestId("remote-folder-picker")).not.toBeInTheDocument()
    unmount()

    isTauriMock.mockReturnValue(false)
    render(<Harness />)
    fireEvent.click(screen.getByTestId("workspace-switcher-open-folder"))
    expect(screen.getByTestId("remote-folder-picker")).toBeInTheDocument()
    expect(openFolderAsWorkspaceMock).toHaveBeenCalledTimes(1)
  })

  it("drops the open-folder entry only when neither route exists", () => {
    seed(1)
    isTauriMock.mockReturnValue(false)
    gateMock.mockReturnValue({ available: false, reason: "unsupported" })
    render(<Harness />)

    expect(screen.queryByTestId("workspace-switcher-open-folder")).not.toBeInTheDocument()
  })
})
