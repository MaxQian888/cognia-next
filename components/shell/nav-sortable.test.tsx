/**
 * @jest-environment jsdom
 */

import { act, render, renderHook, screen } from "@testing-library/react"

// jsdom has no layout, so a real drag never resolves an `over` target.
// Capture what the list hands dnd-kit and drive the drop directly — the same
// seam `customizer-list.test.tsx` uses.
let lastDragEnd: ((event: unknown) => void) | undefined
let lastAccessibility:
  | {
      announcements: Record<string, (event: unknown) => string | undefined>
      screenReaderInstructions: { draggable: string }
    }
  | undefined
let lastSensors: unknown
jest.mock("@dnd-kit/core", () => {
  const actual = jest.requireActual<typeof import("@dnd-kit/core")>("@dnd-kit/core")
  return {
    ...actual,
    DndContext: ({
      children,
      onDragEnd,
      accessibility,
      sensors,
    }: {
      children: React.ReactNode
      onDragEnd: (event: unknown) => void
      accessibility?: typeof lastAccessibility
      sensors?: unknown
    }) => {
      lastDragEnd = onDragEnd
      lastAccessibility = accessibility
      lastSensors = sensors
      return <actual.DndContext>{children}</actual.DndContext>
    },
  }
})

import { NavSortableItem, NavSortableList, useReorderAnnouncements } from "./nav-sortable"

const LABELS: Record<string, string> = { a: "Alpha", b: "Beta", c: "Gamma" }
const labelOf = (id: string) => LABELS[id] ?? id

function renderList(onReorder = jest.fn()) {
  render(
    <NavSortableList ids={["a", "b", "c"]} onReorder={onReorder} labelOf={labelOf}>
      {["a", "b", "c"].map((id) => (
        <NavSortableItem key={id} id={id}>
          {(drag) => (
            <div
              ref={drag.setNodeRef}
              style={drag.style}
              data-testid={`item-${id}`}
              {...drag.handleProps}
            >
              <button type="button" tabIndex={-1}>
                {LABELS[id]}
              </button>
            </div>
          )}
        </NavSortableItem>
      ))}
    </NavSortableList>
  )
  return onReorder
}

describe("NavSortableList", () => {
  it("persists the whole new order after a drop that moved something", () => {
    const onReorder = renderList()
    act(() => lastDragEnd?.({ active: { id: "a" }, over: { id: "c" } }))
    expect(onReorder).toHaveBeenCalledWith(["b", "c", "a"])
  })

  it("ignores a drop on nothing or back on itself", () => {
    const onReorder = renderList()
    act(() => lastDragEnd?.({ active: { id: "a" }, over: null }))
    act(() => lastDragEnd?.({ active: { id: "b" }, over: { id: "b" } }))
    expect(onReorder).not.toHaveBeenCalled()
  })

  it("arms on the pointer only — the arrow keys belong to the roving focus", () => {
    renderList()
    const sensors = lastSensors as { sensor: { name?: string } }[]
    expect(sensors).toHaveLength(1)
  })

  it("never turns the item into an extra tab stop", () => {
    renderList()
    const item = screen.getByTestId("item-a")
    expect(item).not.toHaveAttribute("tabindex")
    expect(item).not.toHaveAttribute("role")
    expect(item).toHaveAttribute("aria-roledescription")
  })

  it("speaks localized announcements with 1-based positions", () => {
    renderList()
    const { announcements, screenReaderInstructions } = lastAccessibility!
    expect(announcements.onDragStart({ active: { id: "b" } })).toBe(
      "Picked up Beta. Position 2 of 3."
    )
    expect(announcements.onDragOver({ active: { id: "b" }, over: { id: "c" } })).toBe(
      "Beta is over position 3 of 3."
    )
    expect(announcements.onDragEnd({ active: { id: "b" }, over: { id: "a" } })).toBe(
      "Dropped Beta at position 1 of 3."
    )
    expect(announcements.onDragCancel({ active: { id: "b" } })).toMatch(/Beta/)
    // Pointer-only list: the instructions point at the context menu.
    expect(screenReaderInstructions.draggable).toMatch(/Move up/)
  })
})

describe("useReorderAnnouncements", () => {
  it("explains the keyboard sensor where the list has one", () => {
    const { result } = renderHook(() => useReorderAnnouncements(["a"], labelOf, { keyboard: true }))
    expect(result.current.instructions).toMatch(/Space or Enter/)
  })
})
