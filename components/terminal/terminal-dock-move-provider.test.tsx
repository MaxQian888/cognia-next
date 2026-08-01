/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"

import { TERMINAL_DOCK_DROP_IDS } from "@/lib/terminal/dock-position"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// jsdom cannot run a real dnd-kit drag — the repo already documents this in
// `components/shell/bar-customizer.tsx`. Stub `DndContext` to a passthrough that
// captures the lifecycle handlers, then drive them directly.
const handlers: {
  onDragStart?: () => void
  onDragEnd?: (event: { over?: { id: string } | null }) => void
  onDragCancel?: () => void
} = {}

jest.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragStart,
    onDragEnd,
    onDragCancel,
  }: {
    children: React.ReactNode
    onDragStart: () => void
    onDragEnd: (event: { over?: { id: string } | null }) => void
    onDragCancel: () => void
  }) => {
    handlers.onDragStart = onDragStart
    handlers.onDragEnd = onDragEnd
    handlers.onDragCancel = onDragCancel
    return <>{children}</>
  },
  PointerSensor: jest.fn(),
  useSensor: jest.fn(),
  useSensors: jest.fn(() => []),
  useDroppable: ({ id }: { id: string }) => ({
    setNodeRef: jest.fn(),
    isOver: id === TERMINAL_DOCK_DROP_IDS.right,
  }),
}))

import { TerminalDockMoveProvider } from "./terminal-dock-move-provider"

beforeEach(() => {
  useTerminalStore.getState().reset()
  handlers.onDragStart = undefined
  handlers.onDragEnd = undefined
  handlers.onDragCancel = undefined
})

function renderProvider() {
  return render(
    <TerminalDockMoveProvider>
      <div data-testid="shell-row" />
    </TerminalDockMoveProvider>
  )
}

describe("TerminalDockMoveProvider", () => {
  it("renders its children and no drop zones until a drag starts", () => {
    renderProvider()
    expect(screen.getByTestId("shell-row")).toBeInTheDocument()
    expect(screen.queryByTestId(TERMINAL_DOCK_DROP_IDS.bottom)).toBeNull()
    expect(screen.queryByTestId(TERMINAL_DOCK_DROP_IDS.right)).toBeNull()
  })

  it("paints both edge zones during a drag and marks the hovered one", () => {
    renderProvider()
    act(() => handlers.onDragStart?.())
    expect(screen.getByTestId(TERMINAL_DOCK_DROP_IDS.bottom)).toHaveAttribute("data-over", "false")
    expect(screen.getByTestId(TERMINAL_DOCK_DROP_IDS.right)).toHaveAttribute("data-over", "true")
  })

  it("re-docks on a drop over the other edge and clears the zones", () => {
    renderProvider()
    act(() => handlers.onDragStart?.())
    act(() => handlers.onDragEnd?.({ over: { id: TERMINAL_DOCK_DROP_IDS.right } }))
    expect(useTerminalStore.getState().panelPosition).toBe("right")
    expect(screen.queryByTestId(TERMINAL_DOCK_DROP_IDS.right)).toBeNull()
  })

  it("is a no-op when dropped on the edge the dock already occupies", () => {
    renderProvider()
    useTerminalStore.getState().toggleMaximized()
    act(() => handlers.onDragStart?.())
    act(() => handlers.onDragEnd?.({ over: { id: TERMINAL_DOCK_DROP_IDS.bottom } }))
    expect(useTerminalStore.getState().panelPosition).toBe("bottom")
    // A no-op drop must not clear `maximized` or replay the slide.
    expect(useTerminalStore.getState().maximized).toBe(true)
  })

  it("is a no-op when released outside any zone", () => {
    renderProvider()
    act(() => handlers.onDragStart?.())
    act(() => handlers.onDragEnd?.({ over: null }))
    expect(useTerminalStore.getState().panelPosition).toBe("bottom")
  })

  it("clears the zones on cancel", () => {
    renderProvider()
    act(() => handlers.onDragStart?.())
    expect(screen.getByTestId(TERMINAL_DOCK_DROP_IDS.bottom)).toBeInTheDocument()
    act(() => handlers.onDragCancel?.())
    expect(screen.queryByTestId(TERMINAL_DOCK_DROP_IDS.bottom)).toBeNull()
  })
})
