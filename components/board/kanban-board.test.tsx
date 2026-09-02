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
let dndSensors: unknown = undefined
let keyboardSensorOptions: Record<string, unknown> | undefined
const droppableCalls: Array<{ id: string; disabled?: boolean }> = []

jest.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, accessibility, sensors, ...handlers }: Record<string, unknown>) => {
    dndHandlers = handlers as Record<string, (event: unknown) => void>
    dndAccessibility = (accessibility ?? {}) as typeof dndAccessibility
    dndSensors = sensors
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
  useSensors: jest.fn(() => ["pointer", "keyboard"]),
  useDroppable: (args: { id: string; disabled?: boolean }) => {
    droppableCalls.push(args)
    return { setNodeRef: jest.fn(), isOver: false }
  },
}))
const mockSortableKeyboardCoordinates = jest.fn()
jest.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  verticalListSortingStrategy: jest.fn(),
  sortableKeyboardCoordinates: (...a: unknown[]) => mockSortableKeyboardCoordinates(...a),
}))

import { act, fireEvent, render, screen } from "@testing-library/react"
import { KanbanBoard, type KanbanBoardProps } from "./kanban-board"

type Lane = "todo" | "doing" | "done"
interface Card {
  id: string
  name: string
  lane: Lane
}

const LANES: Lane[] = ["todo", "doing", "done"]

function columnsOf(cards: readonly Card[]) {
  return LANES.map((lane) => ({ id: lane, items: cards.filter((card) => card.lane === lane) }))
}

function renderBoard(cards: readonly Card[], over: Partial<KanbanBoardProps<Lane, Card>> = {}) {
  const props: KanbanBoardProps<Lane, Card> = {
    columns: columnsOf(cards),
    itemId: (card) => card.id,
    itemLabel: (card) => card.name,
    columnLabel: (lane) => `L:${lane}`,
    dropId: (lane) => `col:${lane}`,
    renderCard: (card) => <div data-testid={`card-${card.id}`}>{card.name}</div>,
    testId: "board",
    testIdPrefix: "k",
    ...over,
  }
  return render(<KanbanBoard<Lane, Card> {...props} />)
}

const A: Card = { id: "a", name: "Alpha", lane: "todo" }
const B: Card = { id: "b", name: "Beta", lane: "todo" }
const C: Card = { id: "c", name: "Gamma", lane: "done" }

beforeEach(() => {
  dndHandlers = {}
  dndAccessibility = {}
  dndSensors = undefined
  keyboardSensorOptions = undefined
  droppableCalls.length = 0
  mockSortableKeyboardCoordinates.mockReset()
})

