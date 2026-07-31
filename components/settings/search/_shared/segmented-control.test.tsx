import { render, screen, fireEvent } from "@testing-library/react"

import { SegmentedControl, type SegmentedOption } from "./segmented-control"

type Depth = "basic" | "advanced" | "deep"

const OPTIONS: SegmentedOption<Depth>[] = [
  { value: "basic", label: "Basic", description: "Fast" },
  { value: "advanced", label: "Advanced", description: "Balanced" },
  { value: "deep", label: "Deep", description: "Thorough" },
]

describe("SegmentedControl", () => {
  it("renders every option label (inline variant)", () => {
    render(
      <SegmentedControl<Depth>
        value="basic"
        onValueChange={jest.fn()}
        options={OPTIONS}
        aria-label="depth"
      />
    )
    expect(screen.getByText("Basic")).toBeInTheDocument()
    expect(screen.getByText("Advanced")).toBeInTheDocument()
    expect(screen.getByText("Deep")).toBeInTheDocument()
  })

  it("calls onValueChange with the clicked value", () => {
    const onValueChange = jest.fn()
    render(
      <SegmentedControl<Depth> value="basic" onValueChange={onValueChange} options={OPTIONS} />
    )
    fireEvent.click(screen.getByText("Deep"))
    expect(onValueChange).toHaveBeenCalledWith("deep")
  })

  it("ignores deselection of the active item (keeps radio semantics)", () => {
    const onValueChange = jest.fn()
    render(
      <SegmentedControl<Depth> value="basic" onValueChange={onValueChange} options={OPTIONS} />
    )
    // Re-clicking the selected item: Radix emits "" which must be swallowed.
    fireEvent.click(screen.getByText("Basic"))
    expect(onValueChange).not.toHaveBeenCalledWith("")
  })

  it("renders descriptions in the cards variant", () => {
    render(
      <SegmentedControl<Depth>
        value="advanced"
        onValueChange={jest.fn()}
        options={OPTIONS}
        variant="cards"
      />
    )
    expect(screen.getByText("Thorough")).toBeInTheDocument()
    // The active item exposes aria pressed state.
    expect(screen.getByRole("radio", { name: "Advanced" })).toHaveAttribute("data-state", "on")
  })

  it("disables every item when disabled", () => {
    render(
      <SegmentedControl<Depth> value="basic" onValueChange={jest.fn()} options={OPTIONS} disabled />
    )
    screen.getAllByRole("radio").forEach((item) => {
      expect(item).toBeDisabled()
    })
  })
})
