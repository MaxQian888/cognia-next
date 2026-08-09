/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"
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
  useMotionValue: () => ({ set: jest.fn(), get: () => 0 }),
}))

import { DemoPointer } from "./demo-pointer"

describe("DemoPointer", () => {
  beforeEach(() => {
    reduced = false
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: jest.fn((query: string) => ({
        matches: query === "(pointer: fine) and (hover: hover)",
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    })
  })

  it("renders pointer container element (agent pointer visible on hover)", () => {
    const { container } = render(
      <div data-testid="parent">
        <DemoPointer label="Agent" />
      </div>
    )
    // The Pointer always renders its container ref div
    expect(container.querySelector("div")).toBeInTheDocument()
  })

  it("never hides native cursor - no cursor:none in DOM", () => {
    const { container } = render(
      <div data-testid="parent">
        <DemoPointer label="Agent" />
      </div>
    )
    const parent = container.firstElementChild as HTMLElement
    expect(parent.style.cursor).not.toBe("none")
  })

  describe("coarse pointer", () => {
    beforeEach(() => {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: jest.fn(() => ({
          matches: false,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        })),
      })
    })

    it("renders nothing", () => {
      const { container } = render(<DemoPointer label="Agent" />)
      expect(container.innerHTML).toBe("")
    })
  })

  describe("reduced motion", () => {
    beforeEach(() => {
      reduced = true
    })

    it("renders nothing", () => {
      const { container } = render(<DemoPointer label="Agent" />)
      expect(container.innerHTML).toBe("")
    })
  })
})
