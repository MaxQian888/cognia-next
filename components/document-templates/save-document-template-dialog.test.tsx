/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/lib/document-templates/service", () => ({
  saveDocumentAsTemplate: jest.fn(async (input: { name: string }) => ({
    id: "dtpl_new",
    name: input.name.trim(),
  })),
  editDocumentTemplateDetails: jest.fn(async (_id: string, input: { name: string }) => ({
    id: "dtpl_old",
    name: input.name.trim(),
  })),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import { DocumentTemplateError } from "@/lib/db/document-templates"
import {
  editDocumentTemplateDetails,
  saveDocumentAsTemplate,
} from "@/lib/document-templates/service"
import { SaveDocumentTemplateDialog } from "./save-document-template-dialog"

const save = saveDocumentAsTemplate as jest.Mock
const edit = editDocumentTemplateDetails as jest.Mock
const draft = { content: "# Q4", language: "markdown" as const, type: "text" as const }

beforeEach(() => jest.clearAllMocks())

it("stays closed without a request", () => {
  render(<SaveDocumentTemplateDialog request={null} onClose={jest.fn()} />)
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("saves the draft under the chosen name and description", async () => {
  const onClose = jest.fn()
  const onSaved = jest.fn()
  render(
    <SaveDocumentTemplateDialog
      request={{ mode: "create", draft, name: "Q4 planning" }}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
  expect(screen.getByLabelText("Name")).toHaveValue("Q4 planning")
  const user = userEvent.setup()
  await user.type(screen.getByLabelText("Description"), "Quarter kickoff")
  await user.click(screen.getByRole("button", { name: "Save template" }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      ...draft,
      name: "Q4 planning",
      description: "Quarter kickoff",
    })
  )
  expect(toast.success).toHaveBeenCalledWith("Saved “Q4 planning” as a template.")
  expect(onSaved).toHaveBeenCalledWith("dtpl_new")
  expect(onClose).toHaveBeenCalled()
})

it("edits a saved template's details", async () => {
  const onClose = jest.fn()
  render(
    <SaveDocumentTemplateDialog
      request={{ mode: "edit", templateId: "dtpl_old", name: "Old", description: "d" }}
      onClose={onClose}
    />
  )
  expect(screen.getByLabelText("Description")).toHaveValue("d")
  const user = userEvent.setup()
  await user.clear(screen.getByLabelText("Name"))
  await user.type(screen.getByLabelText("Name"), "New{Enter}")
  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith("dtpl_old", { name: "New", description: "d" })
  )
  expect(toast.success).toHaveBeenCalledWith("Updated the template “New”.")
})

it("reports a refused save and stays open; an empty name cannot be saved", async () => {
  save.mockRejectedValueOnce(new DocumentTemplateError("document_template_name_required"))
  const onClose = jest.fn()
  render(
    <SaveDocumentTemplateDialog request={{ mode: "create", draft, name: "X" }} onClose={onClose} />
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Save template" }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Enter a template name."))
  expect(onClose).not.toHaveBeenCalled()
  await user.clear(screen.getByLabelText("Name"))
  expect(screen.getByRole("button", { name: "Save template" })).toBeDisabled()
})
