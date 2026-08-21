/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import { fireEvent, render, screen, within } from "@testing-library/react"
import { EMPTY_ISSUE_PROJECT_PROGRESS } from "@/lib/issues/project-progress"
import type { IssueProject } from "@/types/issues"
import type { LabelRow } from "@/types/labels"
import { IssueRail } from "./issue-rail"

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

const label = (over: Partial<LabelRow> = {}): LabelRow => ({
  id: "l1",
  scope: "issue",
  name: "bug",
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

function renderRail(over: Partial<React.ComponentProps<typeof IssueRail>> = {}) {
  const props: React.ComponentProps<typeof IssueRail> = {
    viewId: "all",
    viewCounts: { all: 3, assigned: 1, created: 0, "my-agents": 2 },
    onSelectView: jest.fn(),
    projects: [],
    projectProgress: new Map(),
    activeProjectIds: [],
    onToggleProject: jest.fn(),
    labels: [],
    labelCounts: new Map(),
    activeLabelIds: [],
    onToggleLabel: jest.fn(),
    ...over,
  }
  return { props, ...render(<IssueRail {...props} />) }
}

describe("IssueRail", () => {
  describe("views", () => {
    it("lists all four built-ins", () => {
      renderRail()
      for (const id of ["all", "assigned", "created", "my-agents"]) {
        expect(screen.getByTestId(`issue-rail-view-${id}`)).toBeInTheDocument()
      }
    })

    it("marks the active one", () => {
      renderRail({ viewId: "assigned" })
      expect(screen.getByTestId("issue-rail-view-assigned")).toHaveAttribute("aria-pressed", "true")
      expect(screen.getByTestId("issue-rail-view-all")).toHaveAttribute("aria-pressed", "false")
    })

    it("shows each view's count, zero included", () => {
      renderRail()
      expect(
        within(screen.getByTestId("issue-rail-view-created")).getByText("0")
      ).toBeInTheDocument()
      expect(within(screen.getByTestId("issue-rail-view-all")).getByText("3")).toBeInTheDocument()
    })

    it("switches on click", () => {
      const onSelectView = jest.fn()
      renderRail({ onSelectView })
      fireEvent.click(screen.getByTestId("issue-rail-view-created"))
      expect(onSelectView).toHaveBeenCalledWith("created")
    })
  })

  describe("projects", () => {
    it("says so when there are none", () => {
      renderRail()
      expect(screen.getByText("rail.noProjects")).toBeInTheDocument()
    })

    it("lists each container with its icon", () => {
      renderRail({ projects: [project({ icon: "🚀" })] })
      const row = screen.getByTestId("issue-rail-project-p1")
      expect(row).toHaveTextContent("Mercury")
      expect(row).toHaveTextContent("🚀")
    })

    it("filters the board rather than navigating", () => {
      const onToggleProject = jest.fn()
      renderRail({ projects: [project()], onToggleProject })
      fireEvent.click(screen.getByTestId("issue-rail-project-p1"))
      expect(onToggleProject).toHaveBeenCalledWith("p1")
    })

    it("keeps navigation as a separate control", () => {
      renderRail({ projects: [project()] })
      expect(screen.getByTestId("issue-rail-open-project-p1")).toHaveAttribute(
        "href",
        "/projects?id=p1"
      )
    })

    it("marks a project that is currently filtering", () => {
      renderRail({ projects: [project()], activeProjectIds: ["p1"] })
      expect(screen.getByTestId("issue-rail-project-p1")).toHaveAttribute("aria-pressed", "true")
    })

    it("shows a progress bar only when there is outstanding work to measure", () => {
      const { container } = renderRail({
        projects: [project()],
        projectProgress: new Map([["p1", { ...EMPTY_ISSUE_PROJECT_PROGRESS }]]),
      })
      expect(container.querySelector('[role="progressbar"]')).toBeNull()
    })

    it("renders the bar once the container holds work", () => {
      const { container } = renderRail({
        projects: [project()],
        projectProgress: new Map([
          ["p1", { total: 4, completed: 1, canceled: 0, started: 3, denominator: 4, ratio: 0.25 }],
        ]),
      })
      expect(container.querySelector('[role="progressbar"]')).not.toBeNull()
    })

    it("counts against the denominator, not the raw total", () => {
      renderRail({
        projects: [project()],
        projectProgress: new Map([
          ["p1", { total: 5, completed: 1, canceled: 2, started: 2, denominator: 3, ratio: 1 / 3 }],
        ]),
      })
      expect(within(screen.getByTestId("issue-rail-project-p1")).getByText("3")).toBeInTheDocument()
    })

    it("links the section header to the projects console", () => {
      renderRail()
      expect(screen.getByTestId("issue-rail-manage-projects")).toHaveAttribute("href", "/projects")
    })
  })

  describe("labels", () => {
    it("says so when there are none", () => {
      renderRail()
      expect(screen.getByText("rail.noLabels")).toBeInTheDocument()
    })

    it("lists each label with a colour swatch", () => {
      renderRail({ labels: [label()] })
      expect(screen.getByTestId("issue-rail-label-l1")).toHaveTextContent("bug")
      expect(screen.getByTestId("issue-rail-label-swatch-l1")).toBeInTheDocument()
    })

    it("toggles the label filter", () => {
      const onToggleLabel = jest.fn()
      renderRail({ labels: [label()], onToggleLabel })
      fireEvent.click(screen.getByTestId("issue-rail-label-l1"))
      expect(onToggleLabel).toHaveBeenCalledWith("l1")
    })

    it("shows how many issues carry each label", () => {
      renderRail({ labels: [label()], labelCounts: new Map([["l1", 4]]) })
      expect(within(screen.getByTestId("issue-rail-label-l1")).getByText("4")).toBeInTheDocument()
    })

    it("offers management only when the caller can handle it", () => {
      renderRail({ labels: [label()] })
      expect(screen.queryByTestId("issue-rail-manage-labels")).not.toBeInTheDocument()

      const onManageLabels = jest.fn()
      renderRail({ labels: [label()], onManageLabels })
      fireEvent.click(screen.getByTestId("issue-rail-manage-labels"))
      expect(onManageLabels).toHaveBeenCalled()
    })
  })

  describe("sections", () => {
    it("collapses a section without touching the others", () => {
      renderRail({ projects: [project()], labels: [label()] })
      fireEvent.click(screen.getByTestId("issue-rail-toggle-projects"))
      expect(screen.queryByTestId("issue-rail-project-p1")).not.toBeInTheDocument()
      expect(screen.getByTestId("issue-rail-label-l1")).toBeInTheDocument()
      expect(screen.getByTestId("issue-rail-view-all")).toBeInTheDocument()
    })
  })
})
