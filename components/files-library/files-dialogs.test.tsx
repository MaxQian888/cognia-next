/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

const mockReceived: Record<string, Record<string, unknown>> = {}
function mockStub(name: string) {
  function Stub(props: Record<string, unknown>) {
    mockReceived[name] = props
    return <div data-testid={`dialog-${name}`} />
  }
  return Stub
}
jest.mock("./files-move-dialog", () => ({ FilesMoveDialog: mockStub("move") }))
jest.mock("./files-rename-dialog", () => ({ FilesRenameDialog: mockStub("rename") }))
jest.mock("./files-save-template-dialog", () => ({ FilesSaveTemplateDialog: mockStub("template") }))
jest.mock("./files-share-dialog", () => ({ FilesShareDialog: mockStub("share") }))
jest.mock("./files-trash-dialogs", () => ({ FilesTrashDialogs: mockStub("trash") }))
jest.mock("./files-folder-dialog", () => ({ FilesFolderDialog: mockStub("folder") }))
jest.mock("./files-delete-folder-dialog", () => ({
  FilesDeleteFolderDialog: mockStub("deleteFolder"),
}))

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import type { FilesEntry } from "@/lib/files-library/types"
import { FilesDialogs } from "./files-dialogs"

it("mounts every Files dialog once, each with what it reads", () => {
  const entries = [{ key: "artifact:a" }] as unknown as FilesEntry[]
  const folders = [{ id: "f1" }] as unknown as LibraryFolder[]
  const actions = {} as FilesActions
  const onDeleted = jest.fn()
  render(
    <FilesDialogs entries={entries} folders={folders} actions={actions} onDeleted={onDeleted} />
  )

  for (const name of ["move", "rename", "template", "share", "trash", "folder", "deleteFolder"]) {
    expect(screen.getAllByTestId(`dialog-${name}`)).toHaveLength(1)
  }
  expect(mockReceived.move).toMatchObject({ entries, folders, actions })
  expect(mockReceived.rename).toMatchObject({ entries, actions })
  expect(mockReceived.template).toMatchObject({ entries })
  expect(mockReceived.share).toMatchObject({ entries, folders })
  expect(mockReceived.trash).toMatchObject({ entries, actions, onDeleted })
  expect(mockReceived.deleteFolder).toMatchObject({ folders })
})