describe("KanbanBoard", () => {
  describe("columns", () => {
    it("renders every column with its label, count and cards", () => {
      renderBoard([A, B, C])
      for (const lane of LANES) {
        expect(screen.getByTestId(`k-column-${lane}`)).toHaveAttribute("aria-label", `L:${lane}`)
      }
      expect(screen.getByTestId("k-column-todo-count")).toHaveTextContent("2")
      expect(screen.getByTestId("k-column-todo")).toContainElement(screen.getByTestId("card-a"))
      expect(screen.getByTestId("k-column-done")).toContainElement(screen.getByTestId("card-c"))
    })

    it("registers one droppable per column, enabled at rest", () => {
      renderBoard([A])
      expect(droppableCalls).toEqual(
        expect.arrayContaining(LANES.map((lane) => ({ id: `col:${lane}`, disabled: false })))
      )
    })

    it("lets the consumer replace the header label and add an icon", () => {
      renderBoard([A], {
        renderColumnIcon: (column) => <i data-testid={`icon-${column.id}`} />,
        renderColumnHeader: (column) => <b data-testid={`head-${column.id}`}>{column.id}</b>,
      })
      expect(screen.getByTestId("icon-todo")).toBeInTheDocument()
      expect(screen.getByTestId("head-todo")).toHaveTextContent("todo")
    })

    it("wraps each card in the item menu when one is supplied", () => {
      renderBoard([A, B], {
        renderItemMenu: (card, children) => <div data-testid={`menu-${card.id}`}>{children}</div>,
      })
      expect(screen.getByTestId("menu-a")).toContainElement(screen.getByTestId("card-a"))
      expect(screen.getByTestId("menu-b")).toBeInTheDocument()
    })

    it("keys the cards itself, so neither path is a React key warning", () => {
      const warn = jest.spyOn(console, "error").mockImplementation(() => undefined)
      renderBoard([A, B])
      renderBoard([A, B], { renderItemMenu: (_card, children) => <div>{children}</div> })
      expect(warn.mock.calls.flat().join(" ")).not.toContain('unique "key"')
      warn.mockRestore()
    })
  })

  describe("empty state", () => {
    it("shows the per-column text in an empty column, from the shared namespace by default", () => {
      renderBoard([A])
      expect(screen.getAllByText("emptyColumn")).toHaveLength(2)
    })

    it("takes a consumer-supplied per-column text", () => {
      renderBoard([A], { emptyText: "nothing" })
      expect(screen.getAllByText("nothing")).toHaveLength(2)
    })

    it("replaces the whole strip with the board-level empty state when every column is empty", () => {
      renderBoard([], { emptyState: <div data-testid="board-empty" /> })
      expect(screen.getByTestId("board-empty")).toBeInTheDocument()
      expect(screen.queryByTestId("board")).not.toBeInTheDocument()
    })

    it("keeps the columns when at least one card exists", () => {
      renderBoard([A], { emptyState: <div data-testid="board-empty" /> })
      expect(screen.queryByTestId("board-empty")).not.toBeInTheDocument()
      expect(screen.getByTestId("board")).toBeInTheDocument()
    })
  })

  describe("collapse", () => {
    it("renders a droppable strip for a collapsed column, with the count still visible", () => {
      renderBoard([A, B], { isCollapsed: (column) => column.id === "todo" })
      const column = screen.getByTestId("k-column-todo")
      expect(column).toHaveAttribute("data-collapsed", "true")
      expect(screen.queryByTestId("card-a")).not.toBeInTheDocument()
      expect(screen.getByTestId("k-column-todo-count")).toHaveTextContent("2")
      expect(droppableCalls).toContainEqual({ id: "col:todo", disabled: false })
    })

    it("reports the column's item count when toggled from either side", () => {
      const onToggleCollapsed = jest.fn()
      renderBoard([A, B], {
        isCollapsed: (column) => column.id === "done",
        onToggleCollapsed,
      })
      fireEvent.click(screen.getByTestId("k-column-collapse-todo"))
      expect(onToggleCollapsed).toHaveBeenCalledWith("todo", 2)
      fireEvent.click(screen.getByTestId("k-column-expand-done"))
      expect(onToggleCollapsed).toHaveBeenCalledWith("done", 0)
    })

    it("offers no collapse control without a handler", () => {
      renderBoard([A])
      expect(screen.queryByTestId("k-column-collapse-todo")).not.toBeInTheDocument()
    })
  })

  describe("add", () => {
    it("renders an add button per column only when a handler is given", () => {
      const onAddItem = jest.fn()
      const { rerender } = render(
        <KanbanBoard<Lane, Card>
          columns={columnsOf([A])}
          itemId={(card) => card.id}
          itemLabel={(card) => card.name}
          columnLabel={(lane) => lane}
          dropId={(lane) => `col:${lane}`}
          renderCard={() => null}
          testId="board"
          testIdPrefix="k"
        />
      )
      expect(screen.queryByTestId("k-column-add-todo")).not.toBeInTheDocument()
      rerender(
        <KanbanBoard<Lane, Card>
          columns={columnsOf([A])}
          itemId={(card) => card.id}
          itemLabel={(card) => card.name}
          columnLabel={(lane) => lane}
          dropId={(lane) => `col:${lane}`}
          renderCard={() => null}
          onAddItem={onAddItem}
          testId="board"
          testIdPrefix="k"
        />
      )
      fireEvent.click(screen.getByTestId("k-column-add-doing"))
      expect(onAddItem).toHaveBeenCalledWith("doing")
    })
  })

  describe("drag and drop", () => {
    it("hands the raw ids to the consumer on drop", () => {
      const onDrop = jest.fn()
      renderBoard([A], { onDrop })
      act(() => dndHandlers.onDragStart?.({ active: { id: "a" } }))
      act(() => dndHandlers.onDragEnd?.({ active: { id: "a" }, over: { id: "col:done" } }))
      expect(onDrop).toHaveBeenCalledWith("a", "col:done")
    })

    it("reports a drop outside any target as null", () => {
      const onDrop = jest.fn()
      renderBoard([A], { onDrop })
      act(() => dndHandlers.onDragEnd?.({ active: { id: "a" }, over: null }))
      expect(onDrop).toHaveBeenCalledWith("a", null)
    })

    it("dims and disables the columns the consumer refuses while a drag is in flight", () => {
      renderBoard([A], {
        isDimmed: (column, drag) => drag.activeItem !== null && column.id === "done",
      })
      expect(screen.getByTestId("k-column-done")).not.toHaveAttribute("data-dimmed")
      droppableCalls.length = 0
      act(() => dndHandlers.onDragStart?.({ active: { id: "a" } }))
      expect(screen.getByTestId("k-column-done")).toHaveAttribute("data-dimmed", "true")
      expect(droppableCalls).toContainEqual({ id: "col:done", disabled: true })
      act(() => dndHandlers.onDragCancel?.({}))
      expect(screen.getByTestId("k-column-done")).not.toHaveAttribute("data-dimmed")
    })

    it("draws the insertion indicator where the consumer says, including on a strip", () => {
      renderBoard([A, B, C], {
        isCollapsed: (column) => column.id === "doing",
        insertionIndex: (column, drag) => {
          if (drag.overId === `col:${column.id}` && column.id !== "todo") return 0
          return null
        },
      })
      act(() => dndHandlers.onDragStart?.({ active: { id: "a" } }))
      act(() => dndHandlers.onDragOver?.({ over: { id: "col:done" } }))
      const body = screen.getByTestId("k-drop-indicator-done").parentElement!
      const rendered = Array.from(body.children).map((node) => node.getAttribute("data-testid"))
      expect(rendered).toEqual(["k-drop-indicator-done", "card-c"])
      act(() => dndHandlers.onDragOver?.({ over: { id: "col:doing" } }))
      expect(screen.getByTestId("k-column-doing")).toContainElement(
        screen.getByTestId("k-drop-indicator-doing")
      )
      act(() => dndHandlers.onDragOver?.({ over: null }))
      expect(screen.queryByTestId("k-drop-indicator-doing")).not.toBeInTheDocument()
    })

    it("hands the drag disabled board no sensors and disables every droppable", () => {
      renderBoard([A], { dragDisabled: true })
      expect(dndSensors).toEqual([])
      expect(droppableCalls.every((call) => call.disabled === true)).toBe(true)
    })
  })

  describe("drag overlay", () => {
    it("portals the consumer's clone out of the scroller while a drag is in flight", () => {
      renderBoard([A], { renderOverlay: (card) => <div data-testid="clone">{card.name}</div> })
      expect(screen.queryByTestId("clone")).not.toBeInTheDocument()
      act(() => dndHandlers.onDragStart?.({ active: { id: "a" } }))
      const clone = screen.getByTestId("clone")
      expect(clone).toHaveTextContent("Alpha")
      expect(screen.getByTestId("board").contains(clone)).toBe(false)
      act(() => dndHandlers.onDragEnd?.({ active: { id: "a" }, over: null }))
      expect(screen.queryByTestId("clone")).not.toBeInTheDocument()
    })
  })

  describe("keyboard", () => {
    it("claims only Space for dragging, leaving Enter to open a card", () => {
      renderBoard([A])
      expect(keyboardSensorOptions?.keyboardCodes).toEqual({
        start: ["Space"],
        cancel: ["Escape"],
        end: ["Space"],
      })
    })

    describe("coordinate getter", () => {
      const rects = new Map(
        LANES.map((lane, index) => [
          `col:${lane}`,
          { left: 12 + index * 276, top: 12, width: 264, height: 600 },
        ])
      )
      const context = {
        collisionRect: { left: 288, top: 60, width: 246, height: 120 },
        droppableRects: rects,
      }
      function getter() {
        renderBoard([A])
        return keyboardSensorOptions?.coordinateGetter as (
          event: { code: string; preventDefault: () => void },
          args: unknown
        ) => { x: number; y: number } | undefined
      }

      it("walks the columns in the order they are laid out", () => {
        const preventDefault = jest.fn()
        expect(getter()({ code: "ArrowRight", preventDefault }, { context })).toEqual({
          x: 12 + 2 * 276 + 8,
          y: 60,
        })
        expect(preventDefault).toHaveBeenCalled()
        expect(getter()({ code: "ArrowLeft", preventDefault }, { context })).toEqual({
          x: 20,
          y: 60,
        })
      })

      it("stops at the edge and hands the vertical arrows to dnd-kit", () => {
        const atEnd = { ...context, collisionRect: { ...context.collisionRect, left: 564 } }
        expect(
          getter()({ code: "ArrowRight", preventDefault: jest.fn() }, { context: atEnd })
        ).toBeUndefined()
        const event = { code: "ArrowDown", preventDefault: jest.fn() }
        getter()(event, { context })
        expect(mockSortableKeyboardCoordinates).toHaveBeenCalledWith(event, { context })
      })
    })
  })

  describe("accessibility", () => {
    it("announces from the shared namespace by default, naming item and column", () => {
      renderBoard([A, C])
      expect(dndAccessibility.screenReaderInstructions?.draggable).toBe("dnd.instructions")
      const say = dndAccessibility.announcements!
      expect(say.onDragStart({ active: { id: "a" } })).toBe("dnd.pickedUp:Alpha,L:todo")
      expect(say.onDragOver({ active: { id: "a" }, over: { id: "col:done" } })).toBe(
        "dnd.over:Alpha,L:done"
      )
      // Over another card resolves to that card's column.
      expect(say.onDragOver({ active: { id: "a" }, over: { id: "c" } })).toBe(
        "dnd.over:Alpha,L:done"
      )
      expect(say.onDragEnd({ active: { id: "a" }, over: { id: "col:done" } })).toBe(
        "dnd.dropped:Alpha,L:done"
      )
      expect(say.onDragEnd({ active: { id: "a" }, over: { id: "nowhere" } })).toBe(
        "dnd.denied:Alpha"
      )
      expect(say.onDragCancel({ active: { id: "a" } })).toBe("dnd.cancelled:Alpha,L:todo")
    })

    it("defers to consumer-owned announcements and instructions", () => {
      const announcements = {
        onDragStart: () => "mine",
        onDragOver: () => undefined,
        onDragEnd: () => undefined,
        onDragCancel: () => undefined,
      }
      renderBoard([A], {
        accessibility: { announcements, screenReaderInstructions: { draggable: "how" } },
      })
      expect(dndAccessibility.announcements).toBe(announcements)
      expect(dndAccessibility.screenReaderInstructions?.draggable).toBe("how")
    })
  })
})
