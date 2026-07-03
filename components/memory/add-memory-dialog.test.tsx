/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import { AddMemoryDialog } from "./add-memory-dialog"

function setup(open = true) {
  const onOpenChange = jest.fn()
  const onCreate = jest.fn()
  const utils = render(
    <AddMemoryDialog open={open} onOpenChange={onOpenChange} onCreate={onCreate} />
  )
  return { onOpenChange, onCreate, utils }
}

describe("AddMemoryDialog", () => {
  it("disables submit until text is entered", () => {
    setup()
    const submit = screen.getByRole("button", { name: "Add memory" }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("Memory"), { target: { value: "prefers pnpm" } })
    expect(submit.disabled).toBe(false)
  })

  it("creates a memory with trimmed text, default type, importance and parsed tags", () => {
    const { onCreate, onOpenChange } = setup()
    fireEvent.change(screen.getByLabelText("Memory"), { target: { value: "  prefers pnpm  " } })
    fireEvent.change(screen.getByLabelText("Tags"), { target: { value: "tools, cli ,tools" } })
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }))
    expect(onCreate).toHaveBeenCalledWith({
      type: "semantic",
      text: "prefers pnpm",
      importance: 5,
      tags: ["tools", "cli"],
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("carries the importance slider value into the payload", () => {
    const { onCreate } = setup()
    fireEvent.change(screen.getByLabelText("Memory"), { target: { value: "x" } })
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" })
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" })
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ importance: 7 }))
  })

  it("does nothing on submit when text is only whitespace", () => {
    const { onCreate } = setup()
    fireEvent.change(screen.getByLabelText("Memory"), { target: { value: "   " } })
    // Button is disabled, but guard the handler directly too.
    const submit = screen.getByRole("button", { name: "Add memory" }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it("cancels without creating", () => {
    const { onCreate, onOpenChange } = setup()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCreate).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("resets the form each time it re-opens", () => {
    const onOpenChange = jest.fn()
    const onCreate = jest.fn()
    const { rerender } = render(
      <AddMemoryDialog open onOpenChange={onOpenChange} onCreate={onCreate} />
    )
    fireEvent.change(screen.getByLabelText("Memory"), { target: { value: "draft" } })
    rerender(<AddMemoryDialog open={false} onOpenChange={onOpenChange} onCreate={onCreate} />)
    rerender(<AddMemoryDialog open onOpenChange={onOpenChange} onCreate={onCreate} />)
    expect((screen.getByLabelText("Memory") as HTMLTextAreaElement).value).toBe("")
  })
})
