/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { defaultLabelColor } from "@/types/labels"
import { LabelChip } from "./label-chip"

const LABEL = { id: "l1", name: "bug", color: "oklch(0.65 0.19 25)" }

describe("LabelChip", () => {
  it("renders the name under a stable test id", () => {
    render(<LabelChip label={LABEL} />)
    expect(screen.getByText("bug")).toBeInTheDocument()
    expect(screen.getByTestId("label-chip-l1")).toBeInTheDocument()
  })

  it("paints the dot with the label's colour", () => {
    const { container } = render(<LabelChip label={LABEL} />)
    const dot = container.querySelector("[aria-hidden]") as HTMLElement | null
    expect(dot?.style.backgroundColor).not.toBe("")
  })

  it("falls back to a deterministic colour when the row has none", () => {
    const { container, rerender } = render(<LabelChip label={{ id: "l2", name: "chore" }} />)
    const first = (container.querySelector("[aria-hidden]") as HTMLElement).style.backgroundColor
    rerender(<LabelChip label={{ id: "l2", name: "chore" }} />)
    const second = (container.querySelector("[aria-hidden]") as HTMLElement).style.backgroundColor
    expect(first).toBe(second)
    expect(defaultLabelColor("chore")).toBeTruthy()
  })

  it("renders no remove button without onRemove", () => {
    render(<LabelChip label={LABEL} />)
    expect(screen.queryByTestId("label-chip-remove-l1")).not.toBeInTheDocument()
  })

  it("calls onRemove and exposes the caller's accessible label", () => {
    const onRemove = jest.fn()
    render(<LabelChip label={LABEL} onRemove={onRemove} removeLabel="移除 bug" />)
    fireEvent.click(screen.getByRole("button", { name: "移除 bug" }))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it("falls back to an English aria-label only when the caller supplies none", () => {
    render(<LabelChip label={LABEL} onRemove={jest.fn()} />)
    expect(screen.getByRole("button", { name: "Remove bug" })).toBeInTheDocument()
  })
})
