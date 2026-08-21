/**
 * @jest-environment jsdom
 */

/**
 * Drag wiring for the run panel's queued-follow-up list.
 *
 * Kept in its own file because it stubs `@dnd-kit/core`'s `DndContext` to hand
 * the drag callbacks back to the test — same reason as
 * `composer/attachment-preview.drag.test.tsx`: jsdom reports every element as
 * 0x0, so the real sensors can never resolve a drop target and only OUR handler
 * is worth exercising. The pure half of the decision is `resolveDragEnd`
 * (`lib/chat/attachments/reorder.test.ts`); the half this file owns is the
 * translation from "landed on that row" into the store's signed move.
 */

import { act, fireEvent, render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"

import { RunStatusBar } from "./run-status-bar"
import { useChatStore, makeSessionSlice } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))

/** Drag callbacks captured from the stubbed DndContext. The `mock` name prefix
 * is what lets the hoisted factory below reference it without a TDZ error. */
const mockDnd: {
  onDragEnd?: (e: { active: { id: string }; over: { id: string } | null }) => void
  accessibility?: {
    announcements?: Record<string, (e: never) => string | undefined>
    screenReaderInstructions?: { draggable: string }
  }
} = {}

jest.mock("@dnd-kit/core", () => ({
  ...jest.requireActual("@dnd-kit/core"),
  DndContext: ({
    children,
    onDragEnd,
    accessibility,
  }: {
    children: React.ReactNode
    onDragEnd?: (e: unknown) => void
    accessibility?: unknown
  }) => {
    mockDnd.onDragEnd = onDragEnd as typeof mockDnd.onDragEnd
    mockDnd.accessibility = accessibility as typeof mockDnd.accessibility
    return <>{children}</>
  },
}))

const SID = "s1"

function steerBubble(entryId: string, text: string): UIMessage {
  return {
    id: `m-${entryId}`,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { steer: { entryId, state: "queued" } },
  } as unknown as UIMessage
}

/** Three queued follow-ups, with the panel opened on the queue section. */
function openQueue() {
  useChatStore.setState({
    activeSessionId: SID,
    sessions: {
      [SID]: {
        ...makeSessionSlice(),
        status: "streaming",
        steerQueue: [
          { id: "e1", text: "first" },
          { id: "e2", text: "second" },
          { id: "e3", text: "third" },
        ],
        messages: [steerBubble("e1", "first"), steerBubble("e2", "second")],
      },
    },
  })
  render(<RunStatusBar sessionId={SID} />)
  fireEvent.click(screen.getByTestId("run-status-steer-chip"))
}

const order = () => useChatStore.getState().sessions[SID]?.steerQueue.map((e) => e.id)

beforeEach(() => {
  useChatStore.setState({ activeSessionId: null, sessions: {} })
  useSettingsStore.setState({ settings: {} as never, save: (() => Promise.resolve()) as never })
  mockDnd.onDragEnd = undefined
  mockDnd.accessibility = undefined
})

describe("RunPanel queue drag", () => {
  it("gives every row a grip that carries the drag listeners", () => {
    openQueue()
    const grips = screen.getAllByTestId("run-panel-queue-grip")
    expect(grips).toHaveLength(3)
    // dnd-kit's `attributes` are what make the grip the keyboard drag target.
    expect(grips[0]).toHaveAttribute("aria-roledescription")
    expect(grips[0].className).toContain("touch-none")
  })

  it("moves a row down onto the row it was dropped on", () => {
    openQueue()
    act(() => mockDnd.onDragEnd?.({ active: { id: "e1" }, over: { id: "e3" } }))
    expect(order()).toEqual(["e2", "e3", "e1"])
  })

  it("moves a row up onto the row it was dropped on", () => {
    openQueue()
    act(() => mockDnd.onDragEnd?.({ active: { id: "e3" }, over: { id: "e1" } }))
    expect(order()).toEqual(["e3", "e1", "e2"])
  })

  it("leaves the order alone when the drag lands on nothing or on itself", () => {
    openQueue()
    const before = order()
    act(() => mockDnd.onDragEnd?.({ active: { id: "e2" }, over: null }))
    expect(order()).toEqual(before)
    act(() => mockDnd.onDragEnd?.({ active: { id: "e2" }, over: { id: "e2" } }))
    expect(order()).toEqual(before)
    // A row that left the queue mid-drag (delivered, or discarded from its
    // bubble) must not be resolved against a stale index.
    act(() => mockDnd.onDragEnd?.({ active: { id: "gone" }, over: { id: "e1" } }))
    expect(order()).toEqual(before)
  })

  it("announces the reorder through the message catalog, not dnd-kit's English defaults", () => {
    openQueue()
    const a = mockDnd.accessibility
    expect(a?.screenReaderInstructions?.draggable).toBe("dndInstructions")
    expect(a?.announcements?.onDragStart?.({ active: { id: "e2" } } as never)).toBe(
      'dndPickedUp:{"index":2,"total":3}'
    )
    expect(a?.announcements?.onDragEnd?.({ over: { id: "e3" } } as never)).toBe(
      'dndDropped:{"position":3,"total":3}'
    )
    expect(a?.announcements?.onDragEnd?.({ over: null } as never)).toBe("dndCancelled")
  })

  it("disables dragging on the row being rewritten", () => {
    openQueue()
    fireEvent.click(screen.getAllByTestId("run-panel-queue-edit-open")[0])
    // The editor owns the pointer and the arrow keys while it is open.
    expect(screen.getAllByTestId("run-panel-queue-grip")[0]).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })
})
