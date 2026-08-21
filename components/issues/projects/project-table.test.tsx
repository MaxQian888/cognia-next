/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

import { fireEvent, render, screen, within } from "@testing-library/react"
import { EMPTY_ISSUE_PROJECT_PROGRESS } from "@/lib/issues/project-progress"
import type { IssueProject } from "@/types/issues"
import { ProjectTable } from "./project-table"

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

function renderTable(over: Partial<React.ComponentProps<typeof ProjectTable>> = {}) {
  const props: React.ComponentProps<typeof ProjectTable> = {
    projects: [project()],
    progressById: new Map(),
    onSelect: jest.fn(),
    ...over,
  }
  return { props, ...render(<ProjectTable {...props} />) }
}

describe("ProjectTable", () => {
  it("shows the fields a card grid could not fit", () => {
    renderTable({
      projects: [
        project({
          lead: { kind: "human", label: "Ada" },
          targetDate: Date.parse("2026-09-01T00:00:00.000Z"),
        }),
      ],
    })
    const row = screen.getByTestId("project-row-p1")
    expect(row).toHaveTextContent("Mercury")
    expect(row).toHaveTextContent("MERC")
    expect(row).toHaveTextContent("Ada")
    expect(row).toHaveTextContent("projects.status.in_progress")
  })

  it("says so when there is no lead, rather than leaving a blank cell", () => {
    renderTable()
    expect(screen.getByTestId("project-row-p1")).toHaveTextContent("actor.noLead")
  })

  it("dashes an unset target date", () => {
    renderTable()
    expect(screen.getByTestId("project-row-p1")).toHaveTextContent("—")
  })

  it("selects on the name cell", () => {
    const onSelect = jest.fn()
    renderTable({ onSelect })
    fireEvent.click(screen.getByTestId("project-open-p1"))
    expect(onSelect).toHaveBeenCalledWith("p1")
  })

  it("marks the selected row", () => {
    renderTable({ selectedId: "p1" })
    expect(screen.getByTestId("project-row-p1")).toHaveAttribute("data-selected", "true")
    expect(screen.getByTestId("project-open-p1")).toHaveAttribute("aria-pressed", "true")
  })

  it("counts progress against the denominator, and inventory against the total", () => {
    renderTable({
      progressById: new Map([
        ["p1", { total: 5, completed: 1, canceled: 2, started: 2, denominator: 3, ratio: 1 / 3 }],
      ]),
    })
    const row = screen.getByTestId("project-row-p1")
    // "1 of 3" outstanding …
    expect(row).toHaveTextContent("projects.progressCount:1,3")
    // … but the container holds 5 issues.
    expect(within(row).getByText("5")).toBeInTheDocument()
  })

  it("renders a zeroed row for a container with no issues", () => {
    renderTable({ progressById: new Map([["p1", { ...EMPTY_ISSUE_PROJECT_PROGRESS }]]) })
    expect(screen.getByTestId("project-row-p1")).toHaveTextContent("projects.progressCount:0,0")
  })

  it("survives a container with no progress entry at all", () => {
    expect(() => renderTable({ progressById: new Map() })).not.toThrow()
  })

  it("renders one row per container", () => {
    renderTable({ projects: [project(), project({ id: "p2", key: "VEN", name: "Venus" })] })
    expect(screen.getByTestId("project-row-p1")).toBeInTheDocument()
    expect(screen.getByTestId("project-row-p2")).toBeInTheDocument()
  })
})
