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
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (fn: () => Promise<unknown>) => {
    // Distinguish the two queries by which db module the caller reached for.
    const source = fn.toString()
    return source.includes("listIssueProjects") ? projectsResult : issuesResult
  },
}))
jest.mock("@/lib/db/issues", () => ({ listIssues: jest.fn() }))
jest.mock("@/lib/db/issue-projects", () => ({ listIssueProjects: jest.fn() }))

let storeState: { activeProjectId: string | null; projects: unknown[] } = {
  activeProjectId: "w1",
  projects: [],
}
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

import { render, screen } from "@testing-library/react"
import { WorkspaceOverview } from "./workspace-overview"

function issue(status: string) {
  return { id: `i-${status}-${Math.random()}`, status, issueProjectId: "p1" }
}

beforeEach(() => {
  projectsResult = []
  issuesResult = []
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

  it("lists the workspace's mounted roots", () => {
    storeState = {
      activeProjectId: "w1",
      projects: [
        { id: "w1", name: "Cognia", roots: [{ id: "r1", path: "/tmp/repo", isPrimary: true }] },
      ],
    }
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-roots")).toHaveTextContent("/tmp/repo")
  })

  it("links out to the single root editor rather than editing roots here", () => {
    render(<WorkspaceOverview />)
    // Two editors over one row is the double-entry-point defect this page must
    // not reintroduce; it links to the existing manager instead.
    expect(screen.getByTestId("workspace-manage-link")).toBeInTheDocument()
  })
})
