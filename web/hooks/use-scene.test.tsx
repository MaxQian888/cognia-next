import { act, render, screen } from "@testing-library/react"
import { useRef } from "react"

let reduced = false
let inView = true
jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
  useInView: () => inView,
}))

import { useScene } from "./use-scene"

function Probe() {
  const ref = useRef<HTMLDivElement>(null)
  const scene = useScene(ref, [100, 100, 100])
  return (
    <div ref={ref} data-live={scene.live || undefined}>
      {scene.phase}
    </div>
  )
}

describe("useScene", () => {
  beforeEach(() => {
    reduced = false
    inView = true
    jest.useFakeTimers()
  })
  afterEach(() => jest.useRealTimers())

  it("counts up from the opening phase once on screen and stops on the last", () => {
    render(<Probe />)
    expect(screen.getByText("0")).toHaveAttribute("data-live", "true")
    act(() => {
      jest.advanceTimersByTime(100)
    })
    expect(screen.getByText("1")).toBeInTheDocument()
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("reports the final phase under reduced motion, without running", () => {
    reduced = true
    render(<Probe />)
    expect(screen.getByText("3")).not.toHaveAttribute("data-live")
  })

  it("holds the opening phase while off screen, so the start is not a flash from finished", () => {
    inView = false
    render(<Probe />)
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    expect(screen.getByText("0")).not.toHaveAttribute("data-live")
  })
})
