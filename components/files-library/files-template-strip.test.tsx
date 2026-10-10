/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const templatesState: { enabled: boolean; options: unknown[] | undefined } = {
  enabled: true,
  options: [],
}
jest.mock("@/hooks/document-templates/use-document-templates", () => ({
  useDocumentTemplates: () => templatesState,
}))
jest.mock("@/components/document-templates/save-document-template-dialog", () => ({
  SaveDocumentTemplateDialog: ({ request }: { request: unknown }) =>
    request ? <div data-testid="edit-request">{JSON.stringify(request)}</div> : null,
}))

import type { DocumentTemplateOption } from "@/lib/document-templates/service"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesTemplateStrip } from "./files-template-strip"

const guide: DocumentTemplateOption = {
  id: "guide",
  source: "builtin",
  name: "Guide",
  description: "Explain how",
  content: "# Guide",
  language: "markdown",
  type: "text",
  icon: "guide",
}
const saved: DocumentTemplateOption = {
  id: "dtpl_p",
  source: "user",
  name: "Postmortem",
  description: "After an incident",
  content: "# P",
  language: "markdown",
  type: "text",
  icon: "saved",
  updatedAt: 1,
}

function actions() {
  return {
    newCanvasDocument: jest.fn(),
    newFromTemplate: jest.fn(),
    deleteTemplate: jest.fn(async () => {}),
  }
}

beforeEach(() => {
  templatesState.enabled = true
  templatesState.options = [guide, saved]
  useFilesLibraryStore.setState({ templatesCollapsed: false })
})

it("offers a blank page, the built-ins and saved templates", async () => {
  const a = actions()
  render(<FilesTemplateStrip actions={a} />)
  expect(screen.getByRole("heading", { name: "Start from a template" })).toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "New document from Blank document" }))
  expect(a.newCanvasDocument).toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "New document from Guide" }))
  expect(a.newFromTemplate).toHaveBeenCalledWith(guide)
  expect(screen.queryByRole("button", { name: "Template actions for Guide" })).toBeNull()
})

it("edits and deletes a saved template from its menu", async () => {
  const a = actions()
  render(<FilesTemplateStrip actions={a} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Template actions for Postmortem" }))
  await user.click(screen.getByRole("menuitem", { name: "Edit details…" }))
  expect(JSON.parse(screen.getByTestId("edit-request").textContent!)).toEqual({
    mode: "edit",
    templateId: "dtpl_p",
    name: "Postmortem",
    description: "After an incident",
  })
  await user.click(screen.getByRole("button", { name: "Template actions for Postmortem" }))
  await user.click(screen.getByRole("menuitem", { name: "Delete template" }))
  expect(a.deleteTemplate).toHaveBeenCalledWith(saved)
})

it("folds away and remembers it", async () => {
  render(<FilesTemplateStrip actions={actions()} />)
  const user = userEvent.setup()
  const toggle = screen.getByRole("button", { name: "Hide templates" })
  expect(toggle).toHaveAttribute("aria-expanded", "true")
  await user.click(toggle)
  expect(useFilesLibraryStore.getState().templatesCollapsed).toBe(true)
  expect(screen.queryByRole("list")).toBeNull()
  expect(screen.getByRole("button", { name: "Show templates" })).toHaveAttribute(
    "aria-expanded",
    "false"
  )
})

it("renders nothing while the template platform is off", () => {
  templatesState.enabled = false
  const { container } = render(<FilesTemplateStrip actions={actions()} />)
  expect(container).toBeEmptyDOMElement()
})
