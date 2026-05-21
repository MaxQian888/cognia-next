/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

import { SelectablePresetCard } from "./selectable-preset-card"

describe("SelectablePresetCard", () => {
  it("renders the title and subtitle", () => {
    render(<SelectablePresetCard title="My preset" subtitle="A description" />)
    expect(screen.getByText("My preset")).toBeInTheDocument()
    expect(screen.getByText("A description")).toBeInTheDocument()
  })

  it("renders the badge with the supplied label", () => {
    render(<SelectablePresetCard title="X" badge="active" badgeLabel="Active" />)
    const badge = screen.getByTestId("selectable-preset-card-badge")
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveTextContent("Active")
  })

  it("renders the leading, details, and actions slots when provided", () => {
    render(
      <SelectablePresetCard
        title="X"
        leading={<span data-testid="lead">L</span>}
        details={<span>D</span>}
        actions={<button type="button">A</button>}
      />
    )
    expect(screen.getByTestId("lead")).toBeInTheDocument()
    expect(screen.getByText("D")).toBeInTheDocument()
    expect(screen.getByText("A")).toBeInTheDocument()
    expect(screen.getByTestId("selectable-preset-card-actions")).toBeInTheDocument()
  })

  it("is non-interactive without onClick", () => {
    render(<SelectablePresetCard title="X" testId="card" />)
    const card = screen.getByTestId("card")
    expect(card).not.toHaveAttribute("role", "button")
    expect(card).not.toHaveAttribute("tabIndex")
  })

  it("is interactive when onClick is provided", () => {
    const onClick = jest.fn()
    render(<SelectablePresetCard title="X" testId="card" onClick={onClick} />)
    const card = screen.getByTestId("card")
    expect(card).toHaveAttribute("role", "button")
    expect(card.tabIndex).toBe(0)
    fireEvent.click(card)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("invokes onClick when Enter is pressed", () => {
    const onClick = jest.fn()
    render(<SelectablePresetCard title="X" testId="card" onClick={onClick} />)
    fireEvent.keyDown(screen.getByTestId("card"), { key: "Enter" })
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("invokes onClick when Space is pressed", () => {
    const onClick = jest.fn()
    render(<SelectablePresetCard title="X" testId="card" onClick={onClick} />)
    fireEvent.keyDown(screen.getByTestId("card"), { key: " " })
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("ignores other keys", () => {
    const onClick = jest.fn()
    render(<SelectablePresetCard title="X" testId="card" onClick={onClick} />)
    fireEvent.keyDown(screen.getByTestId("card"), { key: "Tab" })
    expect(onClick).not.toHaveBeenCalled()
  })

  it("does not invoke onClick when disabled", () => {
    const onClick = jest.fn()
    render(<SelectablePresetCard title="X" testId="card" onClick={onClick} disabled />)
    const card = screen.getByTestId("card")
    expect(card).not.toHaveAttribute("role", "button")
    expect(card).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(card)
    expect(onClick).not.toHaveBeenCalled()
  })

  it("reflects selected state via aria-pressed when interactive", () => {
    render(<SelectablePresetCard title="X" testId="card" onClick={() => undefined} selected />)
    expect(screen.getByTestId("card")).toHaveAttribute("aria-pressed", "true")
  })

  it("does not set aria-pressed when non-interactive", () => {
    render(<SelectablePresetCard title="X" testId="card" selected />)
    expect(screen.getByTestId("card")).not.toHaveAttribute("aria-pressed")
  })

  it("maps each badge variant correctly", () => {
    const variants: Array<["active" | "inactive" | "builtin" | "default" | "favorite", string]> = [
      ["active", "default"],
      ["inactive", "outline"],
      ["builtin", "secondary"],
      ["default", "default"],
      ["favorite", "default"],
    ]
    for (const [badge] of variants) {
      const { unmount } = render(
        <SelectablePresetCard title="X" badge={badge} badgeLabel={badge} testId={`card-${badge}`} />
      )
      expect(screen.getByTestId("selectable-preset-card-badge")).toHaveTextContent(badge)
      unmount()
    }
  })
})
