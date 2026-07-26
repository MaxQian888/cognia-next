import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { Label } from "./label"
import { RadioGroup, RadioGroupItem } from "./radio-group"

const setup = () => userEvent.setup()

function Choices(props: React.ComponentProps<typeof RadioGroup>) {
  return (
    <RadioGroup aria-label="Delivery" {...props}>
      <RadioGroupItem value="now" id="now" />
      <Label htmlFor="now">Now</Label>
      <RadioGroupItem value="later" id="later" />
      <Label htmlFor="later">Later</Label>
    </RadioGroup>
  )
}

describe("RadioGroup", () => {
  it("exposes a named radiogroup with one radio per item", () => {
    render(<Choices />)

    expect(screen.getByRole("radiogroup", { name: "Delivery" })).toBeInTheDocument()
    expect(screen.getAllByRole("radio")).toHaveLength(2)
    expect(screen.getByRole("radio", { name: "Now" })).toBeInTheDocument()
  })

  it("selects an item on click and reports the new value", async () => {
    const user = setup()
    const onValueChange = jest.fn()
    render(<Choices onValueChange={onValueChange} />)

    await user.click(screen.getByRole("radio", { name: "Later" }))
    expect(onValueChange).toHaveBeenCalledWith("later")
    expect(screen.getByRole("radio", { name: "Later" })).toBeChecked()
    expect(screen.getByRole("radio", { name: "Now" })).not.toBeChecked()
  })

  it("selects via the associated label", async () => {
    const user = setup()
    const onValueChange = jest.fn()
    render(<Choices onValueChange={onValueChange} />)

    await user.click(screen.getByText("Now"))
    expect(onValueChange).toHaveBeenCalledWith("now")
  })

  it("is a single tab stop with arrow keys moving focus", async () => {
    const user = setup()
    render(<Choices defaultValue="now" />)

    await user.tab()
    // Roving tabindex: focus lands on the checked radio, not the first DOM one,
    // and the group as a whole is one stop — the part a hand-rolled radio list
    // gets wrong, leaving one tab stop per option.
    expect(screen.getByRole("radio", { name: "Now" })).toHaveFocus()

    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("radio", { name: "Later" })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole("radio", { name: "Now" })).not.toHaveFocus()
    expect(screen.getByRole("radio", { name: "Later" })).not.toHaveFocus()
  })

  /**
   * Radix follows focus with a selection by clicking the newly-focused item
   * from its `onFocus`, gated on a document-level keydown flag. That ordering
   * only holds where focus events are queued as a task (per the HTML spec);
   * jsdom dispatches them synchronously, so the flag is still false when the
   * handler runs and the auto-select never fires. Space is asserted instead —
   * it is the same code path a keyboard user reaches without the timing quirk.
   */
  it("selects the focused item on Space", async () => {
    const user = setup()
    const onValueChange = jest.fn()
    render(<Choices defaultValue="now" onValueChange={onValueChange} />)

    // Radix's roving focus updates state from `onFocus`, so a bare .focus()
    // schedules a React update outside act().
    act(() => screen.getByRole("radio", { name: "Later" }).focus())
    await user.keyboard(" ")
    expect(onValueChange).toHaveBeenCalledWith("later")
    expect(screen.getByRole("radio", { name: "Later" })).toBeChecked()
  })

  it("mounts the dot only while an item is checked", () => {
    const { container } = render(<Choices defaultValue="later" />)

    const indicators = container.querySelectorAll("[data-slot='radio-group-indicator']")
    // One indicator, under the checked item — a stale dot is impossible because
    // the element does not exist when unchecked.
    expect(indicators).toHaveLength(1)
    expect(indicators[0].closest("[data-slot='radio-group-item']")).toBe(
      screen.getByRole("radio", { name: "Later" })
    )
  })

  it("defers to the caller when the value is controlled", async () => {
    const user = setup()
    const onValueChange = jest.fn()
    render(<Choices value="now" onValueChange={onValueChange} />)

    await user.click(screen.getByRole("radio", { name: "Later" }))
    expect(onValueChange).toHaveBeenCalledWith("later")
    expect(screen.getByRole("radio", { name: "Now" })).toBeChecked()
  })

  it("blocks the whole group when disabled", async () => {
    const user = setup()
    const onValueChange = jest.fn()
    render(<Choices disabled onValueChange={onValueChange} />)

    const item = screen.getByRole("radio", { name: "Now" })
    expect(item).toBeDisabled()
    await user.click(item)
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it("disables a single item without disabling its siblings", async () => {
    const user = setup()
    const onValueChange = jest.fn()
    render(
      <RadioGroup aria-label="Delivery" onValueChange={onValueChange}>
        <RadioGroupItem value="now" id="now" disabled />
        <Label htmlFor="now">Now</Label>
        <RadioGroupItem value="later" id="later" />
        <Label htmlFor="later">Later</Label>
      </RadioGroup>
    )

    await user.click(screen.getByRole("radio", { name: "Now" }))
    expect(onValueChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole("radio", { name: "Later" }))
    expect(onValueChange).toHaveBeenCalledWith("later")
  })

  it("merges caller classes rather than stacking conflicting utilities", () => {
    render(
      <RadioGroup aria-label="Delivery" className="gap-1">
        <RadioGroupItem value="now" id="now" className="size-5" />
        <Label htmlFor="now">Now</Label>
      </RadioGroup>
    )

    const group = screen.getByRole("radiogroup")
    expect(group.className).toContain("gap-1")
    // cn() resolved gap-3 against gap-1, and size-4 against size-5.
    expect(group.className).not.toContain("gap-3")
    const item = screen.getByRole("radio", { name: "Now" })
    expect(item.className).toContain("size-5")
    expect(item.className).not.toContain("size-4")
  })

  it("stamps a data-slot on every part", () => {
    const { container } = render(<Choices defaultValue="now" />)

    for (const slot of ["radio-group", "radio-group-item", "radio-group-indicator"]) {
      expect(container.querySelector(`[data-slot='${slot}']`)).not.toBeNull()
    }
  })
})
