/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { MathBlock } from "./math-block"

const renderBlock = (content: string) =>
  render(
    <TooltipProvider>
      <MathBlock content={content} />
    </TooltipProvider>
  )

const renderMathSafe = jest.fn()
jest.mock("@cognia/latex", () => ({
  renderMathSafe: (...a: unknown[]) => renderMathSafe(...a),
}))

const copy = jest.fn(async () => undefined)
jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copied: false, copy }),
}))

beforeEach(() => {
  renderMathSafe.mockReset().mockReturnValue({ html: "<span>x^2</span>", error: null })
  copy.mockClear()
})

describe("MathBlock", () => {
  it("keeps the toolbar reachable on touch (pointer-coarse)", () => {
    const { container } = renderBlock("$$x^2$$")
    // Hover-revealed on fine pointers; must be forced visible on touch.
    expect(container.querySelector(".pointer-coarse\\:opacity-100")).toBeTruthy()
  })

  it("toggles the LaTeX source and strips the $$ delimiters", () => {
    renderBlock("$$x^2$$")
    // renderMathSafe receives the cleaned content (no $$).
    expect(renderMathSafe).toHaveBeenCalledWith("x^2", true, { trust: false })
    fireEvent.click(screen.getByRole("button", { name: /source/i }))
    expect(screen.getByText("x^2", { selector: "code" })).toBeInTheDocument()
  })

  it("copies the cleaned LaTeX when the copy button is pressed", () => {
    renderBlock("$$a+b$$")
    fireEvent.click(screen.getByRole("button", { name: /copy/i }))
    expect(copy).toHaveBeenCalledWith("a+b")
  })

  it("renders an error alert when rendering fails", () => {
    renderMathSafe.mockReturnValue({ html: "", error: "bad latex" })
    renderBlock("$$\\bad$$")
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.getByText("bad latex")).toBeInTheDocument()
  })
})
