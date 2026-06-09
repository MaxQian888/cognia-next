import { fireEvent, render, screen } from "@testing-library/react"
import { CommandParamForm } from "./command-param-form"
import type { SlashCommand } from "@/lib/slash-commands/builtin"

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
})
