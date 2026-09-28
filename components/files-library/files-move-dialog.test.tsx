/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { LibraryFolder } from "@/lib/db/files-library-types"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesMoveDialog } from "./files-move-dialog"

function entry(key: string, folderId?: string): FilesEntry {
  return {
    key,
    kind: "artifact",
    sourceId: key,
    title: key,
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    searchText: "",
    ...(folderId ? { folderId } : {}),
  }
}
const folders: LibraryFolder[] = [
  { id: "lbf_a", name: "Specs", parentFolderId: "root", createdAt: 1, updatedAt: 1 },
  { id: "lbf_b", name: "Drafts", parentFolderId: "lbf_a", createdAt: 1, updatedAt: 1 },
]

it("moves the targeted entries into the chosen folder", async () => {
  const moveToFolder = jest.fn(async () => {})
  const entries = [entry("a"), entry("b", "lbf_a")]
  useFilesLibraryStore.setState({ moveTarget: ["a", "b"] })
  const user = userEvent.setup()
  render(<FilesMoveDialog entries={entries} folders={folders} actions={{ moveToFolder }} />)
  expect(screen.getByText(/^2 items\./)).toBeInTheDocument()
  await user.click(screen.getByLabelText("Drafts"))
  await user.click(screen.getByRole("button", { name: "Move" }))
  expect(moveToFolder).toHaveBeenCalledWith(entries, "lbf_b")
  expect(useFilesLibraryStore.getState().moveTarget).toBeNull()
})

it("starts on a single entry's own folder and can take it out of Folders", async () => {
  const moveToFolder = jest.fn(async () => {})
  const entries = [entry("b", "lbf_a")]
  useFilesLibraryStore.setState({ moveTarget: ["b"] })
  const user = userEvent.setup()
  render(<FilesMoveDialog entries={entries} folders={[]} actions={{ moveToFolder }} />)
  expect(screen.getByText("No folders yet. Create one from the Folders tab.")).toBeInTheDocument()
  await user.click(screen.getByLabelText("Take out of Folders"))
  await user.click(screen.getByRole("button", { name: "Move" }))
  expect(moveToFolder).toHaveBeenCalledWith(entries, null)
})

it("is closed without a target and cancels cleanly", async () => {
  useFilesLibraryStore.setState({ moveTarget: null })
  const { rerender } = render(
    <FilesMoveDialog entries={[]} folders={folders} actions={{ moveToFolder: jest.fn() }} />
  )
  expect(screen.queryByRole("dialog")).toBeNull()
  useFilesLibraryStore.setState({ moveTarget: ["x"] })
  rerender(<FilesMoveDialog entries={[]} folders={folders} actions={{ moveToFolder: jest.fn() }} />)
  expect(screen.getByRole("button", { name: "Move" })).toBeDisabled()
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }))
  expect(useFilesLibraryStore.getState().moveTarget).toBeNull()
})
