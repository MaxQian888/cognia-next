import { render, screen, fireEvent } from "@testing-library/react"
import { DomainListInput } from "./domain-list-input"

// Shared stub: components/ui/__mocks__/scroll-area.tsx
jest.mock("@/components/ui/scroll-area")

describe("DomainListInput", () => {
  it("renders string label as Label and renders existing domains", () => {
    render(
      <DomainListInput
        label="Allow"
        placeholder="add..."
        domains={["a.com", "b.com"]}
        onAdd={jest.fn()}
        onRemove={jest.fn()}
      />
    )
    expect(screen.getByText("Allow")).toBeInTheDocument()
    expect(screen.getByText("a.com")).toBeInTheDocument()
    expect(screen.getByText("b.com")).toBeInTheDocument()
  })

  it("renders ReactNode label as-is", () => {
    render(
      <DomainListInput
        label={<span data-testid="custom-label">Custom</span>}
        placeholder="p"
        domains={[]}
        onAdd={jest.fn()}
        onRemove={jest.fn()}
      />
    )
    expect(screen.getByTestId("custom-label")).toBeInTheDocument()
  })

  it("calls onAdd with trimmed value on Enter then clears input", () => {
    const onAdd = jest.fn()
    render(
      <DomainListInput
        label="L"
        placeholder="add"
        domains={[]}
        onAdd={onAdd}
        onRemove={jest.fn()}
      />
    )
    const input = screen.getByPlaceholderText("add") as HTMLInputElement
    fireEvent.change(input, { target: { value: "  example.com  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onAdd).toHaveBeenCalledWith("example.com")
    expect(input.value).toBe("")
  })

  it("does not call onAdd on Enter when value is empty", () => {
    const onAdd = jest.fn()
    render(
      <DomainListInput
        label="L"
        placeholder="add"
        domains={[]}
        onAdd={onAdd}
        onRemove={jest.fn()}
      />
    )
    const input = screen.getByPlaceholderText("add")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onAdd).not.toHaveBeenCalled()
  })

  it("does not call onAdd on non-Enter keys", () => {
    const onAdd = jest.fn()
    render(
      <DomainListInput
        label="L"
        placeholder="add"
        domains={[]}
        onAdd={onAdd}
        onRemove={jest.fn()}
      />
    )
    const input = screen.getByPlaceholderText("add")
    fireEvent.change(input, { target: { value: "x" } })
    fireEvent.keyDown(input, { key: "a" })
    expect(onAdd).not.toHaveBeenCalled()
  })

  it("renders + button when showAddButton, disabled while empty, calls onAdd on click", () => {
    const onAdd = jest.fn()
    render(
      <DomainListInput
        label="L"
        placeholder="p"
        domains={[]}
        onAdd={onAdd}
        onRemove={jest.fn()}
        showAddButton
      />
    )
    const buttons = screen.getAllByRole("button")
    const addBtn = buttons[buttons.length - 1]
    expect(addBtn).toBeDisabled()
    const input = screen.getByPlaceholderText("p")
    fireEvent.change(input, { target: { value: "z.com" } })
    expect(addBtn).not.toBeDisabled()
    fireEvent.click(addBtn)
    expect(onAdd).toHaveBeenCalledWith("z.com")
  })

  it("calls onRemove with correct domain when X clicked", () => {
    const onRemove = jest.fn()
    render(
      <DomainListInput
        label="L"
        placeholder="p"
        domains={["foo.com", "bar.com"]}
        onAdd={jest.fn()}
        onRemove={onRemove}
        removeAriaLabel={(d) => `Remove ${d}`}
      />
    )
    fireEvent.click(screen.getByLabelText("Remove foo.com"))
    expect(onRemove).toHaveBeenCalledWith("foo.com")
  })

  it("wraps badges in ScrollArea when scrollable", () => {
    render(
      <DomainListInput
        label="L"
        placeholder="p"
        domains={["a.com"]}
        onAdd={jest.fn()}
        onRemove={jest.fn()}
        scrollable
      />
    )
    expect(screen.getByTestId("scroll-area")).toBeInTheDocument()
  })

  it("does not render badges container when no domains", () => {
    render(
      <DomainListInput
        label="L"
        placeholder="p"
        domains={[]}
        onAdd={jest.fn()}
        onRemove={jest.fn()}
        scrollable
      />
    )
    expect(screen.queryByTestId("scroll-area")).not.toBeInTheDocument()
  })

  it("renders badge icon when supplied", () => {
    render(
      <DomainListInput
        label="L"
        placeholder="p"
        domains={["d.com"]}
        onAdd={jest.fn()}
        onRemove={jest.fn()}
        badgeIcon={<span data-testid="b-icon">i</span>}
      />
    )
    expect(screen.getByTestId("b-icon")).toBeInTheDocument()
  })
})
