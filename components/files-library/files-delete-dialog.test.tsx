/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesDeleteDialog } from "./files-delete-dialog"

const entry: FilesEntry = {
  key: "upload:u1",
  kind: "upload",
  sourceId: "u1",
  title: "notes.md",
  projectIds: [],
  sessionIds: [],
  originAlive: true,
  createdAt: 1,
  updatedAt: 1,
  ownedByFiles: true,
  hidden: false,
  searchText: "",
}

it("confirms and deletes a Files upload", async () => {
  const deleteOwned = jest.fn(async () => {})
  useFilesLibraryStore.setState({ deleteTarget: "upload:u1" })
  render(<FilesDeleteDialog entries={[entry]} actions={{ deleteOwned }} />)
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete “notes.md”?")
  await userEvent.setup().click(screen.getByRole("button", { name: "Delete" }))
  expect(deleteOwned).toHaveBeenCalledWith(entry)
  expect(useFilesLibraryStore.getState().deleteTarget).toBeNull()
})

it("does nothing for a target that vanished", async () => {
  const deleteOwned = jest.fn(async () => {})
  useFilesLibraryStore.setState({ deleteTarget: "upload:gone" })
  render(<FilesDeleteDialog entries={[entry]} actions={{ deleteOwned }} />)
  expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled()
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }))
  expect(deleteOwned).not.toHaveBeenCalled()
})
