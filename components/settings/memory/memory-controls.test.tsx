/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { GatedGroup, MemoryToggleRow, SliderRow } from "./memory-controls"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))

describe("MemoryToggleRow", () => {
  it("exposes an accessible switch and emits changes", () => {
    const onCheckedChange = jest.fn()
    render(
      <MemoryToggleRow
        id="memory-test"
        label="Use memories"
        description="Recall saved facts."
        checked={false}
        onCheckedChange={onCheckedChange}
      />
    )

    fireEvent.click(screen.getByRole("switch", { name: "Use memories" }))
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })
})

describe("GatedGroup", () => {
  it("makes a gated subtree inert and explains why", () => {
    render(
      <GatedGroup gated reason="Turn memory on">
        <button type="button">Nested control</button>
      </GatedGroup>
    )

    expect(screen.getByTestId("memory-gate-reason")).toHaveTextContent("Turn memory on")
    expect(screen.getByRole("button", { name: "Nested control" }).parentElement).toHaveAttribute(
      "inert"
    )
  })
})

describe("SliderRow", () => {
  it("labels the slider, shows the raw value and describes it", () => {
    render(
      <SliderRow
        id="slider-test"
        label="Weight"
        description="How much it counts."
        value={3}
        min={0}
        max={10}
        step={1}
        onChange={jest.fn()}
      />
    )

    const slider = screen.getByRole("slider", { name: "Weight" })
    expect(slider).toHaveAttribute("aria-valuenow", "3")
    expect(slider).toHaveAttribute("aria-valuemin", "0")
    expect(slider).toHaveAttribute("aria-valuemax", "10")
    expect(screen.getByTestId("slider-test-value")).toHaveTextContent("3")
    expect(screen.getByText("How much it counts.")).toBeInTheDocument()
  })

  it("renders the readout through the formatter", () => {
    render(
      <SliderRow
        id="slider-test"
        label="Weight"
        description="d"
        value={0}
        min={0}
        max={2}
        step={0.1}
        format={(v) => (v === 0 ? "Off" : v.toFixed(1))}
        onChange={jest.fn()}
      />
    )
    expect(screen.getByTestId("slider-test-value")).toHaveTextContent("Off")
  })

  it("emits the next value by one step", () => {
    const onChange = jest.fn()
    render(
      <SliderRow
        id="slider-test"
        label="Weight"
        description="d"
        value={3}
        min={0}
        max={10}
        step={1}
        onChange={onChange}
      />
    )
    fireEvent.keyDown(screen.getByRole("slider", { name: "Weight" }), { key: "ArrowRight" })
    expect(onChange).toHaveBeenCalledWith(4)
  })
})
