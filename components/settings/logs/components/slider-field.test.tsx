import { fireEvent, render, screen } from "@testing-library/react"

import { SliderField } from "./slider-field"

function renderField(overrides: Partial<React.ComponentProps<typeof SliderField>> = {}) {
  const onValueChange = jest.fn()
  render(
    <SliderField
      id="test-slider"
      label="Flush interval"
      valueLabel="2000 ms"
      value={2000}
      min={250}
      max={30000}
      step={250}
      onValueChange={onValueChange}
      {...overrides}
    />
  )
  return { onValueChange }
}

describe("SliderField", () => {
  it("renders the label and the formatted readout", () => {
    renderField()
    expect(screen.getByText("Flush interval")).toBeInTheDocument()
    // A slider with no visible number is unreadable — the readout is part of
    // the row rather than something each caller remembers to add.
    expect(screen.getByText("2000 ms")).toBeInTheDocument()
  })

  it("names the slider for assistive tech", () => {
    renderField()
    expect(screen.getByRole("slider", { name: "Flush interval" })).toBeInTheDocument()
  })

  it("reports the bounds and current value to assistive tech", () => {
    renderField()
    const slider = screen.getByRole("slider", { name: "Flush interval" })
    expect(slider).toHaveAttribute("aria-valuemin", "250")
    expect(slider).toHaveAttribute("aria-valuemax", "30000")
    expect(slider).toHaveAttribute("aria-valuenow", "2000")
  })

  it("emits a single number, not the array Radix hands back", () => {
    const { onValueChange } = renderField()
    const slider = screen.getByRole("slider", { name: "Flush interval" })

    slider.focus()
    fireEvent.keyDown(slider, { key: "ArrowRight" })

    expect(onValueChange).toHaveBeenCalledWith(2250)
  })

  it("renders an optional description", () => {
    renderField({ description: "How often batches are flushed." })
    expect(screen.getByText("How often batches are flushed.")).toBeInTheDocument()
  })

  it("keeps the label reachable when hidden visually", () => {
    // Sampling rows draw their own name + value header with a delete button,
    // so the field's header is hidden — but never removed from the a11y tree.
    renderField({ hideLabel: true })
    expect(screen.getByRole("slider", { name: "Flush interval" })).toBeInTheDocument()
    expect(screen.getByText("Flush interval")).toBeInTheDocument()
  })

  it("disables the slider when the setting it depends on is off", () => {
    const { onValueChange } = renderField({ disabled: true })
    const slider = screen.getByRole("slider", { name: "Flush interval" })

    slider.focus()
    fireEvent.keyDown(slider, { key: "ArrowRight" })

    expect(onValueChange).not.toHaveBeenCalled()
  })
})
