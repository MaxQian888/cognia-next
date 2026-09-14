/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import { QuoteIcon } from "lucide-react"

import {
  FLOATING_BAR_BUTTON_CLASS,
  FLOATING_BAR_CLASS,
  FloatingBarAction,
} from "./floating-action-bar"

describe("FloatingBarAction", () => {
  it("is a button named by its label, which is also shown", () => {
    const onClick = jest.fn()
    render(<FloatingBarAction label="Reference" icon={QuoteIcon} onClick={onClick} />)
    const button = screen.getByRole("button", { name: "Reference" })
    expect(button).toHaveAttribute("type", "button")
    expect(button).toHaveAttribute("title", "Reference")
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("passes through what a menu trigger or a test needs", () => {
    render(
      <FloatingBarAction
        label="Translate"
        icon={QuoteIcon}
        disabled
        aria-haspopup="menu"
        data-testid="translate"
      />
    )
    const button = screen.getByTestId("translate")
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute("aria-haspopup", "menu")
  })

  // On the inverse ground the ghost variant's light hover would vanish.
  it("carries the inverse-ground treatment in both themes", () => {
    render(<FloatingBarAction label="Copy" icon={QuoteIcon} />)
    const cls = screen.getByRole("button").className
    for (const token of FLOATING_BAR_BUTTON_CLASS.split(" ")) expect(cls).toContain(token)
    expect(FLOATING_BAR_CLASS).toContain("bg-foreground")
  })

  it("stacks the label under the icon, and only goes inline in a wide message list", () => {
    const { rerender } = render(<FloatingBarAction label="Save as memory" icon={QuoteIcon} />)
    const stacked = screen.getByRole("button").className
    expect(stacked).toContain("flex-col")
    expect(stacked).not.toContain("@xl/message-list:flex-row")
    // Two lines rather than an ellipsis that hides the verb.
    expect(screen.getByText("Save as memory")).toHaveClass("line-clamp-2")

    rerender(<FloatingBarAction label="Save as memory" icon={QuoteIcon} adaptive />)
    expect(screen.getByRole("button").className).toContain("@xl/message-list:flex-row")
  })
})
