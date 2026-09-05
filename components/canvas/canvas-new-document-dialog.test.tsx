/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const importMock = jest.fn()
jest.mock("@/lib/canvas/document-import", () => ({
  ...jest.requireActual("@/lib/canvas/document-import"),
  importCanvasDocument: (...args: unknown[]) => importMock(...args),
}))

import { CanvasNewDocumentDialog } from "./canvas-new-document-dialog"

function renderDialog() {
  const onCreate = jest.fn()
  const onOpenChange = jest.fn()
  render(<CanvasNewDocumentDialog open onOpenChange={onOpenChange} onCreate={onCreate} />)
  return { onCreate, onOpenChange }
}

beforeEach(() => {
  importMock.mockReset()
})

describe("CanvasNewDocumentDialog", () => {
  it("creates an empty markdown document by default", async () => {
    const user = userEvent.setup()
    const { onCreate } = renderDialog()

    await user.click(screen.getByTestId("canvas-new-create"))

    expect(onCreate).toHaveBeenCalledWith({
      title: "Untitled",
      content: "",
      language: "markdown",
      type: "text",
    })
  })

  it("uses the name the user typed", async () => {
    const user = userEvent.setup()
    const { onCreate } = renderDialog()

    await user.type(screen.getByTestId("canvas-new-title"), "Design notes")
    await user.click(screen.getByTestId("canvas-new-create"))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: "Design notes" }))
  })

  it("creates the chosen starter's body, typed by the starter", async () => {
    const user = userEvent.setup()
    const { onCreate } = renderDialog()

    await user.click(screen.getByTestId("canvas-new-starter"))
    await user.click(await screen.findByRole("option", { name: "Decision record" }))
    await user.click(screen.getByTestId("canvas-new-create"))

    const request = onCreate.mock.calls[0][0]
    expect(request.content).toContain("## Decision")
    expect(request.language).toBe("markdown")
    expect(request.type).toBe("text")
  })

  it("clears the starter when the language changes", async () => {
    // A starter belongs to one language, so keeping it would create a document
    // whose body does not match its grammar.
    const user = userEvent.setup()
    const { onCreate } = renderDialog()

    await user.click(screen.getByTestId("canvas-new-starter"))
    await user.click(await screen.findByRole("option", { name: "Notes" }))

    await user.click(screen.getByTestId("canvas-new-language"))
    await user.click(await screen.findByRole("option", { name: "Python" }))

    await user.click(screen.getByTestId("canvas-new-create"))
    expect(onCreate).toHaveBeenCalledWith({
      title: "Untitled",
      content: "",
      language: "python",
      type: "code",
    })
  })

  it("imports a file and reports the conversion before creating anything", async () => {
    const user = userEvent.setup()
    importMock.mockResolvedValue({
      title: "Memo",
      content: "# Heading",
      language: "markdown",
      type: "text",
      sourceFormat: "word",
      sourceFilename: "memo.docx",
      warnings: [{ code: "converted-to-markdown", message: "word" }],
    })
    const { onCreate } = renderDialog()

    await user.click(screen.getByTestId("canvas-new-tab-import"))
    await user.upload(
      screen.getByTestId("canvas-new-file-input"),
      new File(["x"], "memo.docx", { type: "application/vnd.openxmlformats" })
    )

    const warnings = await screen.findByTestId("canvas-new-import-warnings")
    expect(warnings).toHaveTextContent(/converted to editable Markdown/i)
    // Nothing is created until the user acts on what they were told.
    expect(onCreate).not.toHaveBeenCalled()

    await user.click(screen.getByTestId("canvas-new-import-create"))
    expect(onCreate).toHaveBeenCalledWith({
      title: "Memo",
      content: "# Heading",
      language: "markdown",
      type: "text",
    })
  })

  it("keeps a text import verbatim and shows no conversion warning", async () => {
    const user = userEvent.setup()
    importMock.mockResolvedValue({
      title: "script",
      content: "print('hi')\n",
      language: "python",
      type: "code",
      sourceFormat: "code",
      sourceFilename: "script.py",
      warnings: [],
    })
    const { onCreate } = renderDialog()

    await user.click(screen.getByTestId("canvas-new-tab-import"))
    await user.upload(
      screen.getByTestId("canvas-new-file-input"),
      new File(["print('hi')\n"], "script.py", { type: "text/x-python" })
    )

    await screen.findByTestId("canvas-new-import-summary")
    expect(screen.queryByTestId("canvas-new-import-warnings")).not.toBeInTheDocument()

    await user.click(screen.getByTestId("canvas-new-import-create"))
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ content: "print('hi')\n", language: "python", type: "code" })
    )
  })

  it("reports a failed read instead of creating an empty document", async () => {
    const user = userEvent.setup()
    importMock.mockRejectedValue(new Error("encrypted pdf"))
    const { onCreate } = renderDialog()

    await user.click(screen.getByTestId("canvas-new-tab-import"))
    await user.upload(
      screen.getByTestId("canvas-new-file-input"),
      new File(["x"], "locked.pdf", { type: "application/pdf" })
    )

    expect(await screen.findByTestId("canvas-new-import-error")).toHaveTextContent("encrypted pdf")
    expect(screen.getByTestId("canvas-new-import-create")).toBeDisabled()
    expect(onCreate).not.toHaveBeenCalled()
  })

  it("cannot create from an import before a file has been read", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByTestId("canvas-new-tab-import"))
    expect(screen.getByTestId("canvas-new-import-create")).toBeDisabled()
  })

  it("forgets the draft when it is dismissed", async () => {
    const user = userEvent.setup()
    const { onOpenChange } = renderDialog()

    await user.type(screen.getByTestId("canvas-new-title"), "Scratch")
    await user.keyboard("{Escape}")

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })
})
