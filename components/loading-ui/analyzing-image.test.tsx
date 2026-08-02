import React from "react"
import { render, screen } from "@testing-library/react"

import { AnalyzingImage } from "./analyzing-image"

// `motion.div` is replaced by a plain div that echoes the animation props as
// data attributes: the two clipped layers are the whole point of this component,
// and framer never applies them in jsdom (no rAF-driven style writes there).
jest.mock("motion/react", () => ({
  motion: {
    div: ({
      children,
      className,
      animate,
      initial,
      transition: _transition,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & {
      animate?: Record<string, unknown>
      initial?: Record<string, unknown>
      transition?: unknown
    }) => (
      <div
        className={className}
        data-animate={JSON.stringify(animate)}
        data-initial={JSON.stringify(initial)}
        {...props}
      >
        {children}
      </div>
    ),
  },
  useReducedMotion: jest.fn(() => false),
}))

const mockUseReducedMotion = jest.requireMock("motion/react").useReducedMotion

describe("AnalyzingImage", () => {
  beforeEach(() => {
    mockUseReducedMotion.mockReturnValue(false)
  })

  it("announces the caller-supplied label as a status", () => {
    render(<AnalyzingImage label="Analyzing image…" />)

    const status = screen.getByRole("status", { name: "Analyzing image…" })
    expect(status).toBeInTheDocument()
    // Also present as real text so screen readers that ignore aria-label on a
    // generic container still read it.
    expect(screen.getByText("Analyzing image…")).toHaveClass("sr-only")
  })

  it("merges the caller's className onto the sized root", () => {
    render(<AnalyzingImage label="x" className="size-4 text-muted-foreground" />)

    const status = screen.getByRole("status")
    expect(status).toHaveClass("relative", "isolate", "shrink-0", "size-4", "text-muted-foreground")
  })

  it("wipes the plain glyph out exactly as the detailed one is wiped in", () => {
    const { container } = render(<AnalyzingImage label="x" />)

    const animated = [...container.querySelectorAll("[data-animate]")].map(
      (el) => JSON.parse(el.getAttribute("data-animate") ?? "{}") as Record<string, string[]>
    )
    const [plain, bar, detail] = animated
    expect(animated).toHaveLength(3)
    // Plain layer collapses from the right; detail layer is revealed from the
    // right by the mirrored inset. Complementary halves of one wipe.
    expect(plain?.clipPath).toEqual([
      "inset(0% 0% 0% 0%)",
      "inset(0% 105% 0% 0%)",
      "inset(0% 105% 0% 0%)",
      "inset(0% 0% 0% 0%)",
    ])
    expect(detail?.clipPath).toEqual([
      "inset(0% 0% 0% 100%)",
      "inset(0% 0% 0% 0%)",
      "inset(0% 0% 0% 0%)",
      "inset(0% 0% 0% 100%)",
    ])
    // The scan bar sweeps the same direction the wipe travels.
    expect(bar?.transform).toEqual([
      "translateX(1400%)",
      "translateX(-80%)",
      "translateX(-80%)",
      "translateX(1400%)",
    ])
  })

  it("never paints an opaque backdrop (it sits on translucent surfaces)", () => {
    const { container } = render(<AnalyzingImage label="x" />)

    expect(container.querySelector("[class*='bg-background']")).toBeNull()
  })

  it("renders the settled glyph statically under reduced motion", () => {
    mockUseReducedMotion.mockReturnValue(true)
    const { container } = render(<AnalyzingImage label="Analyzing image…" />)

    // No animated layers at all — an Infinity repeat never ends on its own, so
    // it is dropped rather than shortened.
    expect(container.querySelectorAll("[data-animate]")).toHaveLength(0)
    expect(container.querySelectorAll("svg")).toHaveLength(1)
    expect(screen.getByRole("status", { name: "Analyzing image…" })).toBeInTheDocument()
  })

  it("forwards arbitrary div props (data-testid, title…)", () => {
    render(<AnalyzingImage label="x" data-testid="analyzing" title="tip" />)

    expect(screen.getByTestId("analyzing")).toHaveAttribute("title", "tip")
  })
})
