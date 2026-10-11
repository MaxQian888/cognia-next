/** @jest-environment jsdom */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryDeleteConfirm } from "./memory-delete-confirm"

describe("MemoryDeleteConfirm", () => {
  it("stays closed with nothing pending", () => {
    render(<MemoryDeleteConfirm ids={null} onCancel={jest.fn()} onConfirm={jest.fn()} />)
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("names one memory and many differently", () => {
    const { rerender } = render(
      <MemoryDeleteConfirm ids={["a"]} onCancel={jest.fn()} onConfirm={jest.fn()} />
    )
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete this memory?")
    rerender(
      <MemoryDeleteConfirm ids={["a", "b", "c"]} onCancel={jest.fn()} onConfirm={jest.fn()} />
    )
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete 3 memories?")
  })

  it("confirms or cancels", async () => {
    const onCancel = jest.fn()
    const onConfirm = jest.fn()
    render(<MemoryDeleteConfirm ids={["a"]} onCancel={onCancel} onConfirm={onConfirm} />)
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" })
    )
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("reports a cancel", async () => {
    const onCancel = jest.fn()
    render(<MemoryDeleteConfirm ids={["a"]} onCancel={onCancel} onConfirm={jest.fn()} />)
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalled()
  })
})
