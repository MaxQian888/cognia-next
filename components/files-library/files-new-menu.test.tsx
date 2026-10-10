/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const templatesState: { enabled: boolean; options: unknown[] | undefined } = {
  enabled: true,
  options: [],
}
jest.mock("@/hooks/document-templates/use-document-templates", () => ({
  useDocumentTemplates: () => templatesState,
}))

import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesNewMenu } from "./files-new-menu"

function actions() {
  return {
    upload: jest.fn(async () => {}),
    newCanvasDocument: jest.fn(),
    newFromTemplate: jest.fn(),
  }
}

beforeEach(() => {
  templatesState.enabled = true
  templatesState.options = []
  useFilesLibraryStore.setState({ section: { kind: "all" }, folderDialog: null })
})

it("uploads the chosen files at the top level", () => {
  const a = actions()
  render(<FilesNewMenu actions={a} />)
  const file = new File(["x"], "a.md")
  fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [file] } })
  expect(a.upload).toHaveBeenCalledWith([file], undefined)
})

it("files uploads in the folder in view", () => {
  useFilesLibraryStore.setState({ section: { kind: "folder", folderId: "lbf_1" } })
  const a = actions()
  render(<FilesNewMenu actions={a} />)
  const file = new File(["x"], "a.md")
  fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [file] } })
  expect(a.upload).toHaveBeenCalledWith([file], "lbf_1")
})

it("starts a canvas document and opens a top-level new-folder dialog", async () => {
  const a = actions()
  const user = userEvent.setup()
  render(<FilesNewMenu actions={a} />)
  await user.click(screen.getByRole("button", { name: "New" }))
  await user.click(screen.getByRole("menuitem", { name: "Canvas document" }))
  expect(a.newCanvasDocument).toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "New" }))
  await user.click(screen.getByRole("menuitem", { name: "Folder" }))
  expect(useFilesLibraryStore.getState().folderDialog).toEqual({
    mode: "create",
    parentId: "root",
  })
})

it("creates the folder inside the folder being browsed", async () => {
  useFilesLibraryStore.setState({ section: { kind: "folder", folderId: "lbf_1" } })
  const user = userEvent.setup()
  render(<FilesNewMenu actions={actions()} />)
  await user.click(screen.getByRole("button", { name: "New" }))
  await user.click(screen.getByRole("menuitem", { name: "Folder" }))
  expect(useFilesLibraryStore.getState().folderDialog).toEqual({
    mode: "create",
    parentId: "lbf_1",
  })
})

it("starts a document from a template in its submenu", async () => {
  const meeting = { id: "meeting-notes", source: "builtin", name: "Meeting notes", icon: "meeting" }
  templatesState.options = [meeting]
  const a = actions()
  const user = userEvent.setup()
  render(<FilesNewMenu actions={a} />)
  await user.click(screen.getByRole("button", { name: "New" }))
  await user.click(screen.getByRole("menuitem", { name: "From template" }))
  fireEvent.click(await screen.findByTestId("files-new-template-meeting-notes"))
  expect(a.newFromTemplate).toHaveBeenCalledWith(meeting)
})

it("offers no template submenu while the platform is off", async () => {
  templatesState.enabled = false
  templatesState.options = [{ id: "guide", source: "builtin", name: "Guide", icon: "guide" }]
  const user = userEvent.setup()
  render(<FilesNewMenu actions={actions()} />)
  await user.click(screen.getByRole("button", { name: "New" }))
  expect(screen.queryByRole("menuitem", { name: "From template" })).toBeNull()
})

it("draws a 40px plus on the phone, with the same menu", async () => {
  const user = userEvent.setup()
  render(<FilesNewMenu actions={actions()} compact />)
  const trigger = screen.getByRole("button", { name: "New" })
  expect(trigger).toHaveClass("size-10")
  expect(trigger).not.toHaveTextContent("New")
  await user.click(trigger)
  expect(screen.getByRole("menuitem", { name: "Upload files" })).toBeInTheDocument()
})
