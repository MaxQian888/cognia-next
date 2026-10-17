/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderMathSafe } from "@cognia/latex"

import { TooltipProvider } from "@/components/ui/tooltip"
import { MathInline } from "./math-inline"
import { InlineMathLinkContext } from "./math-error-boundary"

jest.mock("@cognia/latex", () => ({
  ...jest.requireActual("@cognia/latex"),
  renderMathSafe: jest.fn(jest.requireActual("@cognia/latex").renderMathSafe),
}))

describe("MathInline", () => {
  beforeEach(() => {
    jest
      .mocked(renderMathSafe)
      .mockImplementation(jest.requireActual("@cognia/latex").renderMathSafe)
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
    })
  })

  it("shows copy feedback only after the expression is copied", async () => {
    const { container } = render(
      <TooltipProvider>
        <p>
          <MathInline content="$x^2$" />
        </p>
      </TooltipProvider>
    )
    const expression = container.querySelector<HTMLElement>('[role="math"]')!

    fireEvent.mouseEnter(expression)
    expect(expression.querySelector('[data-state="idle"]')).toBeInTheDocument()
    expect(container.querySelector("p div, p pre, p figure, a button")).toBeNull()

    fireEvent.click(expression)
    await waitFor(() =>
      expect(expression.querySelector('[data-state="copied"]')).toBeInTheDocument()
    )
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("x^2")
    expect(container.querySelector("p div, p pre, p figure, a button")).toBeNull()
  })

  it("preserves link navigation without nested focus or copy controls", () => {
    const { container } = render(
      <TooltipProvider>
        <InlineMathLinkContext.Provider value={true}>
          <p>
            <a href="https://example.com">
              <MathInline content="x^2" />
            </a>
          </p>
        </InlineMathLinkContext.Provider>
      </TooltipProvider>
    )
    const expression = screen.getByLabelText("Math: x^2")
    fireEvent.mouseEnter(expression)
    expect(container.querySelector("p div, p pre, a button, a [tabindex]")).toBeNull()
    expect(expression.querySelector('[data-slot="copy-feedback-icon"]')).toBeNull()
    expect(fireEvent.click(expression)).toBe(true)
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it("keeps invalid TeX inline inside a paragraph and link", () => {
    const { container } = render(
      <TooltipProvider>
        <InlineMathLinkContext.Provider value={true}>
          <p>
            <a href="https://example.com">
              <MathInline content={"\\frac{"} />
            </a>
          </p>
        </InlineMathLinkContext.Provider>
      </TooltipProvider>
    )
    expect(screen.getByLabelText("Math: \\frac{")).toHaveTextContent("\\frac{")
    expect(container.querySelector(".katex-error")).toBeInTheDocument()
    expect(container.querySelector("p div, p pre, p figure, a button")).toBeNull()
  })

  it("keeps a returned math failure inline", () => {
    jest.mocked(renderMathSafe).mockReturnValue({ html: "", error: "Invalid TeX" })
    const { container } = render(
      <TooltipProvider>
        <p>
          <MathInline content="x" />
        </p>
      </TooltipProvider>
    )
    expect(screen.getByLabelText("Invalid math expression: x").tagName).toBe("CODE")
    expect(container.querySelector("p div, p pre, p figure")).toBeNull()
  })

  it("recovers from a thrown renderer error without inserting block UI in the paragraph", async () => {
    const user = userEvent.setup()
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined)
    jest.mocked(renderMathSafe).mockImplementation(() => {
      throw new Error("renderer crashed")
    })
    try {
      const { container } = render(
        <TooltipProvider>
          <p>
            <MathInline content="x^2" />
          </p>
        </TooltipProvider>
      )
      expect(container.querySelector("p div, p pre, p figure, a button")).toBeNull()
      screen.getByRole("button", { name: "Math render error" }).focus()
      await user.keyboard("{Enter}")
      expect(await screen.findByRole("dialog")).toHaveTextContent("renderer crashed")
      expect(container.querySelector("p div, p pre, p figure, a button")).toBeNull()

      jest
        .mocked(renderMathSafe)
        .mockImplementation(jest.requireActual("@cognia/latex").renderMathSafe)
      fireEvent.click(screen.getByRole("button", { name: "Retry" }))
      expect(await screen.findByLabelText("Math: x^2")).toBeInTheDocument()
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
      expect(container.querySelector("p div, p pre, p figure, a button")).toBeNull()
      expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(
        /cannot (?:contain|be)|hydration/i
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})
