/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
jest.mock("@/components/feature-shell/feature-page-shell", () => ({
  FeaturePageShell: ({
    header,
    children,
  }: {
    header: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}))
jest.mock("@/components/feature-shell/feature-page-header", () => ({
  FeaturePageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}))

let projectsResult: unknown[] = []
let issuesResult: unknown[] = []
let runningResult: ReadonlySet<string> = new Set()
let trustedResult: Array<{ path: string; trustedAt: number }> = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (fn: () => Promise<unknown>) => {
    // Distinguish the queries by which db module the caller reached for.
    const source = fn.toString()
    if (source.includes("listIssueProjects")) return projectsResult
    if (source.includes("listActiveIssueRunIssueIds")) return runningResult
    if (source.includes("listTrustedWorkspaces")) return trustedResult
    return issuesResult
  },
}))
jest.mock("@/lib/db/issues", () => ({ listIssues: jest.fn() }))
jest.mock("@/lib/db/issue-projects", () => ({ listIssueProjects: jest.fn() }))
jest.mock("@/lib/db/issue-runs", () => ({ listActiveIssueRunIssueIds: jest.fn() }))
jest.mock("@/lib/db/trusted-workspaces", () => ({ listTrustedWorkspaces: jest.fn() }))
let manageDialogProps: { open: boolean; onOpenChange: (open: boolean) => void } | null = null
jest.mock("@/components/shell/workspace-manage-dialog", () => ({
  WorkspaceManageDialog: (props: { open: boolean; onOpenChange: (open: boolean) => void }) => {
    manageDialogProps = props
    return props.open ? <div data-testid="manage-dialog-stub" /> : null
  },
}))

let storeState: { activeProjectId: string | null; projects: unknown[] } = {
  activeProjectId: "w1",
  projects: [],
}
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { WorkspaceOverview } from "./workspace-overview"

function issue(status: string) {
  return { id: `i-${status}-${Math.random()}`, status, issueProjectId: "p1" }
}

beforeEach(() => {
  projectsResult = []
  issuesResult = []
  runningResult = new Set()
  trustedResult = []
  manageDialogProps = null
  storeState = { activeProjectId: "w1", projects: [] }
})

describe("WorkspaceOverview", () => {
  it("titles itself with the active workspace name", () => {
    storeState = {
      activeProjectId: "w1",
      projects: [{ id: "w1", name: "Cognia", roots: [] }],
    }
    render(<WorkspaceOverview />)
    expect(screen.getByRole("heading", { name: "Cognia" })).toBeInTheDocument()
  })

  it("counts only unstarted and started issues as open", () => {
    issuesResult = [issue("todo"), issue("in_progress"), issue("done"), issue("canceled")]
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-open-issues")).toHaveTextContent("2")
  })

  it("breaks issues down across every status, including empty ones", () => {
    issuesResult = [issue("todo")]
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-status-todo")).toHaveTextContent("1")
    expect(screen.getByTestId("workspace-status-done")).toHaveTextContent("0")
  })

  it("says so when the workspace has no projects", () => {
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-no-projects")).toBeInTheDocument()
  })

  it("links each project to its deep link", () => {
    projectsResult = [{ id: "p1", name: "Mercury", key: "MERC", status: "planned", resources: [] }]
    render(<WorkspaceOverview />)
    const link = screen.getByTestId("workspace-project-p1")
    expect(link).toHaveAttribute("href", "/projects?id=p1")
    expect(link).toHaveTextContent("MERC")
    expect(screen.getByTestId("workspace-project-count")).toHaveTextContent("1")
  })

  it("lists the workspace's mounted roots with their trust state", () => {
    storeState = {
      activeProjectId: "w1",
      projects: [
        {
          id: "w1",
          name: "Cognia",
          roots: [
            { id: "r1", path: "/tmp/repo/", isPrimary: true },
            { id: "r2", path: "/tmp/other" },
          ],
        },
      ],
    }
    trustedResult = [{ path: "/tmp/repo", trustedAt: 1 }]
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-roots")).toHaveTextContent("/tmp/repo")
    expect(screen.getAllByTestId("workspace-root-trust-trusted")).toHaveLength(1)
    expect(screen.getAllByTestId("workspace-root-trust-untrusted")).toHaveLength(1)
  })

  it("counts issues with an active run as agents working", () => {
    runningResult = new Set(["i1", "i2"])
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-agents-working")).toHaveTextContent("2")
  })

  it("opens the ONE root editor (the manage dialog) instead of editing roots here", () => {
    render(<WorkspaceOverview />)
    // Two editors over one row is the double-entry-point defect this page must
    // not reintroduce; it mounts the existing manager dialog instead.
    expect(screen.queryByTestId("manage-dialog-stub")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workspace-manage-link"))
    expect(screen.getByTestId("manage-dialog-stub")).toBeInTheDocument()
    manageDialogProps!.onOpenChange(false)
  })
})
