import { createRef } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Dialog } from "@/components/ui/dialog"
import { ContextPreviewDialogContent, ContextPreviewDialogHeader } from "./context-preview-dialog"

it("shares a fixed frame and one header toolbar with a standard close control", async () => {
  const onOpenChange = jest.fn()
  const titleRef = createRef<HTMLHeadingElement>()
  render(
    <Dialog open onOpenChange={onOpenChange}>
      <ContextPreviewDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          titleRef.current?.focus()
        }}
      >
        <ContextPreviewDialogHeader
          title="Preview title"
          titleRef={titleRef}
          description="Source details"
          toolbarLabel="Preview controls"
        >
          <button type="button">Copy</button>
        </ContextPreviewDialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">Preview body</div>
      </ContextPreviewDialogContent>
    </Dialog>
  )
  const dialog = screen.getByRole("dialog", { name: "Preview title" })
  expect(dialog).toHaveClass("h-[min(85dvh,720px)]", "w-[min(94vw,1200px)]", "gap-0", "p-0")
  expect(screen.getByRole("heading")).toHaveFocus()
  const toolbar = screen.getByRole("toolbar", { name: "Preview controls" })
  const close = within(toolbar).getByRole("button", { name: "Close" })
  expect(close).toHaveAttribute("data-variant", "ghost")
  expect(close).toHaveAttribute("data-size", "icon-sm")
  expect(within(dialog).getAllByRole("button", { name: "Close" })).toHaveLength(1)
  await userEvent.setup().click(close)
  expect(onOpenChange).toHaveBeenCalledWith(false)
})
