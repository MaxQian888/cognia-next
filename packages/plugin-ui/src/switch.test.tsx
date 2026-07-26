import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { Switch } from "./switch"

// Radix gates its pointer handling on a `pointerType` check that fireEvent does
// not satisfy — userEvent is required (repo jest-gotchas #4).
const setup = () => userEvent.setup()

describe("Switch", () => {
  it("exposes the switch role rather than a checkbox", async () => {
    render(<Switch aria-label="Auto sync" />)

    // role="switch" is the whole reason this exists next to Checkbox: it tells
    // assistive tech the change commits immediately.
    const control = screen.getByRole("switch", { name: "Auto sync" })
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(control).toHaveAttribute("data-slot", "switch")
    expect(control).toHaveAttribute("data-state", "unchecked")
  })

  it("toggles and reports the new value when uncontrolled", async () => {
    const user = setup()
    const onCheckedChange = jest.fn()
    render(<Switch aria-label="Auto sync" onCheckedChange={onCheckedChange} />)

    const control = screen.getByRole("switch")
    await user.click(control)

    expect(onCheckedChange).toHaveBeenCalledWith(true)
    expect(control).toHaveAttribute("data-state", "checked")
    expect(control).toBeChecked()
  })

  it("stays put under caller control when checked is pinned", async () => {
    const user = setup()
    const onCheckedChange = jest.fn()
    render(<Switch aria-label="Auto sync" checked onCheckedChange={onCheckedChange} />)

    const control = screen.getByRole("switch")
    await user.click(control)

    // Controlled: Radix asks, the plugin decides — state must not self-flip.
    expect(onCheckedChange).toHaveBeenCalledWith(false)
    expect(control).toHaveAttribute("data-state", "checked")
  })

  it("toggles from the keyboard", async () => {
    const user = setup()
    const onCheckedChange = jest.fn()
    render(<Switch aria-label="Auto sync" onCheckedChange={onCheckedChange} />)

    await user.tab()
    expect(screen.getByRole("switch")).toHaveFocus()
    await user.keyboard(" ")

    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it("ignores interaction while disabled", async () => {
    const user = setup()
    const onCheckedChange = jest.fn()
    render(<Switch aria-label="Auto sync" disabled onCheckedChange={onCheckedChange} />)

    const control = screen.getByRole("switch")
    await user.click(control)

    expect(onCheckedChange).not.toHaveBeenCalled()
    expect(control).toBeDisabled()
  })

  it("defaults to the default size and drives the thumb from the root", () => {
    render(<Switch aria-label="Auto sync" />)

    const control = screen.getByRole("switch")
    expect(control).toHaveAttribute("data-size", "default")
    // The thumb takes no size prop of its own — it reads the root's data-size
    // through the group marker, so the two can never disagree.
    const thumb = control.querySelector("[data-slot='switch-thumb']")
    expect(control.className).toContain("group/switch")
    expect(thumb?.className).toContain("group-data-[size=default]/switch:size-4")
    expect(thumb?.className).toContain("group-data-[size=sm]/switch:size-3")
  })

  it("carries the compact size onto the root for the CSS to pick up", () => {
    render(<Switch aria-label="Auto sync" size="sm" />)

    const control = screen.getByRole("switch")
    expect(control).toHaveAttribute("data-size", "sm")
    expect(control.className).toContain("data-[size=sm]:w-6")
  })

  it("merges caller classes onto the root instead of dropping them", () => {
    render(<Switch aria-label="Auto sync" className="ml-2 shadow-none" />)

    const control = screen.getByRole("switch")
    expect(control.className).toContain("ml-2")
    // cn() resolved shadow-xs vs shadow-none rather than emitting both.
    expect(control.className).toContain("shadow-none")
    expect(control.className).not.toContain("shadow-xs")
  })

  it("submits a form value through the hidden native input", () => {
    render(
      <form aria-label="Settings">
        <Switch aria-label="Auto sync" name="autoSync" value="on" defaultChecked />
      </form>
    )

    // Radix mirrors the state into a hidden checkbox so plugins can use a plain
    // <form> rather than lifting the value into React state.
    const form = screen.getByRole("form")
    const native = form.querySelector<HTMLInputElement>("input[name='autoSync']")
    expect(native).not.toBeNull()
    expect(native?.checked).toBe(true)
  })
})
