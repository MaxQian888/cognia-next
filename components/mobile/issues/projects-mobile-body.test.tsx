/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

jest.mock("@/lib/db/issue-projects", () => ({ listIssueProjects: jest.fn() }))
jest.mock("@/lib/db/issues", () => ({ listIssues: jest.fn() }))

let projectsForTest: unknown[] = []
let issuesForTest: unknown[] = []
let isSyncing = false
jest.mock("@/hooks/data/use-dexie-first-query", () => ({
  useDexieFirstQuery: ({ query }: { query: unknown }) => ({
    data: String(query).includes("listIssueProjects") ? projectsForTest : issuesForTest,
    isSyncing,
    lastSyncedAt: null,
    error: null,
  }),
}))

let activeProjectId: string | null = "w1"
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: { activeProjectId: string | null }) => unknown) =>
    selector({ activeProjectId }),
}))

import { render, screen } from "@testing-library/react"
import type { IssueProject } from "@/types/issues"
import { ProjectsMobileBody } from "./projects-mobile-body"

const project = (over: Partial<IssueProject> = {}): IssueProject => ({
  id: "p1",
  projectId: "w1",
  key: "MERC",
  name: "Mercury",
  status: "in_progress",
  priority: "medium",
  resources: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

beforeEach(() => {
  projectsForTest = []
  issuesForTest = []
  activeProjectId = "w1"
  isSyncing = false
})

describe("ProjectsMobileBody", () => {
  it("shows an empty state", () => {
    render(<ProjectsMobileBody />)
    expect(screen.getByTestId("projects-mobile-empty")).toBeInTheDocument()
  })

  it("skeletonises the container list rather than claiming it is empty mid-sync", () => {
    isSyncing = true
    render(<ProjectsMobileBody />)
    expect(screen.getByTestId("projects-mobile-skeleton")).toBeInTheDocument()
    expect(screen.queryByTestId("projects-mobile-empty")).not.toBeInTheDocument()
  })

  it("counts the containers in the header", () => {
    projectsForTest = [project(), project({ id: "p2", key: "VEN", name: "Venus" })]
    render(<ProjectsMobileBody />)
    expect(screen.getByText("projects.summary:2")).toBeInTheDocument()
  })

  it("renders one row per container with its key and status", () => {
    projectsForTest = [project({ icon: "🚀" })]
    render(<ProjectsMobileBody />)
    const row = screen.getByTestId("projects-mobile-row-p1")
    expect(row).toHaveTextContent("Mercury")
    expect(row).toHaveTextContent("MERC")
    expect(row).toHaveTextContent("projects.status.in_progress")
    expect(row).toHaveTextContent("🚀")
  })

  it("counts progress against the denominator", () => {
    projectsForTest = [project()]
    issuesForTest = [
      { issueProjectId: "p1", status: "done" },
      { issueProjectId: "p1", status: "canceled" },
      { issueProjectId: "p1", status: "todo" },
    ]
    render(<ProjectsMobileBody />)
    // 1 done out of 2 non-cancelled.
    expect(screen.getByText("projects.progressCount:1,2")).toBeInTheDocument()
  })

  it("shows a target date when there is one", () => {
    projectsForTest = [project({ targetDate: Date.parse("2026-09-01T00:00:00.000Z") })]
    render(<ProjectsMobileBody />)
    expect(screen.getByTestId("projects-mobile-row-p1")).toHaveTextContent("projects.targetDate")
  })

  it("highlights a deep-linked container", () => {
    projectsForTest = [project()]
    render(<ProjectsMobileBody initialSelectedId="p1" />)
    expect(screen.getByTestId("projects-mobile-row-p1").className).toContain("bg-accent")
  })

  it("offers no write controls at all — mobile is read-only by design", () => {
    projectsForTest = [project()]
    const { container } = render(<ProjectsMobileBody />)
    expect(container.querySelectorAll("button")).toHaveLength(0)
    expect(container.querySelectorAll("input")).toHaveLength(0)
  })

  it("renders nothing to query without a workspace", () => {
    activeProjectId = null
    render(<ProjectsMobileBody />)
    expect(screen.getByTestId("projects-mobile-empty")).toBeInTheDocument()
  })
})
