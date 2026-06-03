import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { WorkspaceRoot } from "@/types/workspace"
import { RootSwitcher } from "./root-switcher"

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
})
