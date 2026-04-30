import { render, screen, fireEvent } from "@testing-library/react"
import { SourcePill } from "./source-pill"

describe("SourcePill", () => {
  it("renders with name and default icon when no icon provided", () => {
    render(
      <SourcePill
        sourceId="x"
        name="Hello"
        selected={false}
        disabled={false}
        onToggle={jest.fn()}
      />
    )
    expect(screen.getByText("Hello")).toBeInTheDocument()
    expect(screen.getByText("🔗")).toBeInTheDocument()
  })

  it("renders custom icon", () => {
    render(
      <SourcePill
        sourceId="x"
        name="Y"
        icon="🚀"
        selected={false}
        disabled={false}
        onToggle={jest.fn()}
      />
    )
    expect(screen.getByText("🚀")).toBeInTheDocument()
  })

  it("calls onToggle when clicked", () => {
    const onToggle = jest.fn()
    render(
      <SourcePill sourceId="x" name="A" selected={false} disabled={false} onToggle={onToggle} />
    )
    fireEvent.click(screen.getByRole("button", { name: /A/ }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it("shows check when selected", () => {
    const { container } = render(
      <SourcePill sourceId="x" name="B" selected disabled={false} onToggle={jest.fn()} />
    )
    expect(container.querySelector("svg")).toBeInTheDocument()
  })

  it("disables button when disabled prop is true", () => {
    const onToggle = jest.fn()
    render(<SourcePill sourceId="x" name="C" selected={false} disabled onToggle={onToggle} />)
    const btn = screen.getByRole("button", { name: /C/ })
    expect(btn).toBeDisabled()
  })

  it("renders remove handle and calls onRemove without triggering onToggle", () => {
    const onToggle = jest.fn()
    const onRemove = jest.fn()
    render(
      <SourcePill
        sourceId="x"
        name="D"
        selected
        disabled={false}
        onToggle={onToggle}
        onRemove={onRemove}
      />
    )
    fireEvent.click(screen.getByText("×"))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("does not render remove handle when onRemove is omitted", () => {
    render(
      <SourcePill sourceId="x" name="E" selected={false} disabled={false} onToggle={jest.fn()} />
    )
    expect(screen.queryByText("×")).not.toBeInTheDocument()
  })
})
