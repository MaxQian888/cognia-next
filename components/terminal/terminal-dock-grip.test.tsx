/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { useTerminalStore } from "@/stores/terminal/terminal-store"

import { TerminalDockGrip } from "./terminal-dock-grip"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// jsdom cannot run a real dnd-kit drag (documented in
// `components/shell/bar-customizer.tsx`), so the draggable is stubbed and the
// keyboard fallback carries the behavioural assertions.
const draggable = { isDragging: false }
jest.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: { "data-dnd": "draggable" },
    listeners: { onPointerDown: jest.fn() },
    setNodeRef: jest.fn(),
    isDragging: draggable.isDragging,
  }),
}))

beforeEach(() => {
  useTerminalStore.getState().reset()
  draggable.isDragging = false
})

describe("TerminalDockGrip", () => {
  it("exposes an accessible drag affordance", () => {
    render(<TerminalDockGrip />)
    const grip = screen.getByTestId("terminal-dock-grip")
    expect(grip).toHaveAttribute("aria-label", "dragToMove")
    expect(grip).toHaveAttribute("data-dnd", "draggable")
    expect(grip).toHaveAttribute("data-dragging", "false")
  })

  it("toggles the dock edge with Enter and with Space", () => {
    // dnd-kit's keyboard sensor has nothing sensible to do with two free
    // droppables, so the grip owns its own non-pointer path.
    render(<TerminalDockGrip />)
    const grip = screen.getByTestId("terminal-dock-grip")

    fireEvent.keyDown(grip, { key: "Enter" })
    expect(useTerminalStore.getState().panelPosition).toBe("right")

    fireEvent.keyDown(grip, { key: " " })
    expect(useTerminalStore.getState().panelPosition).toBe("bottom")
  })

  it("ignores unrelated keys", () => {
    render(<TerminalDockGrip />)
    fireEvent.keyDown(screen.getByTestId("terminal-dock-grip"), { key: "a" })
    expect(useTerminalStore.getState().panelPosition).toBe("bottom")
  })

  it("reflects the dragging state for styling", () => {
    draggable.isDragging = true
    render(<TerminalDockGrip />)
    expect(screen.getByTestId("terminal-dock-grip")).toHaveAttribute("data-dragging", "true")
  })
})
