/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: false, durationScale: 1 }),
}))

// Capture DndContext's handlers so a drag can be simulated without a pointer.
let dndHandlers: Record<string, (event: unknown) => void> = {}
let dndAccessibility: {
  announcements?: Record<string, (event: unknown) => string | undefined>
  screenReaderInstructions?: { draggable?: string }
} = {}
let dndAutoScroll: unknown = undefined
let keyboardSensorOptions: Record<string, unknown> | undefined
const droppableCalls: Array<{ id: string; disabled?: boolean }> = []

jest.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, accessibility, autoScroll, ...handlers }: Record<string, unknown>) => {
    dndHandlers = handlers as Record<string, (event: unknown) => void>
    dndAccessibility = (accessibility ?? {}) as typeof dndAccessibility
    dndAutoScroll = autoScroll
    return <div data-testid="dnd-context">{children as React.ReactNode}</div>
  },
  DragOverlay: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="dnd-drag-overlay">{children}</div>
  ),
  PointerSensor: function PointerSensor() {},
  KeyboardSensor: function KeyboardSensor() {},
  closestCorners: jest.fn(),
  defaultDropAnimationSideEffects: jest.fn(() => jest.fn()),
  useSensor: jest.fn((sensor: unknown, options?: Record<string, unknown>) => {
    if ((sensor as { name?: string })?.name === "KeyboardSensor") keyboardSensorOptions = options
    return { sensor, options }
  }),
  useSensors: jest.fn(() => []),
  useDroppable: (args: { id: string; disabled?: boolean }) => {
    droppableCalls.push(args)
    return { setNodeRef: jest.fn(), isOver: false }
  },
}))
jest.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  verticalListSortingStrategy: jest.fn(),
  sortableKeyboardCoordinates: jest.fn(),
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

/** Force every column open, so a test can assert on full-column chrome. */
const ALL_EXPANDED: Partial<Record<IssueStatus, boolean>> = Object.fromEntries(
  ISSUE_STATUSES.map((status) => [status, false])
)

beforeEach(() => {
  seq = 0
  dndHandlers = {}
  dndAccessibility = {}
  dndAutoScroll = undefined
  keyboardSensorOptions = undefined
  droppableCalls.length = 0
})

