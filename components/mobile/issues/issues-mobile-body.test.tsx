/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

let issuesResult: unknown[] = []
let projectsResult: unknown[] = []
let labelsResult: unknown[] = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (fn: () => Promise<unknown>) => {
    const source = fn.toString()
    if (source.includes("listIssueProjects")) return projectsResult
    if (source.includes("listLabels")) return labelsResult
    return issuesResult
  },
}))
jest.mock("@/lib/db/issues", () => ({ listIssues: jest.fn() }))
jest.mock("@/lib/db/issue-projects", () => ({ listIssueProjects: jest.fn() }))
jest.mock("@/lib/db/labels", () => ({ listLabels: jest.fn() }))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: { activeProjectId: string | null }) => unknown) =>
    selector({ activeProjectId: "w1" }),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import type { Issue } from "@/types/issues"
import { IssuesMobileBody } from "./issues-mobile-body"

let seq = 0
function issue(over: Partial<Issue> = {}): Issue {
  seq += 1
  const status = over.status ?? "todo"
  return {
    id: `i${seq}`,
    identifier: `MERC-${seq}`,
    number: seq,
    projectId: "w1",
    issueProjectId: "p1",
    title: `Issue ${seq}`,
    status,
    statusCategory: statusCategoryOf(status),
    priority: "none",
    createdBy: { kind: "human" },
    labelIds: [],
    order: 0,
    createdAt: seq,
    updatedAt: seq,
    ...over,
  }
}

beforeEach(() => {
  seq = 0
  issuesResult = []
  projectsResult = []
  labelsResult = []
})

describe("IssuesMobileBody", () => {
  it("shows an empty state when there is nothing", () => {
    render(<IssuesMobileBody />)
    expect(screen.getByTestId("issues-mobile-empty")).toBeInTheDocument()
  })

  it("groups by status and renders a row per issue", () => {
    issuesResult = [issue({ status: "todo" }), issue({ status: "done" })]
    render(<IssuesMobileBody />)
    expect(screen.getByTestId("issues-mobile-group-todo")).toBeInTheDocument()
    expect(screen.getByTestId("issues-mobile-group-done")).toBeInTheDocument()
    expect(screen.getByTestId("issues-mobile-row-i1")).toHaveTextContent("MERC-1")
  })

  it("offers no drag affordance — mobile is read-only until sync lands", () => {
    issuesResult = [issue()]
    const { container } = render(<IssuesMobileBody />)
    expect(container.querySelector("[data-dragging]")).toBeNull()
    // Rows open a read-only sheet, so they ARE buttons; what must not exist is
    // anything that writes.
    expect(container.querySelector("input, textarea, select")).toBeNull()
  })

  it("highlights the deep-linked issue", () => {
    issuesResult = [issue(), issue()]
    render(<IssuesMobileBody initialSelectedId="i2" />)
    expect(screen.getByTestId("issues-mobile-row-i2").className).toContain("bg-accent")
    expect(screen.getByTestId("issues-mobile-row-i1").className).not.toContain("bg-accent")
  })

  describe("detail sheet", () => {
    it("opens the deep-linked issue instead of only tinting its row", async () => {
      issuesResult = [issue(), issue()]
      render(<IssuesMobileBody initialSelectedId="i2" />)
      expect(await screen.findByTestId("issues-mobile-detail")).toBeInTheDocument()
    })

    it("stays shut when nothing is deep-linked", () => {
      issuesResult = [issue()]
      render(<IssuesMobileBody />)
      expect(screen.queryByTestId("issues-mobile-detail")).not.toBeInTheDocument()
    })

    it("opens on tap", async () => {
      issuesResult = [issue()]
      render(<IssuesMobileBody />)
      fireEvent.click(screen.getByTestId("issues-mobile-row-i1"))
      expect(await screen.findByTestId("issues-mobile-detail")).toBeInTheDocument()
    })

    it("ignores a deep link to an issue that is not there", () => {
      issuesResult = [issue()]
      render(<IssuesMobileBody initialSelectedId="ghost" />)
      expect(screen.queryByTestId("issues-mobile-detail")).not.toBeInTheDocument()
    })
  })

  it("marks an unassigned row explicitly", () => {
    issuesResult = [issue()]
    render(<IssuesMobileBody />)
    expect(screen.getByTestId("issues-mobile-row-i1")).toHaveTextContent("actor.unassigned")
  })

  it("shows the project chip once the name resolves", () => {
    issuesResult = [issue()]
    projectsResult = [{ id: "p1", name: "Mercury" }]
    render(<IssuesMobileBody />)
    expect(screen.getByTestId("issues-mobile-row-i1")).toHaveTextContent("Mercury")
  })

  it("renders resolved labels", () => {
    issuesResult = [issue({ labelIds: ["l1"] })]
    labelsResult = [{ id: "l1", scope: "issue", name: "bug", sortOrder: 0, createdAt: 0, updatedAt: 0 }]
    render(<IssuesMobileBody />)
    expect(screen.getByTestId("label-chip-l1")).toBeInTheDocument()
  })
})
