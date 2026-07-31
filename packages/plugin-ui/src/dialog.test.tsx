import { fireEvent, render, screen } from "@testing-library/react"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog"

describe("Dialog", () => {
  it("opens an accessible modal and uses the plugin-provided close label", () => {
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent closeLabel="Dismiss">
          <DialogTitle>Confirm change</DialogTitle>
          <DialogDescription>Review the change.</DialogDescription>
        </DialogContent>
      </Dialog>
    )

    fireEvent.click(screen.getByRole("button", { name: "Open" }))

    expect(screen.getByRole("dialog", { name: "Confirm change" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument()
  })

  it("uses localized text for an optional footer close button", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent closeLabel="Dismiss">
          <DialogTitle>Confirm change</DialogTitle>
          <DialogFooter showCloseButton closeLabel="Cancel" />
        </DialogContent>
      </Dialog>
    )

    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })

  it("composes the header and explicit close primitive", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent closeLabel="Dismiss">
          <DialogHeader>
            <DialogTitle>Details</DialogTitle>
          </DialogHeader>
          <DialogClose>Done</DialogClose>
        </DialogContent>
      </Dialog>
    )

    expect(screen.getByRole("heading", { name: "Details" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument()
  })
})
