import { fireEvent, render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { RichBlockAction } from "./rich-block-action"

describe("RichBlockAction", () => {
  it("is a 24px labelled ghost button with a 14px glyph", () => {
    const onClick = jest.fn()
    render(
      <TooltipProvider>
        <RichBlockAction label="Copy table" onClick={onClick}>
          <svg />
        </RichBlockAction>
      </TooltipProvider>
    )
    const button = screen.getByRole("button", { name: "Copy table" })
    expect(button).toHaveClass("size-6", "[&_svg]:size-3.5")
    expect(button).toHaveAttribute("type", "button")
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("shrinks in compact frames and forwards pressed state", () => {
    render(
      <TooltipProvider>
        <RichBlockAction label="Wrap" tooltip="Wrap lines" compact aria-pressed>
          <svg />
        </RichBlockAction>
      </TooltipProvider>
    )
    const button = screen.getByRole("button", { name: "Wrap" })
    expect(button).toHaveClass("size-5", "[&_svg]:size-3")
    expect(button).toHaveAttribute("aria-pressed", "true")
  })
})
