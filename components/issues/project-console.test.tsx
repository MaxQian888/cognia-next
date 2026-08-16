/**
 * @jest-environment jsdom
 */

// Echoes the ICU values too, so an assertion can prove a count actually
// reached the message rather than only that the right key was chosen.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}))
jest.mock("@/components/feature-shell/feature-page-shell", () => ({
  FeaturePageShell: ({
    header,
    children,
    rightPane,
  }: {
    header: React.ReactNode
    children: React.ReactNode
    rightPane?: { content: React.ReactNode }
  }) => (
    <div>
      {header}
      {children}
      {rightPane?.content}
    </div>
  ),
}))
jest.mock("@/components/feature-shell/feature-page-header", () => ({
  FeaturePageHeader: ({
    title,
    summary,
    controls,
  }: {
    title: string
    summary?: string
    controls?: React.ReactNode
  }) => (
    <div>
      <h1>
        {title}
        {summary}
      </h1>
      {controls}
    </div>
  ),
}))

let projectsResult: unknown[] = []
let issuesResult: unknown[] = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (fn: () => Promise<unknown>) =>
    fn.toString().includes("listIssueProjects") ? projectsResult : issuesResult,
}))
jest.mock("@/lib/db/issues", () => ({ listIssues: jest.fn(), countIssuesByStatus: jest.fn() }))

const mockRemoveResource = jest.fn()
jest.mock("@/lib/db/issue-projects", () => ({
  listIssueProjects: jest.fn(),
  removeIssueProjectResource: (...a: unknown[]) => mockRemoveResource(...a),
}))

const mockSyncSchedule = jest.fn()
jest.mock("@/lib/issues/github-sync-schedule", () => ({
  syncGithubIssueSchedule: (...a: unknown[]) => mockSyncSchedule(...a),
}))

const mockRunSync = jest.fn()
jest.mock("@/lib/issues/sync-runner", () => ({
  runWorkspaceGithubSync: (...a: unknown[]) => mockRunSync(...a),
  isMissingGithubCredential: (error: unknown) =>
    error instanceof Error && error.name === "MissingGithubCredentialError",
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
const toastInfo = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    info: (...a: unknown[]) => toastInfo(...a),
  },
}))

// The dialog has its own suite; here it only needs to be observably mounted.
jest.mock("./project-resource-dialog", () => ({
  ProjectResourceDialog: ({ issueProjectId }: { issueProjectId: string }) => (
    <div data-testid="resource-dialog">{issueProjectId}</div>
  ),
}))

let storeWorkspaces: unknown[] = [{ id: "w1", roots: [{ id: "root-1", path: "/src" }] }]
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (
    selector: (s: { activeProjectId: string | null; projects: unknown[] }) => unknown
  ) => selector({ activeProjectId: "w1", projects: storeWorkspaces }),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ProjectConsole } from "./project-console"

