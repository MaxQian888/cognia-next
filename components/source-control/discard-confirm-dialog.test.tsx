import { fireEvent, render, screen } from "@testing-library/react"
import { DiscardConfirmDialog } from "./discard-confirm-dialog"

describe("DiscardConfirmDialog", () => {
  it("renders nothing while closed", () => {
    render(<DiscardConfirmDialog open={false} onOpenChange={() => {}} onConfirm={() => {}} />)
    expect(screen.queryByTestId("discard-confirm")).not.toBeInTheDocument()
  })

  it("names the file when discarding a single file", () => {
    render(
      <DiscardConfirmDialog
        open
        onOpenChange={() => {}}
        onConfirm={() => {}}
        fileName="src/app.ts"
      />
    )
    expect(screen.getByTestId("discard-confirm")).toBeInTheDocument()
    expect(screen.getByText(/src\/app\.ts/)).toBeInTheDocument()
  })

  it("invokes onConfirm when the action is clicked", () => {
    const onConfirm = jest.fn()
    render(<DiscardConfirmDialog open onOpenChange={() => {}} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByTestId("discard-confirm-action"))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("closes via onOpenChange when cancelled", () => {
    const onOpenChange = jest.fn()
    const onConfirm = jest.fn()
    render(<DiscardConfirmDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} />)
    // The Cancel button is the AlertDialogCancel — clicking it requests a close.
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
