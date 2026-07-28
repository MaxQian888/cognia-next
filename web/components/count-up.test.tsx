import { act, render, screen, waitFor } from "@testing-library/react"
import type { ObserverFactory } from "@web/lib/intersection"

jest.mock("motion/react", () => ({
  useReducedMotion: () => false,
}))

import { CountUp } from "./count-up"

/**
 * A factory whose observer records what it watched and lets a test declare
 * "this scrolled into view". jsdom's own stub never fires, which is why the
 * component takes the factory as a prop at all.
 */
function fakeObserver() {
  let fire: ((entries: Pick<IntersectionObserverEntry, "isIntersecting">[]) => void) | undefined
  const observed: Element[] = []
  let disconnected = 0

  const create: ObserverFactory = (callback) => {
    fire = (entries) => callback(entries as IntersectionObserverEntry[], {} as IntersectionObserver)
    return {
      observe: (node: Element) => observed.push(node),
      disconnect: () => {
        disconnected += 1
      },
      unobserve: () => {},
      takeRecords: () => [],
      root: null,
      rootMargin: "",
      thresholds: [],
    } as unknown as IntersectionObserver
  }

  return {
    create,
    observed,
    get disconnected() {
      return disconnected
    },
    enter: () => act(() => fire?.([{ isIntersecting: true }])),
    pass: () => act(() => fire?.([{ isIntersecting: false }])),
  }
}

describe("CountUp", () => {
  it("renders a number at its real value before it is ever in view", () => {
    // The never-scrolled / no-JavaScript case: the true figure must be what
    // shows, never a zero waiting to be animated.
    render(<CountUp value={52} />)
    expect(screen.getByText("52")).toBeInTheDocument()
  })

  it("observes the element and starts counting once it enters the viewport", async () => {
    const observer = fakeObserver()
    render(<CountUp value={52} durationMs={0} createObserver={observer.create} />)
    expect(observer.observed).toHaveLength(1)

    observer.enter()
    // One-shot: the observer is dropped the moment it fires, so a second
    // crossing cannot restart the count.
    expect(observer.disconnected).toBeGreaterThan(0)
    // The tally runs on `requestAnimationFrame`; a zero duration settles on the
    // first frame rather than instantly.
    await waitFor(() => expect(screen.getByText("52")).toBeInTheDocument())
  })

  it("does not start on an entry that is not intersecting", () => {
    const observer = fakeObserver()
    render(<CountUp value={52} durationMs={0} createObserver={observer.create} />)
    observer.pass()
    expect(observer.disconnected).toBe(0)
  })

  it("never observes a string value", () => {
    const observer = fakeObserver()
    render(<CountUp value="AGPL-3.0-or-later" createObserver={observer.create} />)
    expect(observer.observed).toHaveLength(0)
  })

  it("disconnects the observer on unmount", () => {
    const observer = fakeObserver()
    const { unmount } = render(<CountUp value={7} createObserver={observer.create} />)
    unmount()
    expect(observer.disconnected).toBeGreaterThan(0)
  })

  it("renders a string verbatim, with no counting", () => {
    render(<CountUp value="AGPL-3.0-or-later" />)
    expect(screen.getByText("AGPL-3.0-or-later")).toBeInTheDocument()
  })

  it("uses tabular figures for numbers so the row does not reflow while counting", () => {
    const { container } = render(<CountUp value={253} />)
    expect(container.querySelector(".tabular-nums")).toBeInTheDocument()
  })

  it("does not apply tabular figures to a string", () => {
    const { container } = render(<CountUp value="—" />)
    expect(container.querySelector(".tabular-nums")).toBeNull()
  })

  it("keeps the caller's class", () => {
    const { container } = render(<CountUp value={2} className="text-3xl" />)
    expect(container.querySelector(".text-3xl")).toBeInTheDocument()
  })

  it("renders zero rather than an empty stat", () => {
    render(<CountUp value={0} />)
    expect(screen.getByText("0")).toBeInTheDocument()
  })
})
