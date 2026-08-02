/**
 * @jest-environment jsdom
 */

import { fireEvent, render, waitFor } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { MathInline } from "./math-inline"

describe("MathInline", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
    })
  })

  it("shows copy feedback only after the expression is copied", async () => {
    const { container } = render(
      <TooltipProvider>
        <MathInline content="$x^2$" />
      </TooltipProvider>
    )
    const expression = container.querySelector<HTMLElement>('[role="math"]')!

    fireEvent.mouseEnter(expression)
    expect(expression.querySelector('[data-state="idle"]')).toBeInTheDocument()

    fireEvent.click(expression)
    await waitFor(() =>
      expect(expression.querySelector('[data-state="copied"]')).toBeInTheDocument()
    )
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("x^2")
  })
})
