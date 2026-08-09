/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { HTMLAttributes, ReactNode } from "react"

import { en } from "@web/content/en"

let reduced = false
jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, className }: HTMLAttributes<HTMLDivElement>) => (
      <div className={className} data-testid="motion-div">
        {children}
      </div>
    ),
  },
}))

import { DemoActivityList } from "./demo-activity-list"

describe("DemoActivityList", () => {
  const copy = en.reconstruction.artifacts.test

  beforeEach(() => {
    reduced = false
  })

  it("renders at least the first test line from DEMO_TASK", () => {
    render(<DemoActivityList copy={copy} />)
    // AnimatedList reveals items progressively; at least the first is visible
    expect(screen.getByText("applies the discount before tax")).toBeInTheDocument()
  })

  it("renders state icon for the first visible item", () => {
    const { container } = render(<DemoActivityList copy={copy} />)
    // First item is "pass" → ✓
    expect(container.textContent).toContain("✓")
  })

  describe("reduced motion", () => {
    beforeEach(() => {
      reduced = true
    })

    it("shows all items immediately without AnimatedList wrapper", () => {
      render(<DemoActivityList copy={copy} />)
      // All items visible in reduced motion mode
      expect(screen.getByText("applies the discount before tax")).toBeInTheDocument()
      expect(screen.getByText("keeps USD totals at two decimals")).toBeInTheDocument()
      expect(screen.getByText("rounds JPY totals to whole yen")).toBeInTheDocument()
    })

    it("renders all state icons", () => {
      const { container } = render(<DemoActivityList copy={copy} />)
      expect(container.textContent).toContain("✓")
      expect(container.textContent).toContain("✗")
      expect(container.textContent).toContain("○")
    })

    it("keeps the complete result context alongside the animated rows", () => {
      render(<DemoActivityList copy={copy} />)
      expect(screen.getByText(copy.summary)).toBeInTheDocument()
      expect(screen.getByText(copy.lineNotes.jpy)).toBeInTheDocument()
      expect(screen.getByRole("list", { name: copy.heading })).toBeInTheDocument()
    })
  })
})
