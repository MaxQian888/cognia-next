/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PerformanceTierPopover } from "./performance-tier-popover"

function renderPopover(props: Partial<React.ComponentProps<typeof PerformanceTierPopover>> = {}) {
  const onChange = jest.fn()
  const utils = render(
    <TooltipProvider>
      <PerformanceTierPopover
        value={props.value ?? "auto"}
        effective={props.effective ?? "balanced"}
        onChange={props.onChange ?? onChange}
      />
    </TooltipProvider>
  )
  return { ...utils, onChange: props.onChange ?? onChange }
}

function openPopover() {
  fireEvent.click(screen.getByTestId("perf-tier-trigger"))
}

describe("PerformanceTierPopover", () => {
  it("renders the trigger button with an aria-label from i18n", () => {
    renderPopover()
    const trigger = screen.getByTestId("perf-tier-trigger")
    expect(trigger.getAttribute("aria-label")).toBe("Performance tier")
  })

  it("opens the popover and lists all four tier options", () => {
    renderPopover()
    openPopover()
    expect(screen.getAllByText("Auto").length).toBeGreaterThan(0)
    expect(screen.getByText("High")).toBeInTheDocument()
    expect(screen.getByText("Balanced")).toBeInTheDocument()
    expect(screen.getByText("Reduced")).toBeInTheDocument()
  })

  it("renders the 'effective: …' footer when value is auto", () => {
    renderPopover({ value: "auto", effective: "balanced" })
    openPopover()
    const footer = screen.getByTestId("perf-tier-effective-footer")
    expect(footer.textContent).toContain("Balanced")
  })

  it("hides the 'effective: …' footer when value is an explicit tier", () => {
    renderPopover({ value: "high", effective: "high" })
    openPopover()
    expect(screen.queryByTestId("perf-tier-effective-footer")).toBeNull()
  })

  it("emits onChange when a different radio is selected", () => {
    const onChange = jest.fn()
    renderPopover({ value: "auto", effective: "high", onChange })
    openPopover()
    fireEvent.click(screen.getByLabelText("Reduced"))
    expect(onChange).toHaveBeenCalledWith("reduced")
  })
})