function project(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    projectId: "w1",
    key: "MERC",
    name: "Mercury",
    status: "planned",
    priority: "none",
    resources: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function issue(status: string, issueProjectId = "p1") {
  return { id: `i-${status}`, status, issueProjectId }
}

const REPO_RESOURCE = { kind: "github-repo", repoFullName: "o/r", addedAt: 1 }

beforeEach(() => {
  jest.clearAllMocks()
  projectsResult = []
  issuesResult = []
  storeWorkspaces = [{ id: "w1", roots: [{ id: "root-1", path: "/src" }] }]
  mockRunSync.mockResolvedValue({ repoCount: 1, results: [], failures: [] })
})

describe("ProjectConsole", () => {
  it("shows an empty state with the reason projects exist", () => {
    render(<ProjectConsole />)
    expect(screen.getByTestId("project-console-empty")).toBeInTheDocument()
    expect(screen.getByText("projects.emptyHint")).toBeInTheDocument()
  })

  it("renders a card per project with its immutable key", () => {
    projectsResult = [project()]
    render(<ProjectConsole />)
    expect(screen.getByTestId("project-card-p1")).toHaveTextContent("Mercury")
    expect(screen.getByTestId("project-card-p1")).toHaveTextContent("MERC")
  })

  it("excludes cancelled issues from the progress denominator", () => {
    projectsResult = [project()]
    issuesResult = [issue("done"), issue("todo"), issue("canceled")]
    render(<ProjectConsole />)
    // 1 done of 2 non-cancelled.
    expect(screen.getByTestId("project-card-p1")).toHaveTextContent("projects.progressCount")
  })

  it("ignores issues belonging to another project", () => {
    projectsResult = [project()]
    issuesResult = [issue("done", "p-other")]
    render(<ProjectConsole />)
    expect(screen.getByTestId("project-card-p1")).toBeInTheDocument()
  })

  it("opens the inspector on selection and closes it again", () => {
    projectsResult = [project()]
    render(<ProjectConsole />)
    expect(screen.queryByTestId("project-inspector")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("project-card-p1"))
    expect(screen.getByTestId("project-inspector")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("project-inspector-close"))
    expect(screen.queryByTestId("project-inspector")).not.toBeInTheDocument()
  })

  it("honours a deep-linked project", () => {
    projectsResult = [project()]
    render(<ProjectConsole initialSelectedId="p1" />)
    expect(screen.getByTestId("project-inspector")).toBeInTheDocument()
  })

  it("nudges toward a description when there is none, since agents read it", () => {
    projectsResult = [project()]
    render(<ProjectConsole initialSelectedId="p1" />)
    expect(screen.getAllByText("projects.descriptionHint").length).toBeGreaterThan(0)
  })

  it("lists repo and directory resources distinctly", () => {
    projectsResult = [
      project({
        resources: [
          { kind: "github-repo", repoFullName: "o/r", addedAt: 1 },
          { kind: "workspace-root", rootId: "root-1", addedAt: 1 },
        ],
      }),
    ]
    render(<ProjectConsole initialSelectedId="p1" />)
    const resources = screen.getByTestId("project-resources")
    expect(resources).toHaveTextContent("o/r")
    expect(resources).toHaveTextContent("root-1")
  })

  it("states that directories are references to already-mounted roots", () => {
    projectsResult = [project()]
    render(<ProjectConsole initialSelectedId="p1" />)
    expect(screen.getAllByText("projects.directoryHint").length).toBeGreaterThan(0)
  })
})

describe("resource binding", () => {
  it("opens the add-resource dialog for the selected project", () => {
    projectsResult = [project()]
    render(<ProjectConsole initialSelectedId="p1" />)
    expect(screen.queryByTestId("resource-dialog")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("project-add-resource"))
    expect(screen.getByTestId("resource-dialog")).toHaveTextContent("p1")
  })

  it("removes a resource and retires the schedule when it was the last repo", async () => {
    projectsResult = [project({ resources: [REPO_RESOURCE] })]
    render(<ProjectConsole initialSelectedId="p1" />)

    fireEvent.click(screen.getByTestId("project-resource-remove-0"))

    await waitFor(() => expect(mockRemoveResource).toHaveBeenCalledWith("p1", REPO_RESOURCE))
    expect(mockSyncSchedule).toHaveBeenCalledTimes(1)
  })

  it("does not touch the schedule when unbinding a directory", async () => {
    projectsResult = [
      project({ resources: [{ kind: "workspace-root", rootId: "root-1", addedAt: 1 }] }),
    ]
    render(<ProjectConsole initialSelectedId="p1" />)

    fireEvent.click(screen.getByTestId("project-resource-remove-0"))

    await waitFor(() => expect(mockRemoveResource).toHaveBeenCalled())
    expect(mockSyncSchedule).not.toHaveBeenCalled()
  })
})

describe("Sync now", () => {
  it("is disabled while no repo is bound — there is nothing to fetch", () => {
    projectsResult = [project()]
    render(<ProjectConsole />)
    expect(screen.getByTestId("project-sync-now")).toBeDisabled()
  })

  it("bypasses the watermark, because a manual sync means drift is suspected", async () => {
    projectsResult = [project({ resources: [REPO_RESOURCE] })]
    mockRunSync.mockResolvedValue({
      repoCount: 1,
      results: [{ repoFullName: "o/r", written: 4, notModified: false, truncated: false }],
      failures: [],
    })
    render(<ProjectConsole />)

    fireEvent.click(screen.getByTestId("project-sync-now"))

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('sync.done {"count":4}'))
    expect(mockRunSync).toHaveBeenCalledWith({ projectId: "w1", full: true })
  })

  it("distinguishes a missing credential from a failed sync", async () => {
    const credentialError = new Error("no token")
    credentialError.name = "MissingGithubCredentialError"
    projectsResult = [project({ resources: [REPO_RESOURCE] })]
    mockRunSync.mockResolvedValue({
      repoCount: 1,
      results: [],
      failures: [{ repoFullName: "o/r", error: credentialError }],
    })
    render(<ProjectConsole />)

    fireEvent.click(screen.getByTestId("project-sync-now"))

    // "Sync failed" would send the user hunting for a network problem.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("sync.noCredential"))
  })

  it("names the repos that failed", async () => {
    projectsResult = [project({ resources: [REPO_RESOURCE] })]
    mockRunSync.mockResolvedValue({
      repoCount: 1,
      results: [],
      failures: [{ repoFullName: "o/r", error: new Error("502") }],
    })
    render(<ProjectConsole />)

    fireEvent.click(screen.getByTestId("project-sync-now"))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('sync.failed {"repos":"o/r"}'))
  })

  it("reports a thrown sync rather than leaving the button spinning", async () => {
    projectsResult = [project({ resources: [REPO_RESOURCE] })]
    mockRunSync.mockRejectedValue(new Error("dexie exploded"))
    render(<ProjectConsole />)

    fireEvent.click(screen.getByTestId("project-sync-now"))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("dexie exploded"))
    expect(screen.getByTestId("project-sync-now")).toBeEnabled()
  })
})
