/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import { useConversationReveal, type ConversationRevealStep } from "./use-conversation-reveal"

// A tiny reactive stand-in for the UI store: the hook reads the pending marker
// and clears it, and every clear has to re-render the consumer the way zustand
// would — otherwise the ladder could never take a second step.
let pending: string | null = null
const listeners = new Set<() => void>()
const clearReveal = jest.fn(() => {
  pending = null
  listeners.forEach((listener) => listener())
})

jest.mock("@/stores/ui", () => ({
  useUIStore: <T>(selector: (s: Record<string, unknown>) => T): T => {
    const react = jest.requireActual<typeof import("react")>("react")
    const [, force] = react.useReducer((n: number) => n + 1, 0)
    react.useEffect(() => {
      listeners.add(force)
      return () => {
        listeners.delete(force)
      }
    }, [force])
    return selector({ pendingConversationReveal: pending, clearConversationReveal: clearReveal })
  },
}))

beforeEach(() => {
  pending = null
  listeners.clear()
  clearReveal.mockClear()
})

/** Renders the hook over a mutable narrowing state, undone one rung at a time. */
function renderLadder(options: {
  activeSessionId?: string | null
  listed?: boolean
  narrowing: string[]
  /** Ids the list renders once `narrowing` is empty (defaults to "everything"). */
  visibleWhenOpen?: string[]
}) {
  const narrowing = [...options.narrowing]
  const undone: string[] = []
  const view = renderHook(() =>
    useConversationReveal({
      activeSessionId: options.activeSessionId === undefined ? "s1" : options.activeSessionId,
      listed: () => options.listed !== false,
      visible: (id) => narrowing.length === 0 && (options.visibleWhenOpen ?? [id]).includes(id),
      steps: () =>
        narrowing.map((name): ConversationRevealStep => ({
          active: true,
          undo: () => {
            undone.push(name)
            narrowing.splice(narrowing.indexOf(name), 1)
            listeners.forEach((listener) => listener())
          },
        })),
    })
  )
  return { ...view, undone, narrowing }
}

describe("useConversationReveal", () => {
  it("does nothing while no conversation is waiting to be revealed", () => {
    const { undone } = renderLadder({ narrowing: ["view"] })
    expect(undone).toEqual([])
    expect(clearReveal).not.toHaveBeenCalled()
  })

  it("clears the marker without touching the list when the row is already visible", () => {
    pending = "s1"
    const { undone } = renderLadder({ narrowing: [] })
    expect(undone).toEqual([])
    expect(clearReveal).toHaveBeenCalledTimes(1)
  })

  it("undoes each narrowing dimension in order until the row is on screen", () => {
    pending = "s1"
    const { undone } = renderLadder({ narrowing: ["view", "query", "filters"] })
    expect(undone).toEqual(["view", "query", "filters"])
    expect(clearReveal).toHaveBeenCalledTimes(1)
  })

  it("waits for the live query instead of resetting a list that has not caught up", () => {
    pending = "s1"
    const { undone, rerender } = renderLadder({ narrowing: ["query"], listed: false })
    rerender()
    expect(undone).toEqual([])
    expect(clearReveal).not.toHaveBeenCalled()
  })

  it("drops a stale request once the user opened another conversation", () => {
    pending = "s1"
    const { undone } = renderLadder({ narrowing: ["query"], activeSessionId: "other" })
    expect(undone).toEqual([])
    expect(clearReveal).toHaveBeenCalledTimes(1)
  })

  it("lets go when the row stays hidden by something no step can undo", () => {
    pending = "s1"
    // No steps at all, and the row never becomes visible: the hook must not spin.
    const view = renderHook(() =>
      useConversationReveal({
        activeSessionId: "s1",
        listed: () => true,
        visible: () => false,
        steps: () => [],
      })
    )
    view.rerender()
    expect(clearReveal).toHaveBeenCalledTimes(1)
  })
})
