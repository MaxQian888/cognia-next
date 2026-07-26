import { render, screen } from "@testing-library/react"

let reduced = false
const motionProps: Array<Record<string, unknown>> = []

jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
  motion: {
    div: ({ children, className, ...props }: { children: React.ReactNode; className?: string }) => {
      motionProps.push(props)
      return (
        <div data-testid="motion-div" className={className}>
          {children}
        </div>
      )
    },
  },
}))

import { Reveal } from "./reveal"

describe("Reveal", () => {
  beforeEach(() => {
    reduced = false
    motionProps.length = 0
  })

  it("renders its children", () => {
    render(<Reveal>content</Reveal>)
    expect(screen.getByText("content")).toBeInTheDocument()
  })

  it("scales product images from 0.96, per the spec's image treatment", () => {
    render(<Reveal variant="scale">image</Reveal>)
    expect(motionProps[0].initial).toEqual({ opacity: 0, scale: 0.96 })
    expect(motionProps[0].whileInView).toEqual({ opacity: 1, scale: 1 })
  })

  it("fades text blocks rather than scaling them", () => {
    render(<Reveal variant="fade">text</Reveal>)
    expect(motionProps[0].initial).toEqual({ opacity: 0, y: 12 })
  })

  it("animates once, so scrolling back does not replay it", () => {
    render(<Reveal>content</Reveal>)
    expect(motionProps[0].viewport).toMatchObject({ once: true })
  })

  it("keeps the duration inside the spec's 250–400ms-plus band", () => {
    render(<Reveal>content</Reveal>)
    const transition = motionProps[0].transition as { duration: number }
    expect(transition.duration).toBeLessThanOrEqual(0.6)
  })

  it("renders the final state with no animation under reduced motion", () => {
    reduced = true
    render(<Reveal variant="scale">content</Reveal>)
    expect(screen.queryByTestId("motion-div")).toBeNull()
    expect(screen.getByText("content")).toBeInTheDocument()
  })

  it("animates on mount when asked, with no in-view gate", () => {
    render(
      <Reveal variant="scale" trigger="mount">
        first screen
      </Reveal>
    )
    expect(motionProps[0].animate).toEqual({ opacity: 1, scale: 1 })
    expect(motionProps[0].whileInView).toBeUndefined()
    expect(motionProps[0].viewport).toBeUndefined()
  })

  it("gates on the viewport by default, so below-fold content waits", () => {
    render(<Reveal>content</Reveal>)
    expect(motionProps[0].whileInView).toBeDefined()
    expect(motionProps[0].animate).toBeUndefined()
  })

  it("still skips animation entirely under reduced motion when mounted", () => {
    reduced = true
    render(
      <Reveal trigger="mount" variant="scale">
        content
      </Reveal>
    )
    expect(screen.queryByTestId("motion-div")).toBeNull()
    expect(screen.getByText("content")).toBeInTheDocument()
  })

  it("keeps the layout class in both modes so nothing shifts", () => {
    const { container, unmount } = render(<Reveal className="my-class">content</Reveal>)
    expect(container.querySelector(".my-class")).toBeInTheDocument()
    unmount()

    reduced = true
    const second = render(<Reveal className="my-class">content</Reveal>)
    expect(second.container.querySelector(".my-class")).toBeInTheDocument()
  })
})
