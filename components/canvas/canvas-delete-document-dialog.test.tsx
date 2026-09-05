/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CanvasDeleteDocumentDialog } from "./canvas-delete-document-dialog"

function renderDialog(
  props: Partial<React.ComponentProps<typeof CanvasDeleteDocumentDialog>> = {}
) {
  const onConfirm = jest.fn()
  const onOpenChange = jest.fn()
  render(
    <CanvasDeleteDocumentDialog
      open
      onOpenChange={onOpenChange}
      documentTitle="Quarterly notes"
      onConfirm={onConfirm}
      {...props}
    />
  )
  return { onConfirm, onOpenChange }
}

describe("CanvasDeleteDocumentDialog", () => {
  it("names the document and points at close as the non-destructive verb", () => {
    renderDialog()
    const dialog = screen.getByTestId("canvas-delete-document-dialog")
    expect(dialog).toHaveTextContent("Quarterly notes")
    expect(dialog).toHaveTextContent(/close it instead/i)
  })

  it("counts the versions that go with the document", () => {
    renderDialog({ versionCount: 3 })
    expect(screen.getByTestId("canvas-delete-document-dialog")).toHaveTextContent(
      /3 saved versions/i
    )
  })

  it("uses the singular wording for exactly one version", () => {
    renderDialog({ versionCount: 1 })
    expect(screen.getByTestId("canvas-delete-document-dialog")).toHaveTextContent(
      /1 saved version/i
    )
  })

  it("omits the version clause when there is no history to lose", () => {
    renderDialog({ versionCount: 0 })
    expect(screen.getByTestId("canvas-delete-document-dialog")).not.toHaveTextContent(
      /saved version/i
    )
  })

  it("confirms and closes on the destructive action", async () => {
    const user = userEvent.setup()
    const { onConfirm, onOpenChange } = renderDialog()

    await user.click(screen.getByTestId("canvas-delete-document-confirm"))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("does not confirm when the prompt is dismissed", async () => {
    const user = userEvent.setup()
    const { onConfirm, onOpenChange } = renderDialog()

    await user.click(screen.getByRole("button", { name: /cancel/i }))

    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("renders nothing while closed", () => {
    render(
      <CanvasDeleteDocumentDialog
        open={false}
        onOpenChange={jest.fn()}
        documentTitle="Hidden"
        onConfirm={jest.fn()}
      />
    )
    expect(screen.queryByTestId("canvas-delete-document-dialog")).not.toBeInTheDocument()
  })
})
