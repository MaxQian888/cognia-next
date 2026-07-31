/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Project } from "@/types"
import type { GitStatus } from "@/types/git"
import { ProjectOverviewPanel } from "./project-overview-panel"

const push = jest.fn()
const refresh = jest.fn(async () => {})
const sync = jest.fn(async () => {})
const setRootDir = jest.fn()
const selectFile = jest.fn()
const onOpenWorkspace = jest.fn()

let projects: Project[] = []
let available = true
let gitState: Record<string, unknown>

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}))

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: { projects: Project[] }) => unknown) =>
    selector({ projects }),
}))

jest.mock("@/stores/git/git-store", () => ({
  useGitStore: (selector: (state: Record<string, unknown>) => unknown) => selector(gitState),
}))

jest.mock("@/hooks/git/use-git-repo", () => ({
  useGitRepo: () => ({
    available,
    rootDir: gitState.rootDir,
    refresh,
    openFolder: jest.fn(),
  }),
}))

jest.mock("@/hooks/git/use-git-actions", () => ({
  useGitActions: () => ({ sync }),
}))

jest.mock("@/components/source-control/root-switcher", () => ({
  RootSwitcher: ({ roots }: { roots: Array<{ path: string }> }) => (
    <div
      data-testid="project-root-switcher"
      data-roots={roots.map((root) => root.path).join(",")}
    />
  ),
}))

jest.mock("@/components/source-control/branch-header", () => ({
  BranchHeader: ({ branch }: { branch: string | null }) => (
    <div data-testid="project-branch-header">{branch}</div>
  ),
}))

jest.mock("@/components/source-control/changes-view", () => ({
  ChangesView: ({
    status,
    onSelectFile,
  }: {
    status: GitStatus
    onSelectFile: (path: string, staged: boolean) => void
  }) => (
    <div data-testid="project-changes-view">
      {status.merge.length + status.staged.length + status.changes.length}
      <button type="button" onClick={() => onSelectFile("components/panel.tsx", false)}>
        open-change
      </button>
    </div>
  ),
}))

function project(id: string, name: string, root: string, secondary?: string): Project {
  return {
    id,
    name,
    description: `${name} description`,
    customInstructions: "Keep changes focused",
    roots: [
      { id: `${id}-primary`, path: root, isPrimary: true },
      ...(secondary ? [{ id: `${id}-secondary`, path: secondary }] : []),
    ],
    rootDir: root,
    additionalDirs: secondary ? [secondary] : undefined,
    knowledgeBase: [
      {
        id: `${id}-knowledge`,
        name: "README",
        type: "markdown",
        content: "context",
        size: 7,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ],
    sessionIds: [`${id}-session-1`, `${id}-session-2`],
    sessionCount: 2,
    messageCount: 14,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastAccessedAt: new Date(0),
  }
}

function status(): GitStatus {
  return {
    branch: "feature/project-panel",
    upstream: "origin/feature/project-panel",
    ahead: 1,
    behind: 0,
    staged: [],
    changes: [
      {
        path: "components/panel.tsx",
        origPath: null,
        status: "modified",
        staged: false,
        group: "changes",
      },
    ],
    merge: [],
    isRebasing: false,
    isMerging: false,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  available = true
  projects = [
    project("project-a", "Alpha", "/repo/a"),
    project("project-b", "Beta", "/repo/b", "/repo/shared"),
  ]
  gitState = {
    rootDir: "/repo/b",
    repoState: { isRepo: true, operationInProgress: null },
    status: status(),
    branches: [],
    selectedPath: null,
    selectFile,
    ops: { commit: false, sync: false },
    setRootDir,
  }
})

describe("ProjectOverviewPanel", () => {
  it("scopes project information, analysis, roots, and SCM to the requested project", () => {
    render(<ProjectOverviewPanel projectId="project-b" onOpenWorkspace={onOpenWorkspace} />)

    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument()
    expect(screen.getByText("Beta description")).toBeInTheDocument()
    expect(screen.getByTestId("project-root-switcher")).toHaveAttribute(
      "data-roots",
      "/repo/b,/repo/shared"
    )
    expect(screen.getByTestId("project-branch-header")).toHaveTextContent("feature/project-panel")
    expect(screen.getByTestId("project-changes-view")).toHaveTextContent("1")
    expect(screen.getByText("projectOverview.analysis.title")).toBeInTheDocument()
  })

  it("offers workspace, refresh, sync, and full Source Control shortcuts", () => {
    render(<ProjectOverviewPanel projectId="project-b" onOpenWorkspace={onOpenWorkspace} />)

    fireEvent.click(screen.getByTestId("project-open-workspace"))
    fireEvent.click(screen.getByTestId("project-refresh-source-control"))
    fireEvent.click(screen.getByTestId("project-sync-source-control"))
    fireEvent.click(screen.getByTestId("project-open-source-control"))

    expect(onOpenWorkspace).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith("/source-control")
  })

  it("opens a selected change in the full diff surface", () => {
    render(<ProjectOverviewPanel projectId="project-b" onOpenWorkspace={onOpenWorkspace} />)

    fireEvent.click(screen.getByRole("button", { name: "open-change" }))

    expect(selectFile).toHaveBeenCalledWith("components/panel.tsx", false)
    expect(push).toHaveBeenCalledWith("/source-control")
  })

  it("rebinds Source Control when the current repo belongs to another project", async () => {
    gitState.rootDir = "/repo/a"

    render(<ProjectOverviewPanel projectId="project-b" onOpenWorkspace={onOpenWorkspace} />)

    await waitFor(() => expect(setRootDir).toHaveBeenCalledWith("/repo/b"))
    expect(screen.queryByTestId("project-changes-view")).not.toBeInTheDocument()
  })

  it("omits the panel for a rootless project", () => {
    projects = [{ ...projects[0]!, roots: [], rootDir: undefined }]

    const { container } = render(
      <ProjectOverviewPanel projectId="project-a" onOpenWorkspace={onOpenWorkspace} />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it("keeps project information available when desktop Source Control is unavailable", () => {
    available = false

    render(<ProjectOverviewPanel projectId="project-b" onOpenWorkspace={onOpenWorkspace} />)

    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.getByText("projectOverview.sourceControl.unavailable")).toBeInTheDocument()
    expect(screen.getByTestId("project-open-source-control")).toBeDisabled()
  })
})
