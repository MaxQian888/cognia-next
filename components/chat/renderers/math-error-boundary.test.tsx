/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { InlineMathLinkContext, MathErrorFallback } from "./math-error-boundary"

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

  it("keeps inline errors phrasing-only and places recovery controls outside the paragraph", async () => {
    const retry = jest.fn()
    const { container } = render(
      <TooltipProvider>
        <p>
          <MathErrorFallback error={new Error("bad latex")} latex="x^2" onRetry={retry} inline />
        </p>
      </TooltipProvider>
    )
    expect(container.querySelector("p div, p pre, p p, a button")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Math render error" }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog.closest("p, a")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Copy source" }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("x^2"))
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it("keeps an error within a link passive and free of nested controls", () => {
    const { container } = render(
      <TooltipProvider>
        <InlineMathLinkContext.Provider value={true}>
          <p>
            <a href="https://example.com">
              <MathErrorFallback error={new Error("bad latex")} latex="x^2" inline />
            </a>
          </p>
        </InlineMathLinkContext.Provider>
      </TooltipProvider>
    )
    expect(screen.getByRole("link")).toHaveTextContent("x^2")
    expect(container.querySelector("p div, p pre, p p, a button, a [tabindex]")).toBeNull()
  })
})
