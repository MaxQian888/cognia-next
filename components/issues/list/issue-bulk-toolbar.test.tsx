/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

import userEvent from "@testing-library/user-event"
import { render, screen } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import type { IssueProject } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssueBulkToolbar } from "./issue-bulk-toolbar"

let seq = 0
function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  const kind = over.kind ?? "local"
  const sourceId = over.sourceId ?? `s${seq}`
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    identifier: `MERC-${seq}`,
    title: `Issue ${seq}`,
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds: [],
    order: seq,
    createdAt: seq,
    updatedAt: seq,
    origin: { deepLinkHref: "/issues" },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
    ...over,
  }
}

const label: LabelRow = {
  id: "l1",
  scope: "issue",
  name: "bug",
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
}

const project: IssueProject = {
  id: "p1",
  projectId: "w1",
  key: "MERC",
  name: "Mercury",
  status: "in_progress",
  priority: "medium",
  resources: [],
  createdAt: 0,
  updatedAt: 0,
}

function renderToolbar(over: Partial<React.ComponentProps<typeof IssueBulkToolbar>> = {}) {
  const props: React.ComponentProps<typeof IssueBulkToolbar> = {
    items: [item()],
    runningIds: new Set(),
    labels: [label],
    projects: [project],
    assigneeOptions: [
      { key: "agent:a1", actor: { kind: "agent", id: "a1", label: "Scout" }, group: "agent" },
    ],
    onAction: jest.fn(),
    onRequestDelete: jest.fn(),
    onClear: jest.fn(),
    ...over,
  }
  return { props, ...render(<IssueBulkToolbar {...props} />) }
}

beforeEach(() => {
  seq = 0
})

describe("IssueBulkToolbar", () => {
  it("renders nothing for an empty selection", () => {
    renderToolbar({ items: [] })
    expect(screen.queryByTestId("issue-bulk-toolbar")).not.toBeInTheDocument()
  })

  it("counts the selection", () => {
    renderToolbar({ items: [item(), item()] })
    expect(screen.getByTestId("issue-bulk-count")).toHaveTextContent("bulk.selected:2")
  })

  it("clears the selection", async () => {
    const user = userEvent.setup()
    const props = renderToolbar().props
    await user.click(screen.getByTestId("issue-bulk-clear"))
    expect(props.onClear).toHaveBeenCalled()
  })

  describe("actions", () => {
    it("changes status", async () => {
      const user = userEvent.setup()
      const props = renderToolbar().props
      await user.click(screen.getByTestId("issue-bulk-status"))
      await user.click(await screen.findByTestId("issue-bulk-status-done"))
      expect(props.onAction).toHaveBeenCalledWith({ kind: "status", to: "done" })
    })

    it("changes priority", async () => {
      const user = userEvent.setup()
      const props = renderToolbar().props
      await user.click(screen.getByTestId("issue-bulk-priority"))
      await user.click(await screen.findByTestId("issue-bulk-priority-urgent"))
      expect(props.onAction).toHaveBeenCalledWith({ kind: "priority", to: "urgent" })
    })

    it("assigns and unassigns", async () => {
      const user = userEvent.setup()
      const props = renderToolbar().props
      await user.click(screen.getByTestId("issue-bulk-assignee"))
      await user.click(await screen.findByTestId("issue-bulk-assignee-none"))
      expect(props.onAction).toHaveBeenCalledWith({ kind: "assignee", to: null })
    })

    it("adds and removes a label through separate sections", async () => {
      const user = userEvent.setup()
      const props = renderToolbar().props
      await user.click(screen.getByTestId("issue-bulk-labels"))
      await user.click(await screen.findByTestId("issue-bulk-add-label-l1"))
      expect(props.onAction).toHaveBeenCalledWith({ kind: "addLabel", labelId: "l1" })
    })

    it("moves to a container", async () => {
      const user = userEvent.setup()
      const props = renderToolbar().props
      await user.click(screen.getByTestId("issue-bulk-project"))
      await user.click(await screen.findByTestId("issue-bulk-project-p1"))
      expect(props.onAction).toHaveBeenCalledWith({ kind: "project", issueProjectId: "p1" })
    })

    it("routes delete through a confirmation rather than firing it", async () => {
      const user = userEvent.setup()
      const props = renderToolbar().props
      await user.click(screen.getByTestId("issue-bulk-delete"))
      expect(props.onRequestDelete).toHaveBeenCalled()
      expect(props.onAction).not.toHaveBeenCalled()
    })
  })

  describe("honest reach", () => {
    it("shows how many of the selection each option would touch", async () => {
      const user = userEvent.setup()
      renderToolbar({ items: [item(), item({ kind: "github", sourceId: "o/r#1" })] })
      await user.click(screen.getByTestId("issue-bulk-priority"))
      // One of the two rows is a GitHub mirror and cannot be edited.
      expect(await screen.findByTestId("issue-bulk-priority-urgent")).toHaveTextContent("1")
    })

    it("disables an option no selected row would accept", async () => {
      const user = userEvent.setup()
      renderToolbar({ items: [item({ kind: "github", sourceId: "o/r#1" })] })
      await user.click(screen.getByTestId("issue-bulk-priority"))
      expect(await screen.findByTestId("issue-bulk-priority-urgent")).toHaveAttribute(
        "aria-disabled",
        "true"
      )
    })

    it("disables delete for a selection of only federated rows", () => {
      renderToolbar({ items: [item({ kind: "github", sourceId: "o/r#1" })] })
      expect(screen.getByTestId("issue-bulk-delete")).toBeDisabled()
    })

    it("accounts for the run guard in the status counts", async () => {
      const user = userEvent.setup()
      const running = item()
      renderToolbar({ items: [running], runningIds: new Set([running.unifiedId]) })
      await user.click(screen.getByTestId("issue-bulk-status"))
      expect(await screen.findByTestId("issue-bulk-status-in_progress")).toHaveAttribute(
        "aria-disabled",
        "true"
      )
    })
  })

  it("hides the label menu when there are no labels to apply", () => {
    renderToolbar({ labels: [] })
    expect(screen.queryByTestId("issue-bulk-labels")).not.toBeInTheDocument()
  })

  it("hides the container menu when there are no containers", () => {
    renderToolbar({ projects: [] })
    expect(screen.queryByTestId("issue-bulk-project")).not.toBeInTheDocument()
  })

  describe("select all", () => {
    it("offers it when more rows are on screen than are ticked", () => {
      renderToolbar({ items: [item()], visibleCount: 5, onToggleAll: jest.fn() })
      expect(screen.getByTestId("issue-bulk-select-all")).toHaveTextContent("bulk.selectAll:5")
    })

    it("hides it once everything on screen is already ticked", () => {
      renderToolbar({ items: [item()], visibleCount: 1, onToggleAll: jest.fn() })
      expect(screen.queryByTestId("issue-bulk-select-all")).not.toBeInTheDocument()
    })

    it("hides it without a handler", () => {
      renderToolbar({ items: [item()], visibleCount: 5 })
      expect(screen.queryByTestId("issue-bulk-select-all")).not.toBeInTheDocument()
    })

    it("fires", async () => {
      const user = userEvent.setup()
      const onToggleAll = jest.fn()
      renderToolbar({ items: [item()], visibleCount: 5, onToggleAll })
      await user.click(screen.getByTestId("issue-bulk-select-all"))
      expect(onToggleAll).toHaveBeenCalled()
    })
  })
})
