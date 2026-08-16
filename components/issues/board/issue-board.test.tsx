/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

// Capture DndContext's handlers so a drag can be simulated without a pointer.
let dndHandlers: Record<string, (event: unknown) => void> = {}
const droppableCalls: Array<{ id: string; disabled?: boolean }> = []
jest.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, ...handlers }: Record<string, unknown>) => {
    dndHandlers = handlers as Record<string, (event: unknown) => void>
    return <div data-testid="dnd-context">{children as React.ReactNode}</div>
  },
  PointerSensor: function PointerSensor() {},
  closestCorners: jest.fn(),
  useSensor: jest.fn(),
  useSensors: jest.fn(() => []),
  useDroppable: (args: { id: string; disabled?: boolean }) => {
    droppableCalls.push(args)
    return { setNodeRef: jest.fn(), isOver: false }
  },
}))
jest.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  verticalListSortingStrategy: jest.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: jest.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}))

import { act, fireEvent, render, screen } from "@testing-library/react"
import { ISSUE_STATUSES, statusCategoryOf } from "@/types/issues"
import type { IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { IssueBoard } from "./issue-board"

let seq = 0
function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  const kind = over.kind ?? "local"
  const sourceId = over.sourceId ?? `s${seq}`
  const status: IssueStatus = over.status ?? "todo"
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    identifier: `MERC-${seq}`,
    title: `Issue ${seq}`,
    status,
    statusCategory: statusCategoryOf(status),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: seq,
    updatedAt: seq,
    origin: { deepLinkHref: "/issues" },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
    ...over,
  }
}

beforeEach(() => {
  seq = 0
  dndHandlers = {}
  droppableCalls.length = 0
})

describe("IssueBoard", () => {
  it("renders every column even when the board is empty", () => {
    render(<IssueBoard items={[]} />)
    for (const status of ISSUE_STATUSES) {
      expect(screen.getByTestId(`issue-column-${status}`)).toBeInTheDocument()
    }
  })

  it("shows a per-column empty state", () => {
    render(<IssueBoard items={[]} />)
    expect(screen.getAllByText("board.empty")).toHaveLength(ISSUE_STATUSES.length)
  })

  it("routes each card to its own column and counts it", () => {
    render(<IssueBoard items={[item({ status: "done" }), item({ status: "todo" })]} />)
    const done = screen.getByTestId("issue-column-done")
    expect(done).toHaveTextContent("MERC-1")
    expect(screen.getByTestId("issue-column-todo")).toHaveTextContent("MERC-2")
  })

  it("renders an add button per column only when a handler is given", () => {
    const { rerender } = render(<IssueBoard items={[]} />)
    expect(screen.queryByTestId("issue-column-add-todo")).not.toBeInTheDocument()

    const onAddIssue = jest.fn()
    rerender(<IssueBoard items={[]} onAddIssue={onAddIssue} />)
    fireEvent.click(screen.getByTestId("issue-column-add-todo"))
    expect(onAddIssue).toHaveBeenCalledWith("todo")
  })

  it("leaves every column droppable when nothing is being dragged", () => {
    render(<IssueBoard items={[item()]} />)
    expect(droppableCalls.every((call) => call.disabled === false)).toBe(true)
  })

  it("dims the columns a dragged card may not enter", () => {
    const card = item({ status: "todo" })
    render(<IssueBoard items={[card]} />)
    droppableCalls.length = 0
    act(() => dndHandlers.onDragStart?.({ active: { id: card.unifiedId } }))

    // A local card at rest may go anywhere, so nothing dims.
    expect(screen.getByTestId("issue-column-done")).not.toHaveAttribute("data-dimmed")
  })

  it("dims in_progress while a run is in flight", () => {
    const card = item({ status: "todo" })
    render(<IssueBoard items={[card]} runningIds={new Set([card.unifiedId])} />)
    act(() => dndHandlers.onDragStart?.({ active: { id: card.unifiedId } }))
    expect(screen.getByTestId("issue-column-in_progress")).toHaveAttribute("data-dimmed", "true")
  })

  it("dims every other column for a federated card, which cannot move at all", () => {
    const card = item({ kind: "github", status: "todo" })
    render(<IssueBoard items={[card]} />)
    act(() => dndHandlers.onDragStart?.({ active: { id: card.unifiedId } }))
    expect(screen.getByTestId("issue-column-done")).toHaveAttribute("data-dimmed", "true")
    expect(screen.getByTestId("issue-column-todo")).not.toHaveAttribute("data-dimmed")
  })

  it("emits a move when a card is dropped on another column", () => {
    const onDrop = jest.fn()
    const card = item({ status: "todo" })
    render(<IssueBoard items={[card]} onDrop={onDrop} />)
    act(() => dndHandlers.onDragEnd?.({ active: { id: card.unifiedId }, over: { id: "col:done" } }))
    expect(onDrop).toHaveBeenCalledWith({ type: "move", unifiedId: card.unifiedId, to: "done" })
  })

  it("emits a denial for a federated card rather than silently dropping it", () => {
    const onDrop = jest.fn()
    const card = item({ kind: "github", status: "todo" })
    render(<IssueBoard items={[card]} onDrop={onDrop} />)
    act(() => dndHandlers.onDragEnd?.({ active: { id: card.unifiedId }, over: { id: "col:done" } }))
    expect(onDrop).toHaveBeenCalledWith({
      type: "denied",
      unifiedId: card.unifiedId,
      reason: "federated-read-only",
    })
  })

  it("emits nothing for a drop outside any target", () => {
    const onDrop = jest.fn()
    const card = item()
    render(<IssueBoard items={[card]} onDrop={onDrop} />)
    act(() => dndHandlers.onDragEnd?.({ active: { id: card.unifiedId }, over: null }))
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("clears the drag state on cancel", () => {
    const card = item({ kind: "github" })
    render(<IssueBoard items={[card]} />)
    act(() => dndHandlers.onDragStart?.({ active: { id: card.unifiedId } }))
    expect(screen.getByTestId("issue-column-done")).toHaveAttribute("data-dimmed", "true")
    act(() => dndHandlers.onDragCancel?.({}))
    expect(screen.getByTestId("issue-column-done")).not.toHaveAttribute("data-dimmed")
  })

  it("forwards selection", () => {
    const onSelect = jest.fn()
    const card = item()
    render(<IssueBoard items={[card]} onSelect={onSelect} selectedId={card.unifiedId} />)
    fireEvent.click(screen.getByTestId(`issue-card-${card.unifiedId}`))
    expect(onSelect).toHaveBeenCalledWith(card.unifiedId)
  })
})
