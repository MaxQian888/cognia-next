import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { WorkspaceRoot } from "@/types/workspace"
import { RootSwitcher } from "./root-switcher"
import { gitTargetFromRemote } from "@/lib/git/target"

const setRootDir = jest.fn()
let gitRootDir = "/repo/a"
let projectRoots: WorkspaceRoot[] = []

jest.mock("@/stores/git/git-store", () => ({
  useGitStore: (selector: (s: unknown) => unknown) => selector({ rootDir: gitRootDir, setRootDir }),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) =>
    selector({ activeProjectId: "p1", projects: [{ id: "p1", roots: projectRoots }] }),
}))

beforeEach(() => {
  jest.clearAllMocks()
  gitRootDir = "/repo/a"
})

describe("RootSwitcher", () => {
  it("renders nothing for a single-root workspace", () => {
    projectRoots = [{ id: "r1", path: "/repo/a", isPrimary: true }]
    const { container } = render(<RootSwitcher />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing for a rootless workspace", () => {
    projectRoots = []
    const { container } = render(<RootSwitcher />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the bound root label for a multi-root workspace", () => {
    projectRoots = [
      { id: "r1", path: "/repo/a", isPrimary: true },
      { id: "r2", path: "/repo/b" },
    ]
    render(<RootSwitcher />)
    const trigger = screen.getByTestId("root-switcher")
    expect(trigger).toHaveTextContent("a")
  })

  it("prefers an explicit label over the basename", () => {
    projectRoots = [
      { id: "r1", path: "/repo/a", isPrimary: true, label: "Frontend" },
      { id: "r2", path: "/repo/b", label: "Backend" },
    ]
    render(<RootSwitcher />)
    expect(screen.getByTestId("root-switcher")).toHaveTextContent("Frontend")
  })

  it("switches the bound root on selection", async () => {
    const user = userEvent.setup()
    projectRoots = [
      { id: "r1", path: "/repo/a", isPrimary: true },
      { id: "r2", path: "/repo/b" },
    ]
    render(<RootSwitcher />)
    await user.click(screen.getByTestId("root-switcher"))
    await user.click(await screen.findByTestId("root-option-r2"))
    expect(setRootDir).toHaveBeenCalledWith("/repo/b")
  })

  it("uses explicit resource-scoped roots instead of the active workspace", () => {
    projectRoots = [
      { id: "active-1", path: "/active/a", isPrimary: true },
      { id: "active-2", path: "/active/b" },
    ]
    gitRootDir = "/resource/b"

    render(
      <RootSwitcher
        roots={[
          { id: "resource-1", path: "/resource/a", isPrimary: true },
          { id: "resource-2", path: "/resource/b", label: "Resource API" },
        ]}
      />
    )

    expect(screen.getByTestId("root-switcher")).toHaveTextContent("Resource API")
  })

  it("switches among opaque remote workspaces without exposing paths", async () => {
    const user = userEvent.setup()
    const onSelect = jest.fn()
    const remoteWorkspaces = [
      {
        workspaceId: "a",
        displayName: "Alpha",
        repositoryState: { isRepo: true, rootDir: "repo-a" },
      },
      {
        workspaceId: "b",
        displayName: "Beta",
        repositoryState: { isRepo: true, rootDir: "repo-b" },
      },
    ] as never
    gitRootDir = gitTargetFromRemote("a", "repo-a")
    render(<RootSwitcher remoteWorkspaces={remoteWorkspaces} onSelectRemoteWorkspace={onSelect} />)
    expect(screen.getByTestId("root-switcher")).toHaveTextContent("Alpha")
    expect(screen.queryByText("repo-a")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("root-switcher"))
    await user.click(await screen.findByTestId("root-option-b"))
    expect(onSelect).toHaveBeenCalledWith(remoteWorkspaces[1])
  })
})