describe("IssueBoard", () => {
  describe("columns", () => {
    it("renders every column even when the board is empty", () => {
      render(<IssueBoard items={[]} />)
      for (const status of ISSUE_STATUSES) {
        expect(screen.getByTestId(`issue-column-${status}`)).toBeInTheDocument()
      }
    })

    it("routes each card to its own column and counts it", () => {
      render(<IssueBoard items={[item({ status: "done" }), item({ status: "todo" })]} />)
      expect(screen.getByTestId("issue-column-done")).toHaveTextContent("MERC-1")
      expect(screen.getByTestId("issue-column-todo")).toHaveTextContent("MERC-2")
    })

    it("shows a per-column empty state once a column is explicitly expanded", () => {
      render(<IssueBoard items={[]} columnCollapse={ALL_EXPANDED} />)
      expect(screen.getAllByText("board.empty")).toHaveLength(ISSUE_STATUSES.length)
    })

    it("renders an add button per column only when a handler is given", () => {
      const { rerender } = render(<IssueBoard items={[item({ status: "todo" })]} />)
      expect(screen.queryByTestId("issue-column-add-todo")).not.toBeInTheDocument()

      const onAddIssue = jest.fn()
      rerender(<IssueBoard items={[item({ status: "todo" })]} onAddIssue={onAddIssue} />)
      fireEvent.click(screen.getByTestId("issue-column-add-todo"))
      expect(onAddIssue).toHaveBeenCalledWith("todo")
    })
  })

  describe("collapse", () => {
    it("collapses an empty column by default", () => {
      render(<IssueBoard items={[item({ status: "todo" })]} />)
      expect(screen.getByTestId("issue-column-done")).toHaveAttribute("data-collapsed", "true")
      expect(screen.getByTestId("issue-column-todo")).not.toHaveAttribute("data-collapsed")
    })

    it("keeps a collapsed column droppable, so no transition disappears", () => {
      render(<IssueBoard items={[item({ status: "todo" })]} />)
      expect(droppableCalls.map((call) => call.id)).toEqual(
        expect.arrayContaining(ISSUE_STATUSES.map((status) => `col:${status}`))
      )
    })

    it("honours an explicit collapse on a populated column", () => {
      render(<IssueBoard items={[item({ status: "todo" })]} columnCollapse={{ todo: true }} />)
      expect(screen.getByTestId("issue-column-todo")).toHaveAttribute("data-collapsed", "true")
    })

    it("reports the column's item count when toggled, so the flip is relative to what is shown", () => {
      const onToggle = jest.fn()
      render(
        <IssueBoard
          items={[item({ status: "todo" }), item({ status: "todo" })]}
          onToggleColumnCollapsed={onToggle}
        />
      )
      fireEvent.click(screen.getByTestId("issue-column-collapse-todo"))
      expect(onToggle).toHaveBeenCalledWith("todo", 2)
    })

    it("expands from the collapsed strip", () => {
      const onToggle = jest.fn()
      render(<IssueBoard items={[]} onToggleColumnCollapsed={onToggle} />)
      fireEvent.click(screen.getByTestId("issue-column-expand-done"))
      expect(onToggle).toHaveBeenCalledWith("done", 0)
    })

    it("offers no collapse control without a handler", () => {
      render(<IssueBoard items={[item({ status: "todo" })]} />)
      expect(screen.queryByTestId("issue-column-collapse-todo")).not.toBeInTheDocument()
    })
  })

  describe("drag legality", () => {
    it("leaves every column droppable when nothing is being dragged", () => {
      render(<IssueBoard items={[item()]} />)
      expect(droppableCalls.every((call) => call.disabled === false)).toBe(true)
    })

    it("dims nothing for a local card at rest, which may go anywhere", () => {
      const card = item({ status: "todo" })
      render(<IssueBoard items={[card]} />)
      act(() => dndHandlers.onDragStart?.({ active: { id: card.unifiedId } }))
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
  })

  describe("drop", () => {
    it("emits a move when a card is dropped on another column", () => {
      const onDrop = jest.fn()
      const card = item({ status: "todo" })
      render(<IssueBoard items={[card]} onDrop={onDrop} />)
      act(() =>
        dndHandlers.onDragEnd?.({ active: { id: card.unifiedId }, over: { id: "col:done" } })
      )
      expect(onDrop).toHaveBeenCalledWith({ type: "move", unifiedId: card.unifiedId, to: "done" })
    })

    it("emits a denial for a federated card rather than silently dropping it", () => {
      const onDrop = jest.fn()
      const card = item({ kind: "github", status: "todo" })
      render(<IssueBoard items={[card]} onDrop={onDrop} />)
      act(() =>
        dndHandlers.onDragEnd?.({ active: { id: card.unifiedId }, over: { id: "col:done" } })
      )
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

    it("consults the run guard at drop time, not just at drag start", () => {
      const onDrop = jest.fn()
      const card = item({ status: "todo" })
      render(<IssueBoard items={[card]} runningIds={new Set([card.unifiedId])} onDrop={onDrop} />)
      act(() => dndHandlers.onDragStart?.({ active: { id: card.unifiedId } }))
      act(() =>
        dndHandlers.onDragEnd?.({ active: { id: card.unifiedId }, over: { id: "col:in_progress" } })
      )
      expect(onDrop).toHaveBeenCalledWith({
        type: "denied",
        unifiedId: card.unifiedId,
        reason: "runtime-owned",
      })
    })
  })

  describe("drag overlay", () => {
    it("renders no clone until a drag starts", () => {
      render(<IssueBoard items={[item()]} />)
      expect(screen.queryByTestId("issue-drag-overlay")).not.toBeInTheDocument()
    })

    it("renders the dragged card as a clone", () => {
      const card = item({ status: "todo" })
      render(<IssueBoard items={[card]} />)
      act(() => dndHandlers.onDragStart?.({ active: { id: card.unifiedId } }))
      expect(screen.getByTestId("issue-drag-overlay")).toHaveTextContent("MERC-1")
    })

    it("portals the clone out of the board's scroll containers", () => {
      const card = item({ status: "todo" })
      render(<IssueBoard items={[card]} />)
      act(() => dndHandlers.onDragStart?.({ active: { id: card.unifiedId } }))
      const overlay = screen.getByTestId("issue-drag-overlay")
      expect(screen.getByTestId("issue-board").contains(overlay)).toBe(false)
    })

    it("drops the clone again when the drag ends", () => {
      const card = item({ status: "todo" })
      render(<IssueBoard items={[card]} />)
      act(() => dndHandlers.onDragStart?.({ active: { id: card.unifiedId } }))
      act(() => dndHandlers.onDragEnd?.({ active: { id: card.unifiedId }, over: null }))
      expect(screen.queryByTestId("issue-drag-overlay")).not.toBeInTheDocument()
    })
  })

  describe("insertion indicator", () => {
    it("draws no indicator before a drag starts", () => {
      render(<IssueBoard items={[item({ status: "todo" })]} />)
      expect(screen.queryByTestId("issue-drop-indicator-done")).not.toBeInTheDocument()
    })

    it("marks the landing spot in the target column", () => {
      const card = item({ status: "todo" })
      render(<IssueBoard items={[card]} />)
      act(() => dndHandlers.onDragStart?.({ active: { id: card.unifiedId } }))
      act(() => dndHandlers.onDragOver?.({ over: { id: "col:done" } }))
      expect(screen.getByTestId("issue-drop-indicator-done")).toBeInTheDocument()
    })

    it("leaves a same-column reorder to the sortable gap", () => {
      const a = item({ status: "todo", order: 0 })
      const b = item({ status: "todo", order: 1 })
      render(<IssueBoard items={[a, b]} />)
      act(() => dndHandlers.onDragStart?.({ active: { id: a.unifiedId } }))
      act(() => dndHandlers.onDragOver?.({ over: { id: b.unifiedId } }))
      expect(screen.queryByTestId("issue-drop-indicator-todo")).not.toBeInTheDocument()
    })

    it("draws nothing over a column that would refuse the drop", () => {
      const card = item({ status: "todo" })
      render(<IssueBoard items={[card]} runningIds={new Set([card.unifiedId])} />)
      act(() => dndHandlers.onDragStart?.({ active: { id: card.unifiedId } }))
      act(() => dndHandlers.onDragOver?.({ over: { id: "col:in_progress" } }))
      expect(screen.queryByTestId("issue-drop-indicator-in_progress")).not.toBeInTheDocument()
    })

    it("marks a collapsed strip too, since an empty column is the usual target", () => {
      const card = item({ status: "todo" })
      render(<IssueBoard items={[card]} />)
      act(() => dndHandlers.onDragStart?.({ active: { id: card.unifiedId } }))
      act(() => dndHandlers.onDragOver?.({ over: { id: "col:done" } }))
      const indicator = screen.getByTestId("issue-drop-indicator-done")
      expect(screen.getByTestId("issue-column-done")).toHaveAttribute("data-collapsed", "true")
      expect(screen.getByTestId("issue-column-done").contains(indicator)).toBe(true)
    })

    it("clears the indicator when the pointer leaves every target", () => {
      const card = item({ status: "todo" })
      render(<IssueBoard items={[card]} />)
      act(() => dndHandlers.onDragStart?.({ active: { id: card.unifiedId } }))
      act(() => dndHandlers.onDragOver?.({ over: { id: "col:done" } }))
      act(() => dndHandlers.onDragOver?.({ over: null }))
      expect(screen.queryByTestId("issue-drop-indicator-done")).not.toBeInTheDocument()
    })
  })

  describe("accessibility", () => {
    it("localizes the screen-reader instructions instead of using dnd-kit's English default", () => {
      render(<IssueBoard items={[item()]} />)
      expect(dndAccessibility.screenReaderInstructions?.draggable).toBe("board.dnd.instructions")
    })

    it("announces a pick-up with the issue and its column", () => {
      const card = item({ status: "todo" })
      render(<IssueBoard items={[card]} />)
      expect(
        dndAccessibility.announcements?.onDragStart?.({ active: { id: card.unifiedId } })
      ).toBe("board.dnd.pickedUp:MERC-1,status.todo")
    })

    it("announces the landing position while dragging over a column", () => {
      const card = item({ status: "todo" })
      render(<IssueBoard items={[card]} />)
      expect(
        dndAccessibility.announcements?.onDragOver?.({
          active: { id: card.unifiedId },
          over: { id: "col:done" },
        })
      ).toBe("board.dnd.over:MERC-1,status.done,1,1")
    })

    it("announces a refusal rather than going silent", () => {
      const card = item({ kind: "github", status: "todo" })
      render(<IssueBoard items={[card]} />)
      expect(
        dndAccessibility.announcements?.onDragOver?.({
          active: { id: card.unifiedId },
          over: { id: "col:done" },
        })
      ).toBe("board.dnd.denied:MERC-1")
    })

    it("announces a cancel", () => {
      const card = item({ status: "todo" })
      render(<IssueBoard items={[card]} />)
      expect(
        dndAccessibility.announcements?.onDragCancel?.({ active: { id: card.unifiedId } })
      ).toBe("board.dnd.cancelled:MERC-1,status.todo")
    })
  })

  describe("auto-scroll", () => {
    it("pins dnd-kit's horizontal threshold to zero so it cannot fight the board's own edge scroll", () => {
      render(<IssueBoard items={[item()]} />)
      expect(dndAutoScroll).toEqual({ threshold: { x: 0, y: 0.2 } })
    })
  })

  describe("keyboard", () => {
    it("leaves Enter free to open a card by claiming only Space for dragging", () => {
      render(<IssueBoard items={[item()]} />)
      expect(keyboardSensorOptions?.keyboardCodes).toEqual({
        start: ["Space"],
        cancel: ["Escape"],
        end: ["Space"],
      })
    })
  })

  it("forwards selection", () => {
    const onSelect = jest.fn()
    const card = item()
    render(<IssueBoard items={[card]} onSelect={onSelect} selectedId={card.unifiedId} />)
    fireEvent.click(screen.getByTestId(`issue-card-${card.unifiedId}`))
    expect(onSelect).toHaveBeenCalledWith(card.unifiedId)
  })

  it("marks a running card so the board shows what the runtime is holding", () => {
    const card = item({ status: "todo" })
    render(<IssueBoard items={[card]} runningIds={new Set([card.unifiedId])} />)
    expect(screen.getByTestId(`issue-card-running-${card.unifiedId}`)).toBeInTheDocument()
  })
})
