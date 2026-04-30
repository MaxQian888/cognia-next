/**
 * @jest-environment jsdom
 */
import type { ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { TooltipIconButton } from "./tooltip-icon-button"

function withProvider(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe("TooltipIconButton", () => {
  it("renders the icon, exposes the aria-label, and forwards click", () => {
    const onClick = jest.fn()
    withProvider(
      <TooltipIconButton tooltip="Copy" aria-label="Copy" onClick={onClick}>
        <svg data-testid="copy-icon" />
      </TooltipIconButton>
    )

    const btn = screen.getByRole("button", { name: "Copy" })
    expect(btn).toBeInTheDocument()
    expect(screen.getByTestId("copy-icon")).toBeInTheDocument()

    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("respects the disabled prop", () => {
    withProvider(
      <TooltipIconButton tooltip="x" aria-label="x" disabled>
        <span />
      </TooltipIconButton>
    )
    expect(screen.getByRole("button", { name: "x" })).toBeDisabled()
  })

  it("applies the supplied variant/size/className overrides", () => {
    withProvider(
      <TooltipIconButton
        tooltip="t"
        aria-label="t"
        variant="outline"
        size="icon"
        className="custom-class"
      >
        <span />
      </TooltipIconButton>
    )
    const btn = screen.getByRole("button", { name: "t" })
    expect(btn).toHaveAttribute("data-variant", "outline")
    expect(btn).toHaveAttribute("data-size", "icon")
    expect(btn.className).toContain("custom-class")
  })

  it("forwards refs to the underlying button", () => {
    const ref = { current: null as HTMLButtonElement | null }
    withProvider(
      <TooltipIconButton ref={ref} tooltip="t" aria-label="t">
        <span />
      </TooltipIconButton>
    )
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })
})
