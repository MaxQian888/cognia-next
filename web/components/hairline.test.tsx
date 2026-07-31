import { render } from "@testing-library/react"

let reduced = false
const motionProps: Array<Record<string, unknown>> = []

jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
  motion: {
    span: ({ className, ...props }: { className?: string }) => {
      const record = props as Record<string, unknown>
      motionProps.push(record)
      // `aria-hidden` is forwarded rather than stripped: it is a real DOM
      // attribute the component is responsible for, and the suite asserts on
      // it in both modes.
      return (
        <span
          className={className}
          aria-hidden={record["aria-hidden"] as boolean | undefined}
          data-testid="motion-span"
        />
      )
    },
  },
}))

import { Hairline } from "./hairline"

describe("Hairline", () => {
  beforeEach(() => {
    reduced = false
    motionProps.length = 0
  })

  it("draws a horizontal rule from its left edge", () => {
    const { container } = render(<Hairline />)
    expect(motionProps[0].initial).toEqual({ scaleX: 0 })
    expect(motionProps[0].whileInView).toEqual({ scaleX: 1 })
    expect(container.querySelector(".origin-left")).toBeInTheDocument()
  })

  it("draws a vertical rule from its top edge", () => {
    const { container } = render(<Hairline orientation="y" />)
    expect(motionProps[0].initial).toEqual({ scaleY: 0 })
    expect(container.querySelector(".origin-top")).toBeInTheDocument()
  })

  it("animates once", () => {
    render(<Hairline />)
    expect(motionProps[0].viewport).toMatchObject({ once: true })
  })

  it("animates transform only, never a layout property", () => {
    render(<Hairline />)
    const animated = Object.keys(motionProps[0].whileInView as Record<string, unknown>)
    expect(animated).toEqual(["scaleX"])
  })

  it("carries the requested tone", () => {
    const { container } = render(<Hairline tone="action" />)
    expect(container.querySelector(".bg-action")).toBeInTheDocument()
  })

  it("renders the finished rule with no motion component under reduced motion", () => {
    reduced = true
    const { container } = render(<Hairline tone="hairline-strong" />)
    expect(container.querySelector("[data-testid='motion-span']")).toBeNull()
    // Same box and same colour, so nothing shifts between the two modes.
    expect(container.querySelector("span.h-px.w-full.bg-hairline-strong")).toBeInTheDocument()
  })

  it("stays out of the accessibility tree in both modes", () => {
    const { container: animated } = render(<Hairline />)
    expect(animated.querySelector("[aria-hidden]")).toBeInTheDocument()

    reduced = true
    const { container: still } = render(<Hairline />)
    expect(still.querySelector("[aria-hidden]")).toBeInTheDocument()
  })
})
