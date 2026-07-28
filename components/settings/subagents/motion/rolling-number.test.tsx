/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { RollingNumber } from "./rolling-number"

let flowMotion = { reduce: false, speed: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => flowMotion,
}))

const animateCalls: Array<[number, number]> = []
const stop = jest.fn()
jest.mock("motion/react", () => ({
  ...jest.requireActual("motion/react"),
  animate: (from: number, to: number, opts: { onComplete?: () => void }) => {
    animateCalls.push([from, to])
    opts.onComplete?.()
    return { stop }
  },
}))

beforeEach(() => {
  flowMotion = { reduce: false, speed: 1 }
  animateCalls.length = 0
  stop.mockClear()
})

describe("RollingNumber", () => {
  it("paints the formatted value on mount without animating", () => {
    render(<RollingNumber value={1234} data-testid="n" />)
    expect(screen.getByTestId("n")).toHaveTextContent("1,234")
    expect(animateCalls).toEqual([])
  })

  it("does not animate when re-rendered with the same value", () => {
    // The runtime panel re-renders every second to advance elapsed time; an
    // unchanged token count must not restart the spring on each tick.
    const { rerender } = render(<RollingNumber value={100} data-testid="n" />)
    rerender(<RollingNumber value={100} data-testid="n" />)
    rerender(<RollingNumber value={100} data-testid="n" />)
    expect(animateCalls).toEqual([])
  })

  it("animates from the shown value to the new one exactly once", () => {
    const { rerender } = render(<RollingNumber value={100} data-testid="n" />)
    rerender(<RollingNumber value={250} data-testid="n" />)
    expect(animateCalls).toEqual([[100, 250]])
    expect(screen.getByTestId("n")).toHaveTextContent("250")
  })

  it("chains from where the last animation landed", () => {
    const { rerender } = render(<RollingNumber value={10} data-testid="n" />)
    rerender(<RollingNumber value={20} data-testid="n" />)
    rerender(<RollingNumber value={35} data-testid="n" />)
    expect(animateCalls).toEqual([
      [10, 20],
      [20, 35],
    ])
  })

  it("stops an in-flight animation when the value changes again", () => {
    const { rerender } = render(<RollingNumber value={10} data-testid="n" />)
    rerender(<RollingNumber value={20} data-testid="n" />)
    rerender(<RollingNumber value={30} data-testid="n" />)
    expect(stop).toHaveBeenCalled()
  })

  it("snaps instead of animating under reduced motion", () => {
    flowMotion = { reduce: true, speed: 1 }
    const { rerender } = render(<RollingNumber value={100} data-testid="n" />)
    rerender(<RollingNumber value={250} data-testid="n" />)
    expect(animateCalls).toEqual([])
    expect(screen.getByTestId("n")).toHaveTextContent("250")
  })
})
