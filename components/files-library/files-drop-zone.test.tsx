/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("@/lib/chat/drop-entries", () => ({
  MAX_DROPPED_DIR_FILES: 200,
  collectDroppedFiles: jest.fn(),
}))
jest.mock("sonner", () => ({ toast: { warning: jest.fn() } }))

import { toast } from "sonner"
import { collectDroppedFiles } from "@/lib/chat/drop-entries"
import { useFilesLibraryStore } from "@/stores/files-library"
import { carriesFiles, FilesDropZone } from "./files-drop-zone"

const collect = collectDroppedFiles as jest.Mock
const file = new File(["x"], "a.md")
const transfer = { types: ["Files"], files: [file], items: [], dropEffect: "none" }

beforeEach(() => {
  collect.mockReset()
  collect.mockResolvedValue({ files: [file], directories: 0, truncated: false })
  useFilesLibraryStore.setState({ section: { kind: "all" } })
})

it("recognises a drag that carries files", () => {
  expect(carriesFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true)
  expect(carriesFiles({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false)
  expect(carriesFiles(null)).toBe(false)
})

it("shows a hint while files hover and uploads what is dropped", async () => {
  const upload = jest.fn(async () => {})
  render(
    <FilesDropZone actions={{ upload }}>
      <p>body</p>
    </FilesDropZone>
  )
  const zone = screen.getByTestId("files-drop-zone")
  fireEvent.dragEnter(zone, { dataTransfer: transfer })
  expect(screen.getByTestId("files-drop-overlay")).toHaveTextContent("Drop files to upload them")
  fireEvent.drop(zone, { dataTransfer: transfer })
  expect(screen.queryByTestId("files-drop-overlay")).toBeNull()
  await waitFor(() => expect(upload).toHaveBeenCalledWith([file], undefined))
})

it("files drops in the folder in view and warns when a directory was cut short", async () => {
  useFilesLibraryStore.setState({ section: { kind: "folder", folderId: "lbf_1" } })
  collect.mockResolvedValue({ files: [file], directories: 1, truncated: true })
  const upload = jest.fn(async () => {})
  render(
    <FilesDropZone actions={{ upload }}>
      <p>body</p>
    </FilesDropZone>
  )
  await act(async () => {
    fireEvent.drop(screen.getByTestId("files-drop-zone"), { dataTransfer: transfer })
  })
  await waitFor(() => expect(upload).toHaveBeenCalledWith([file], "lbf_1"))
  expect(toast.warning).toHaveBeenCalled()
})

it("ignores drops while disabled and drags without files", () => {
  const upload = jest.fn(async () => {})
  const { rerender } = render(
    <FilesDropZone actions={{ upload }} disabled>
      <p>body</p>
    </FilesDropZone>
  )
  const zone = screen.getByTestId("files-drop-zone")
  fireEvent.dragEnter(zone, { dataTransfer: transfer })
  fireEvent.drop(zone, { dataTransfer: transfer })
  rerender(
    <FilesDropZone actions={{ upload }}>
      <p>body</p>
    </FilesDropZone>
  )
  fireEvent.dragEnter(zone, { dataTransfer: { types: ["text/plain"] } })
  expect(screen.queryByTestId("files-drop-overlay")).toBeNull()
  expect(collect).not.toHaveBeenCalled()
})
