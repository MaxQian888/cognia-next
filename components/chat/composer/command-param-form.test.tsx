import { fireEvent, render, screen } from "@testing-library/react"
import { CommandParamForm } from "./command-param-form"
import type { SlashCommand } from "@/lib/slash-commands/builtin"

// Radix Select/Dialog rely on a few DOM APIs jsdom doesn't implement.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {}
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {}
  }
})

const ocrCmd: SlashCommand = {
  name: "ocr",
  description: "Extract text",
  scope: "builtin",
  params: [
    { name: "file", label: "File", type: "string", required: true, style: "positional" },
    {
      name: "provider",
      label: "Provider",
      type: "enum",
      options: ["auto", "tesseract"],
      default: "auto",
    },
    { name: "force", label: "Force", type: "boolean" },
  ],
}

describe("CommandParamForm", () => {
  it("renders nothing when command is null", () => {
    const { container } = render(
      <CommandParamForm command={null} onSubmit={jest.fn()} onCancel={jest.fn()} />
    )
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it("renders a field per param with the command name in the title", () => {
    render(<CommandParamForm command={ocrCmd} onSubmit={jest.fn()} onCancel={jest.fn()} />)
    expect(screen.getByText("Configure /ocr")).toBeInTheDocument()
    expect(screen.getByLabelText(/File/)).toBeInTheDocument()
    expect(screen.getByText("Provider")).toBeInTheDocument()
  })

  it("blocks insert and shows an error when a required field is empty", () => {
    const onSubmit = jest.fn()
    render(<CommandParamForm command={ocrCmd} onSubmit={onSubmit} onCancel={jest.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Insert" }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/Please fill in/)).toBeInTheDocument()
  })

  it("builds the args string from filled values on insert", () => {
    const onSubmit = jest.fn()
    render(<CommandParamForm command={ocrCmd} onSubmit={onSubmit} onCancel={jest.fn()} />)
    fireEvent.change(screen.getByLabelText(/File/), { target: { value: "doc.pdf" } })
    fireEvent.click(screen.getByRole("button", { name: "Insert" }))
    // positional file + default provider flag; boolean off → omitted
    expect(onSubmit).toHaveBeenCalledWith("doc.pdf --provider auto")
  })

  it("calls onCancel from the Cancel button", () => {
    const onCancel = jest.fn()
    render(<CommandParamForm command={ocrCmd} onSubmit={jest.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalled()
  })

  it("calls onCancel when dismissed via Escape", () => {
    const onCancel = jest.fn()
    render(<CommandParamForm command={ocrCmd} onSubmit={jest.fn()} onCancel={onCancel} />)
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(onCancel).toHaveBeenCalled()
  })

  it("submits on Enter from a text field", () => {
    const onSubmit = jest.fn()
    render(<CommandParamForm command={ocrCmd} onSubmit={onSubmit} onCancel={jest.fn()} />)
    const file = screen.getByLabelText(/File/)
    fireEvent.change(file, { target: { value: "doc.pdf" } })
    fireEvent.keyDown(file, { key: "Enter" })
    expect(onSubmit).toHaveBeenCalledWith("doc.pdf --provider auto")
  })

  it("toggles a boolean param into a bare flag", () => {
    const onSubmit = jest.fn()
    render(<CommandParamForm command={ocrCmd} onSubmit={onSubmit} onCancel={jest.fn()} />)
    fireEvent.change(screen.getByLabelText(/File/), { target: { value: "doc.pdf" } })
    fireEvent.click(screen.getByRole("switch"))
    fireEvent.click(screen.getByRole("button", { name: "Insert" }))
    expect(onSubmit).toHaveBeenCalledWith("doc.pdf --provider auto --force")
  })

  it("clears a boolean flag when toggled off again", () => {
    const onSubmit = jest.fn()
    render(<CommandParamForm command={ocrCmd} onSubmit={onSubmit} onCancel={jest.fn()} />)
    fireEvent.change(screen.getByLabelText(/File/), { target: { value: "doc.pdf" } })
    const sw = screen.getByRole("switch")
    fireEvent.click(sw) // on
    fireEvent.click(sw) // off → exercises the falsy branch of the toggle
    fireEvent.click(screen.getByRole("button", { name: "Insert" }))
    expect(onSubmit).toHaveBeenCalledWith("doc.pdf --provider auto")
  })

  it("changes an enum value via the select", () => {
    const onSubmit = jest.fn()
    render(<CommandParamForm command={ocrCmd} onSubmit={onSubmit} onCancel={jest.fn()} />)
    fireEvent.change(screen.getByLabelText(/File/), { target: { value: "doc.pdf" } })
    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(screen.getByRole("option", { name: "tesseract" }))
    fireEvent.click(screen.getByRole("button", { name: "Insert" }))
    expect(onSubmit).toHaveBeenCalledWith("doc.pdf --provider tesseract")
  })

  it("renders nothing for a command that declares no params", () => {
    const noParams: SlashCommand = { name: "x", description: "", scope: "builtin" }
    const { container } = render(
      <CommandParamForm command={noParams} onSubmit={jest.fn()} onCancel={jest.fn()} />
    )
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it("handles an enum param with no options", () => {
    const c: SlashCommand = {
      name: "e",
      description: "",
      scope: "builtin",
      params: [{ name: "mode", label: "Mode", type: "enum" }],
    }
    render(<CommandParamForm command={c} onSubmit={jest.fn()} onCancel={jest.fn()} />)
    expect(screen.getByText("Mode")).toBeInTheDocument()
  })

  it("renders a number input and emits its flag", () => {
    const numCmd: SlashCommand = {
      name: "n",
      description: "",
      scope: "builtin",
      params: [{ name: "count", label: "Count", type: "number" }],
    }
    const onSubmit = jest.fn()
    render(<CommandParamForm command={numCmd} onSubmit={onSubmit} onCancel={jest.fn()} />)
    const input = screen.getByLabelText("Count")
    expect(input).toHaveAttribute("type", "number")
    fireEvent.change(input, { target: { value: "3" } })
    fireEvent.click(screen.getByRole("button", { name: "Insert" }))
    expect(onSubmit).toHaveBeenCalledWith("--count 3")
  })
})
