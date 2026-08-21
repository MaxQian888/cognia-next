/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

import userEvent from "@testing-library/user-event"
import { fireEvent, render, screen } from "@testing-library/react"
import type { IssueProject } from "@/types/issues"
import { ProjectInspector } from "./project-inspector"

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

function renderInspector(over: Partial<React.ComponentProps<typeof ProjectInspector>> = {}) {
  const props: React.ComponentProps<typeof ProjectInspector> = {
    project: project(),
    onPatch: jest.fn(),
    onClose: jest.fn(),
    onAddResource: jest.fn(),
    onRemoveResource: jest.fn(),
    onRequestDelete: jest.fn(),
    onOpenIssues: jest.fn(),
    ...over,
  }
  return { props, ...render(<ProjectInspector {...props} />) }
}

describe("ProjectInspector", () => {
  describe("editing", () => {
    it("renames", async () => {
      const user = userEvent.setup()
      const props = renderInspector().props
      await user.click(screen.getByTestId("project-name"))
      await user.clear(screen.getByTestId("project-name-input"))
      await user.type(screen.getByTestId("project-name-input"), "Venus{Enter}")
      expect(props.onPatch).toHaveBeenCalledWith({ name: "Venus" })
    })

    it("changes status", async () => {
      const user = userEvent.setup()
      const props = renderInspector().props
      await user.click(screen.getByTestId("project-status"))
      await user.click(await screen.findByTestId("project-status-completed"))
      expect(props.onPatch).toHaveBeenCalledWith({ status: "completed" })
    })

    it("changes priority", async () => {
      const user = userEvent.setup()
      const props = renderInspector().props
      await user.click(screen.getByTestId("project-priority"))
      await user.click(await screen.findByTestId("project-priority-urgent"))
      expect(props.onPatch).toHaveBeenCalledWith({ priority: "urgent" })
    })

    it("sets a lead", async () => {
      const user = userEvent.setup()
      const props = renderInspector().props
      await user.click(screen.getByTestId("project-lead"))
      await user.type(screen.getByTestId("project-lead-input"), "Ada{Enter}")
      expect(props.onPatch).toHaveBeenCalledWith({ lead: { kind: "human", label: "Ada" } })
    })

    it("clears the lead when the field is emptied", async () => {
      const user = userEvent.setup()
      const props = renderInspector({
        project: project({ lead: { kind: "human", label: "Ada" } }),
      }).props
      await user.click(screen.getByTestId("project-lead"))
      await user.clear(screen.getByTestId("project-lead-input"))
      fireEvent.blur(screen.getByTestId("project-lead-input"))
      expect(props.onPatch).toHaveBeenCalledWith({ lead: null })
    })

    it("sets a target date as epoch milliseconds", () => {
      const props = renderInspector().props
      fireEvent.change(screen.getByTestId("project-target-date"), {
        target: { value: "2026-09-01" },
      })
      expect(props.onPatch).toHaveBeenCalledWith({
        targetDate: Date.parse("2026-09-01T00:00:00.000Z"),
      })
    })

    it("clears a date when the field is emptied", () => {
      const props = renderInspector({
        project: project({ startDate: Date.parse("2026-01-01T00:00:00.000Z") }),
      }).props
      fireEvent.change(screen.getByTestId("project-start-date"), { target: { value: "" } })
      expect(props.onPatch).toHaveBeenCalledWith({ startDate: null })
    })

    it("shows a stored date back in the picker", () => {
      renderInspector({ project: project({ targetDate: Date.parse("2026-09-01T00:00:00.000Z") }) })
      expect(screen.getByTestId("project-target-date")).toHaveValue("2026-09-01")
    })

    it("edits the description the container shares with agents", async () => {
      const user = userEvent.setup()
      const props = renderInspector().props
      await user.click(screen.getByTestId("project-description"))
      await user.type(screen.getByTestId("project-description-input"), "Context for agents")
      fireEvent.blur(screen.getByTestId("project-description-input"))
      expect(props.onPatch).toHaveBeenCalledWith({ description: "Context for agents" })
    })

    it("picks an icon from a fixed palette", async () => {
      const user = userEvent.setup()
      const props = renderInspector().props
      await user.click(screen.getByTestId("project-icon"))
      await user.click(await screen.findByTestId("project-icon-🚀"))
      expect(props.onPatch).toHaveBeenCalledWith({ icon: "🚀" })
    })
  })

  describe("key", () => {
    it("shows it read-only and says why", () => {
      renderInspector()
      expect(screen.getByText("MERC")).toBeInTheDocument()
      expect(screen.getByText("projects.keyImmutable")).toBeInTheDocument()
    })
  })

  describe("resources", () => {
    it("says so when there are none", () => {
      renderInspector()
      expect(screen.getByText("projects.noResources")).toBeInTheDocument()
    })

    it("lists a bound repo and a mounted root", () => {
      renderInspector({
        project: project({
          resources: [
            { kind: "github-repo", repoFullName: "o/r", addedAt: 0 },
            { kind: "workspace-root", rootId: "root-1", addedAt: 0 },
          ],
        }),
      })
      const list = screen.getByTestId("project-resources")
      expect(list).toHaveTextContent("o/r")
      expect(list).toHaveTextContent("root-1")
    })

    it("removes by index", () => {
      const props = renderInspector({
        project: project({
          resources: [{ kind: "github-repo", repoFullName: "o/r", addedAt: 0 }],
        }),
      }).props
      fireEvent.click(screen.getByTestId("project-resource-remove-0"))
      expect(props.onRemoveResource).toHaveBeenCalledWith(0)
    })

    it("adds", () => {
      const props = renderInspector().props
      fireEvent.click(screen.getByTestId("project-add-resource"))
      expect(props.onAddResource).toHaveBeenCalled()
    })
  })

  it("links through to the container's issues", () => {
    const props = renderInspector().props
    fireEvent.click(screen.getByTestId("project-open-issues"))
    expect(props.onOpenIssues).toHaveBeenCalled()
  })

  it("routes delete through a confirmation", () => {
    const props = renderInspector().props
    fireEvent.click(screen.getByTestId("project-delete"))
    expect(props.onRequestDelete).toHaveBeenCalled()
  })

  it("closes", () => {
    const props = renderInspector().props
    fireEvent.click(screen.getByTestId("project-inspector-close"))
    expect(props.onClose).toHaveBeenCalled()
  })

  it("measures progress against the denominator, not the raw total", () => {
    renderInspector({
      progress: { total: 5, completed: 1, canceled: 2, started: 2, denominator: 3, ratio: 1 / 3 },
    })
    expect(screen.getByText("projects.progressCount:1,3")).toBeInTheDocument()
  })
})
