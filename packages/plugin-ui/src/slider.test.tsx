import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { Slider } from "./slider"

/**
 * jsdom reports every element as 0×0, so pointer dragging cannot be simulated
 * meaningfully. Keyboard stepping exercises the same value pipeline and is the
 * path that has to work anyway — a slider that only responds to a drag is not
 * an accessible control.
 */
const setup = () => userEvent.setup()

describe("Slider", () => {
  it("renders one thumb for a scalar value", () => {
    render(<Slider aria-label="Volume" defaultValue={[40]} />)

    const thumbs = screen.getAllByRole("slider")
    expect(thumbs).toHaveLength(1)
    expect(thumbs[0]).toHaveAccessibleName("Volume")
  })

  it("renders one thumb per entry of a range value", () => {
    render(<Slider aria-label="Window" defaultValue={[20, 80]} />)

    expect(screen.getAllByRole("slider")).toHaveLength(2)
  })

  it("offers two thumb slots but exposes only the ones Radix has a value for", () => {
    const { container } = render(<Slider aria-label="Window" min={10} max={90} />)

    // With neither `value` nor `defaultValue`, the `[min, max]` fallback renders
    // two thumb slots while Radix's own default value list is just `[min]`. It
    // hides the surplus thumb with `display: none`, so exactly one reaches the
    // accessibility tree — the count can never disagree with the value array.
    expect(container.querySelectorAll("[data-slot='slider-thumb']")).toHaveLength(2)
    const thumbs = screen.getAllByRole("slider")
    expect(thumbs).toHaveLength(1)
    expect(thumbs[0]).toHaveAttribute("aria-valuemin", "10")
    expect(thumbs[0]).toHaveAttribute("aria-valuemax", "90")
    expect(thumbs[0]).toHaveAttribute("aria-valuenow", "10")
  })

  it("follows a controlled value's thumb count at runtime", () => {
    const { rerender } = render(<Slider aria-label="Window" value={[40]} />)
    expect(screen.getAllByRole("slider")).toHaveLength(1)

    rerender(<Slider aria-label="Window" value={[40, 60]} />)
    // Deriving from `value` is what lets a caller switch between one and two
    // handles without this component owning reconcilable state.
    expect(screen.getAllByRole("slider")).toHaveLength(2)
  })

  it("publishes the bounds and current position to assistive tech", () => {
    render(<Slider aria-label="Volume" defaultValue={[40]} min={0} max={200} />)

    const thumb = screen.getByRole("slider")
    expect(thumb).toHaveAttribute("aria-valuemin", "0")
    expect(thumb).toHaveAttribute("aria-valuemax", "200")
    expect(thumb).toHaveAttribute("aria-valuenow", "40")
  })

  it("steps on the arrow keys and reports the new value", async () => {
    const user = setup()
    const onValueChange = jest.fn()
    render(<Slider aria-label="Volume" defaultValue={[40]} onValueChange={onValueChange} />)

    screen.getByRole("slider").focus()
    await user.keyboard("{ArrowRight}")
    expect(onValueChange).toHaveBeenLastCalledWith([41])
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "41")
  })

  it("steps by the caller's step size", async () => {
    const user = setup()
    const onValueChange = jest.fn()
    render(
      <Slider aria-label="Volume" defaultValue={[40]} step={10} onValueChange={onValueChange} />
    )

    screen.getByRole("slider").focus()
    await user.keyboard("{ArrowLeft}")
    expect(onValueChange).toHaveBeenLastCalledWith([30])
  })

  it("clamps at the bounds instead of running past them", async () => {
    const user = setup()
    const onValueChange = jest.fn()
    render(
      <Slider aria-label="Volume" defaultValue={[100]} max={100} onValueChange={onValueChange} />
    )

    screen.getByRole("slider").focus()
    await user.keyboard("{ArrowRight}")
    expect(onValueChange).not.toHaveBeenCalled()
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "100")
  })

  it("defers to the caller when the value is controlled", async () => {
    const user = setup()
    const onValueChange = jest.fn()
    render(<Slider aria-label="Volume" value={[40]} onValueChange={onValueChange} />)

    screen.getByRole("slider").focus()
    await user.keyboard("{ArrowRight}")
    expect(onValueChange).toHaveBeenCalledWith([41])
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "40")
  })

  it("names every thumb of a range, not just the root", () => {
    render(
      <>
        <span id="window-label">Window</span>
        <Slider aria-labelledby="window-label" defaultValue={[20, 80]} />
      </>
    )

    // The thumbs are the elements that carry role="slider" and get announced,
    // so the label has to reach them and not stop at the root.
    for (const thumb of screen.getAllByRole("slider")) {
      expect(thumb).toHaveAccessibleName("Window")
    }
  })

  it("marks the vertical orientation on the whole assembly", () => {
    const { container } = render(
      <Slider aria-label="Volume" defaultValue={[40]} orientation="vertical" />
    )

    expect(screen.getByRole("slider")).toHaveAttribute("aria-orientation", "vertical")
    expect(container.querySelector("[data-slot='slider-track']")).toHaveAttribute(
      "data-orientation",
      "vertical"
    )
  })

  it("refuses input while disabled", async () => {
    const user = setup()
    const onValueChange = jest.fn()
    const { container } = render(
      <Slider aria-label="Volume" defaultValue={[40]} disabled onValueChange={onValueChange} />
    )

    screen.getByRole("slider").focus()
    await user.keyboard("{ArrowRight}")
    expect(onValueChange).not.toHaveBeenCalled()
    expect(container.querySelector("[data-slot='slider']")).toHaveAttribute("data-disabled")
  })

  it("merges caller classes rather than stacking a conflicting width", () => {
    const { container } = render(
      <Slider aria-label="Volume" defaultValue={[40]} className="w-40" />
    )

    const root = container.querySelector("[data-slot='slider']")
    expect(root?.className).toContain("w-40")
    // cn() resolved w-full against w-40 instead of emitting both.
    expect(root?.className).not.toContain("w-full")
  })

  it("stamps a data-slot on every part", () => {
    const { container } = render(<Slider aria-label="Volume" defaultValue={[40]} />)

    for (const slot of ["slider", "slider-track", "slider-range", "slider-thumb"]) {
      expect(container.querySelector(`[data-slot='${slot}']`)).not.toBeNull()
    }
  })
})
