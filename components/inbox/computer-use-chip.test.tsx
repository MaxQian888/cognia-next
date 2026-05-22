/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"
import enMessages from "@/i18n/messages/en.json"
import { ComputerUseChip } from "./computer-use-chip"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      <TooltipProvider>{ui}</TooltipProvider>
    </NextIntlClientProvider>
  )
}

describe("ComputerUseChip", () => {
  it("renders nothing when active=false", () => {
    const { container } = wrap(<ComputerUseChip active={false} />)
    expect(container.querySelector("[data-testid='computer-use-chip']")).toBeNull()
  })

  it("renders the chip when active=true with the aria label from i18n", () => {
    wrap(<ComputerUseChip active />)
    const chip = screen.getByTestId("computer-use-chip")
    expect(chip).toBeInTheDocument()
    expect(chip.getAttribute("aria-label")).toBeTruthy()
  })

  it("applies the extra className passed in via props", () => {
    wrap(<ComputerUseChip active className="ml-2" />)
    expect(screen.getByTestId("computer-use-chip").className).toContain("ml-2")
  })
})
