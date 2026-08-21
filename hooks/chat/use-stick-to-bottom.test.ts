/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"
import { createRef } from "react"

import { AT_BOTTOM_THRESHOLD_PX, useStickToBottom } from "./use-stick-to-bottom"

interface ScrollBox {
  el: HTMLDivElement
  /** Every value assigned to `scrollTop`, in order. */
  writes: number[]
  setHeight: (height: number) => void
}

/**
 * A stand-in scroll viewport. jsdom reports 0 for every scroll metric, so the
 * geometry is defined here: a 1000px content box in a 200px window, with
 * `scrollTop` backed by a closure so each programmatic pin is observable.
 */
function makeScrollBox(initialHeight = 1000, clientHeight = 200): ScrollBox {
  const el = document.createElement("div")
  const writes: number[] = []
  let height = initialHeight
  let top = 0
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height })
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value
      writes.push(value)
    },
  })
  return {
    el,
    writes,
    setHeight: (next: number) => {
      height = next
    },
  }
}

/** Capture ResizeObserver registrations so a resize can be driven by hand. */
function captureObservers() {
  const registry: { callback: ResizeObserverCallback; target: Element | null }[] = []
  const Real = globalThis.ResizeObserver
  class Capturing {
    private entry: { callback: ResizeObserverCallback; target: Element | null }
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, target: null }
      registry.push(this.entry)
    }
    observe(target: Element) {
      this.entry.target = target
    }
    unobserve() {}
    disconnect() {
      this.entry.target = null
    }
  }
  globalThis.ResizeObserver = Capturing as unknown as typeof ResizeObserver
  return {
    registry,
    restore: () => {
      globalThis.ResizeObserver = Real
    },
    /** Fire every observer currently watching `target`. */
    fire(target: Element) {
      for (const entry of registry) {
        if (entry.target === target) {
          entry.callback([], {} as ResizeObserver)
        }
      }
    },
  }
}

interface HarnessProps {
  enabled?: boolean
  active?: boolean
  pinKey?: unknown
}

function setup(box: ScrollBox, content: HTMLDivElement, initial: HarnessProps = {}) {
  const scrollRef = createRef<HTMLDivElement>() as React.RefObject<HTMLDivElement | null>
  const contentRef = createRef<HTMLDivElement>() as React.RefObject<HTMLDivElement | null>
  scrollRef.current = box.el
  contentRef.current = content
  return renderHook(
    (props: HarnessProps) =>
      useStickToBottom({
        scrollRef,
        contentRef,
        enabled: props.enabled ?? true,
        active: props.active ?? true,
        pinKey: props.pinKey ?? 0,
      }),
    { initialProps: initial }
  )
}

describe("useStickToBottom", () => {
  let observers: ReturnType<typeof captureObservers>

  beforeEach(() => {
    observers = captureObservers()
  })

  afterEach(() => {
    observers.restore()
  })

  it("pins in the layout phase on the first commit", () => {
    const box = makeScrollBox()
    setup(box, document.createElement("div"))
    expect(box.writes).toEqual([1000])
  })

  it("pins once per geometry change, not once per notification", () => {
    const box = makeScrollBox()
    const content = document.createElement("div")
    const { rerender } = setup(box, content)
    expect(box.writes).toEqual([1000])

    // Same geometry, three more notifications from three different sources.
    act(() => {
      rerender({ pinKey: 1 })
    })
    act(() => {
      observers.fire(content)
    })
    act(() => {
      observers.fire(box.el)
    })
    expect(box.writes).toEqual([1000])

    // Real growth writes exactly once.
    box.setHeight(1400)
    act(() => {
      rerender({ pinKey: 2 })
    })
    expect(box.writes).toEqual([1000, 1400])
  })

  it("does not pin when auto-scroll is disabled", () => {
    const box = makeScrollBox()
    setup(box, document.createElement("div"), { enabled: false })
    expect(box.writes).toEqual([])
  })

  it("does not pin on a transcript commit when no turn is in flight", () => {
    const box = makeScrollBox()
    setup(box, document.createElement("div"), { active: false })
    expect(box.writes).toEqual([])
  })

  it("stops pinning once the reader scrolls away from the foot", () => {
    const box = makeScrollBox()
    const content = document.createElement("div")
    const { result } = setup(box, content)
    box.writes.length = 0

    // 1000 - 100 - 200 = 700 from the foot.
    box.el.scrollTop = 100
    box.writes.length = 0
    act(() => {
      result.current.handleScroll()
    })
    expect(result.current.atBottom).toBe(false)

    box.setHeight(1600)
    act(() => {
      observers.fire(content)
    })
    expect(box.writes).toEqual([])
  })

  it("treats a nudge inside the threshold as still at the foot", () => {
    const box = makeScrollBox()
    const { result } = setup(box, document.createElement("div"))
    // 1000 - 790 - 200 = 10, inside the 32px threshold.
    box.el.scrollTop = 1000 - AT_BOTTOM_THRESHOLD_PX - 200 + 10
    act(() => {
      result.current.handleScroll()
    })
    expect(result.current.atBottom).toBe(true)
  })

  it("re-pins on content growth that lands after the commit", () => {
    const box = makeScrollBox()
    const content = document.createElement("div")
    setup(box, content)
    box.writes.length = 0

    box.setHeight(1800)
    act(() => {
      observers.fire(content)
    })
    expect(box.writes).toEqual([1800])
  })

  it("re-pins on viewport resize even with no turn in flight", () => {
    const box = makeScrollBox()
    const content = document.createElement("div")
    setup(box, content, { active: false })
    expect(box.writes).toEqual([])

    box.setHeight(1500)
    // The content observer stays gated on `active`; the viewport one does not.
    act(() => {
      observers.fire(content)
    })
    expect(box.writes).toEqual([])
    act(() => {
      observers.fire(box.el)
    })
    expect(box.writes).toEqual([1500])
  })

  it("resetToBottom re-arms following even after the reader scrolled away", () => {
    const box = makeScrollBox()
    const { result } = setup(box, document.createElement("div"))
    box.el.scrollTop = 0
    box.writes.length = 0
    act(() => {
      result.current.handleScroll()
    })
    expect(result.current.atBottom).toBe(false)

    act(() => {
      result.current.resetToBottom()
    })
    expect(result.current.atBottom).toBe(true)
    expect(box.writes).toEqual([1000])
  })

  it("pinNow honours the gate but ignores whether a turn is in flight", () => {
    const box = makeScrollBox()
    const { result } = setup(box, document.createElement("div"), { active: false })
    expect(box.writes).toEqual([])

    box.setHeight(1200)
    act(() => {
      result.current.pinNow()
    })
    expect(box.writes).toEqual([1200])
  })
})
