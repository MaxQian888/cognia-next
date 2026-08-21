/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

const mockUseSortable = jest.fn()
jest.mock("@dnd-kit/sortable", () => ({
  useSortable: (...args: unknown[]) => mockUseSortable(...args),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { IssueCard } from "./issue-card"

function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  const kind = over.kind ?? "local"
  return {
    unifiedId: `${kind}:i1`,
    kind,
    sourceId: "i1",
    identifier: "MERC-1",
    title: "Ship the board",
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    origin: { deepLinkHref: "/issues?id=i1" },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
    ...over,
  }
}

beforeEach(() => {
  mockUseSortable.mockReturnValue({
    attributes: {},
    listeners: {},
    setNodeRef: jest.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  })
})

describe("IssueCard", () => {
  it("renders the identifier, title and status glyph", () => {
    render(<IssueCard item={item()} />)
    expect(screen.getByText("MERC-1")).toBeInTheDocument()
    expect(screen.getByText("Ship the board")).toBeInTheDocument()
    expect(screen.getByTestId("issue-status-icon-todo")).toBeInTheDocument()
  })

  it("hides the priority glyph when there is no priority", () => {
    render(<IssueCard item={item()} />)
    expect(screen.queryByTestId("issue-priority-icon-none")).not.toBeInTheDocument()
  })

  it("shows the priority glyph once one is set", () => {
    render(<IssueCard item={item({ priority: "urgent" })} />)
    expect(screen.getByTestId("issue-priority-icon-urgent")).toBeInTheDocument()
  })

  it("labels an unassigned card explicitly rather than leaving it blank", () => {
    render(<IssueCard item={item()} />)
    expect(screen.getByTestId("issue-card-assignee-none")).toHaveTextContent("actor.unassigned")
  })

  it("prefers the assignee's cached display name over its kind", () => {
    render(<IssueCard item={item({ assignee: { kind: "agent", id: "a1", label: "Scout" } })} />)
    expect(screen.getByTestId("issue-card-assignee-agent:a1")).toHaveTextContent("Scout")
  })

  it("renders the project chip only when the caller resolved a name", () => {
    const { rerender } = render(<IssueCard item={item({ issueProjectId: "p1" })} />)
    expect(screen.queryByText("Mercury")).not.toBeInTheDocument()
    rerender(<IssueCard item={item({ issueProjectId: "p1" })} projectName="Mercury" />)
    expect(screen.getByText("Mercury")).toBeInTheDocument()
  })

  it("badges a federated row with its source and does not badge a local one", () => {
    const { rerender } = render(<IssueCard item={item()} />)
    expect(screen.queryByText("source.github")).not.toBeInTheDocument()
    rerender(<IssueCard item={item({ kind: "github" })} />)
    expect(screen.getByText("source.github")).toBeInTheDocument()
  })

  it("disables dragging for a federated row — capabilities are the only gate", () => {
    render(<IssueCard item={item({ kind: "github" })} />)
    expect(mockUseSortable).toHaveBeenCalledWith(
      expect.objectContaining({ id: "github:i1", disabled: true })
    )
  })

  it("enables dragging for a local row", () => {
    render(<IssueCard item={item()} />)
    expect(mockUseSortable).toHaveBeenCalledWith(
      expect.objectContaining({ id: "local:i1", disabled: false })
    )
  })

  it("selects on click and on Enter", () => {
    const onSelect = jest.fn()
    render(<IssueCard item={item()} onSelect={onSelect} />)
    const card = screen.getByTestId("issue-card-local:i1")

    fireEvent.click(card)
    fireEvent.keyDown(card, { key: "Enter" })
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(onSelect).toHaveBeenCalledWith("local:i1")
  })

  it("leaves Space to the keyboard drag sensor rather than selecting", () => {
    // The board narrows dnd-kit's keyboard activator to Space alone so Enter
    // can open a card; if Space also selected, a keyboard user could never
    // start a drag without also opening the inspector.
    const onSelect = jest.fn()
    render(<IssueCard item={item()} onSelect={onSelect} />)
    fireEvent.keyDown(screen.getByTestId("issue-card-local:i1"), { key: " " })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("defers to the sensor's own key handler before acting on Enter", () => {
    const onSelect = jest.fn()
    const onKeyDown = jest.fn((event: { preventDefault: () => void }) => event.preventDefault())
    mockUseSortable.mockReturnValueOnce({
      attributes: {},
      listeners: { onKeyDown },
      setNodeRef: jest.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    })
    render(<IssueCard item={item()} onSelect={onSelect} />)
    fireEvent.keyDown(screen.getByTestId("issue-card-local:i1"), { key: "Enter" })
    expect(onKeyDown).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("marks a running card", () => {
    render(<IssueCard item={item()} running />)
    expect(screen.getByTestId("issue-card-running-local:i1")).toBeInTheDocument()
  })

  it("leaves an idle card unmarked", () => {
    render(<IssueCard item={item()} />)
    expect(screen.queryByTestId("issue-card-running-local:i1")).not.toBeInTheDocument()
  })

  it("ignores unrelated keys", () => {
    const onSelect = jest.fn()
    render(<IssueCard item={item()} onSelect={onSelect} />)
    fireEvent.keyDown(screen.getByTestId("issue-card-local:i1"), { key: "a" })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("exposes selection state to assistive tech", () => {
    render(<IssueCard item={item()} selected />)
    expect(screen.getByTestId("issue-card-local:i1")).toHaveAttribute("aria-pressed", "true")
  })

  it("renders resolved labels", () => {
    render(
      <IssueCard
        item={item({ labelIds: ["l1"] })}
        labels={[
          { id: "l1", scope: "issue", name: "bug", sortOrder: 0, createdAt: 0, updatedAt: 0 },
        ]}
      />
    )
    expect(screen.getByTestId("label-chip-l1")).toBeInTheDocument()
  })

  it("marks itself while dragging so the board can dim it", () => {
    mockUseSortable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: jest.fn(),
      transform: null,
      transition: undefined,
      isDragging: true,
    })
    render(<IssueCard item={item()} />)
    expect(screen.getByTestId("issue-card-local:i1")).toHaveAttribute("data-dragging", "true")
  })
})
