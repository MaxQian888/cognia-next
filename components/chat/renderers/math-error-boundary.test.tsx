/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { MathErrorFallback } from "./math-error-boundary"

describe("MathErrorFallback", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
    })
  })

  it("copies the original latex and renders successful feedback", async () => {
    render(
      <TooltipProvider>
        <MathErrorFallback error={new Error("bad latex")} latex={"\\bad"} />
      </TooltipProvider>
    )
    const copyIcon = document.querySelector('[data-slot="copy-feedback-icon"]')
    const copyButton = copyIcon?.closest("button")

    expect(copyButton).toBeTruthy()
    fireEvent.click(copyButton!)
    await waitFor(() =>
      expect(copyButton?.querySelector('[data-state="copied"]')).toBeInTheDocument()
    )
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("\\bad")
    expect(screen.getByText("bad latex")).toBeInTheDocument()
  })
})
