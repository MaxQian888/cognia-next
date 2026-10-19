/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { CSSProperties, HTMLAttributes, ReactNode } from "react"

let reduced = false
jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, className, style }: HTMLAttributes<HTMLDivElement>) => (
      <div className={className} style={style as CSSProperties}>
        {children}
      </div>
    ),
  },
  useMotionTemplate: () => "",
}))

import { StageLens } from "./stage-lens"

describe("StageLens", () => {
  beforeEach(() => {
    reduced = false
    // Default: fine pointer + hover capable
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: jest.fn((query: string) => ({
        matches: query === "(pointer: fine) and (hover: hover)",
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    })
  })

  it("renders children", () => {
    render(
      <StageLens ariaLabel="Inspect">
        <div data-testid="stage-content">Product</div>
      </StageLens>
    )
    expect(screen.getByTestId("stage-content")).toBeInTheDocument()
  })

  it("draws a rim around the magnified circle so it never reads as a double image", () => {
    const { container } = render(
      <StageLens ariaLabel="Inspect">
        <div data-testid="stage-content">Product</div>
      </StageLens>
    )
    fireEvent.mouseEnter(screen.getByRole("region", { name: "Inspect" }))
    const rim = container.querySelector(".rounded-full.border.border-hairline-strong")
    expect(rim).not.toBeNull()
    expect((rim as HTMLElement).style.width).toBe("150px")
  })

  describe("coarse pointer", () => {
    beforeEach(() => {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: jest.fn((_query: string) => ({
          matches: false,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        })),
      })
    })

    it("renders children directly without lens wrapper", () => {
      const { container } = render(
        <StageLens ariaLabel="Inspect">
          <div data-testid="stage-content">Product</div>
        </StageLens>
      )
      // No lens region role present when disabled
      expect(container.querySelector('[role="region"]')).toBeNull()
      expect(screen.getByTestId("stage-content")).toBeInTheDocument()
    })
  })

  describe("reduced motion", () => {
    beforeEach(() => {
      reduced = true
    })

    it("renders children directly without lens", () => {
      const { container } = render(
        <StageLens ariaLabel="Inspect">
          <div data-testid="stage-content">Product</div>
        </StageLens>
      )
      expect(container.querySelector('[role="region"]')).toBeNull()
      expect(screen.getByTestId("stage-content")).toBeInTheDocument()
    })
  })
})
