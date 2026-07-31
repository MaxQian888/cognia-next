import { act, render, screen } from "@testing-library/react"

let reduced = false
jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
}))

import { useCountUp } from "./use-count-up"

let clock = 0
const now = () => clock

function Probe({
  to,
  start,
  durationMs = 900,
}: {
  to: number
  start: boolean
  durationMs?: number
}) {
  const value = useCountUp({ to, start, durationMs, now })
  return <span data-testid="value">{value}</span>
}

const read = () => Number(screen.getByTestId("value").textContent)

/** Advance the injected clock and flush the rAF queue jsdom backs with timers. */
function advance(ms: number) {
  act(() => {
    clock += ms
    jest.advanceTimersByTime(ms)
  })
}

describe("useCountUp", () => {
  beforeEach(() => {
    reduced = false
    clock = 0
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("renders the real value before the count starts", () => {
    // The static export must carry the true figure for a no-JavaScript reader;
    // starting at zero would ship "0" into the HTML.
    render(<Probe to={52} start={false} />)
    expect(read()).toBe(52)
  })

  it("stays at the real value while it is never started", () => {
    render(<Probe to={52} start={false} />)
    advance(2000)
    expect(read()).toBe(52)
  })

  it("counts up and settles exactly on the target", () => {
    render(<Probe to={52} start />)
    advance(16)
    expect(read()).toBeLessThan(52)

    advance(2000)
    expect(read()).toBe(52)
  })

  it("passes through intermediate values rather than jumping", () => {
    render(<Probe to={1000} start />)
    advance(450)
    const mid = read()
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1000)
  })

  it("never overshoots its target", () => {
    render(<Probe to={7} start />)
    for (let i = 0; i < 40; i += 1) {
      advance(50)
      expect(read()).toBeLessThanOrEqual(7)
    }
  })

  it("schedules no frame at all under reduced motion", () => {
    reduced = true
    const raf = jest.spyOn(window, "requestAnimationFrame")
    render(<Probe to={52} start />)
    advance(1000)
    expect(read()).toBe(52)
    expect(raf).not.toHaveBeenCalled()
    raf.mockRestore()
  })

  it("leaves a zero value alone rather than flashing an empty stat", () => {
    render(<Probe to={0} start />)
    advance(1000)
    expect(read()).toBe(0)
  })

  it("runs once, so a re-render does not restart the count", () => {
    const { rerender } = render(<Probe to={52} start />)
    advance(2000)
    expect(read()).toBe(52)

    rerender(<Probe to={52} start />)
    advance(16)
    expect(read()).toBe(52)
  })
})
