import { act, render, screen, waitFor } from "@testing-library/react"

import type { FilesShareSelection } from "@/lib/files-library/share"
import type { FilesEntry } from "@/lib/files-library/types"
import type { ShareFileCandidate } from "@/lib/share/file-selection"
import type { FileSpacePath } from "@/types/filespace"
import { useFilesLibraryStore } from "@/stores/files-library"

const mockDialog = jest.fn()
jest.mock("@/components/share/share-link-dialog", () => ({
  ShareLinkDialog: (props: Record<string, unknown>) => {
    mockDialog(props)
    return <div data-testid="share-link-dialog" />
  },
}))
const mockAuthorize = jest.fn()
const mockRecord = jest.fn()
jest.mock("@/lib/files-library/share", () => ({
  ...jest.requireActual("@/lib/files-library/share"),
  authorizeFilesShare: (...a: unknown[]) => mockAuthorize(...a),
  recordFilesShare: (...a: unknown[]) => mockRecord(...a),
}))

import { FilesShareDialog } from "./files-share-dialog"

function entry(key: string, overrides: Partial<FilesEntry> = {}): FilesEntry {
  const [kind, sourceId] = key.split(":") as [FilesEntry["kind"], string]
  return {
    key,
    kind,
    sourceId,
    title: `Title ${sourceId}`,
    sourceTitle: sourceId,
    projectIds: [],
    sessionIds: [],
    sharedWithMe: false,
    creator: "user",
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    searchText: sourceId,
    ...overrides,
  }
}

function file(path: string): ShareFileCandidate {
  return {
    path: path as FileSpacePath,
    name: path.slice(path.lastIndexOf("/") + 1),
    mime: "text/plain",
    size: 1,
    sensitive: false,
    open: jest.fn(),
  }
}

const ENTRIES = [entry("canvas:a"), entry("canvas:b"), entry("image:t", { trashedAt: 3 })]

type DialogProps = {
  picked: { files?: ShareFileCandidate[]; unavailable?: string[]; failed?: boolean }
  buildPayload: () => Promise<{ payload: { kind: string; title?: string }; attachments: [] }>
  onCreated: (share: { code: string; url: string }, carried: ShareFileCandidate[]) => void
  onOpenChange: (open: boolean) => void
}

function lastProps(): DialogProps {
  return mockDialog.mock.calls.at(-1)![0] as DialogProps
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAuthorize.mockResolvedValue(undefined)
  mockRecord.mockResolvedValue(undefined)
  useFilesLibraryStore.setState({ shareTarget: null })
})

it("renders nothing until something is picked", () => {
  render(<FilesShareDialog entries={ENTRIES} folders={[]} resolveSelection={jest.fn()} />)
  expect(screen.queryByTestId("share-link-dialog")).toBeNull()
})

it("reads the picked items, then shares them as one bundle and remembers what it carried", async () => {
  const sessions = [{ id: "shared:x", collaboration: { orgId: "o", sessionId: "x" } }]
  const selection: FilesShareSelection = {
    files: [file("/files/a.md"), file("/files/b.md")],
    keyByPath: new Map([
      ["/files/a.md", "canvas:a"],
      ["/files/b.md", "canvas:b"],
    ]),
    missing: [],
    sessions: sessions as FilesShareSelection["sessions"],
  }
  const resolveSelection = jest.fn().mockResolvedValue(selection)
  act(() =>
    useFilesLibraryStore.getState().openShare(["canvas:a", "canvas:b", "image:t", "gone:z"])
  )
  render(<FilesShareDialog entries={ENTRIES} folders={[]} resolveSelection={resolveSelection} />)

  expect(lastProps().picked).toEqual({ files: undefined })
  await waitFor(() => expect(lastProps().picked.files).toHaveLength(2))
  // Trashed and vanished keys are not shared.
  expect(resolveSelection).toHaveBeenCalledWith([ENTRIES[0], ENTRIES[1]], [])

  const built = await lastProps().buildPayload()
  expect(mockAuthorize).toHaveBeenCalledWith(sessions)
  expect(built).toEqual({
    payload: expect.objectContaining({ kind: "file-bundle", title: "2 files from Files" }),
    attachments: [],
  })

  lastProps().onCreated({ code: "C", url: "u" }, [selection.files[1]!])
  expect(mockRecord).toHaveBeenCalledWith([ENTRIES[1]], "C")
})

it("titles a single item by its name and names items with nothing stored", async () => {
  const resolveSelection = jest.fn().mockResolvedValue({
    files: [],
    keyByPath: new Map(),
    missing: [ENTRIES[0]],
    sessions: [],
  })
  act(() => useFilesLibraryStore.getState().openShare(["canvas:a"]))
  render(<FilesShareDialog entries={ENTRIES} folders={[]} resolveSelection={resolveSelection} />)
  await waitFor(() => expect(lastProps().picked).toEqual({ files: [], unavailable: ["Title a"] }))
  const built = await lastProps().buildPayload()
  expect(built.payload.title).toBe("Title a")
})

it("says when the items could not be read, and closes through the store", async () => {
  const resolveSelection = jest.fn().mockRejectedValue(new Error("boom"))
  act(() => useFilesLibraryStore.getState().openShare(["canvas:a"]))
  render(<FilesShareDialog entries={ENTRIES} folders={[]} resolveSelection={resolveSelection} />)
  await waitFor(() => expect(lastProps().picked).toEqual({ files: undefined, failed: true }))
  act(() => lastProps().onOpenChange(false))
  expect(useFilesLibraryStore.getState().shareTarget).toBeNull()
  expect(screen.queryByTestId("share-link-dialog")).toBeNull()
})

it("keeps the files it showed when the list refreshes underneath", async () => {
  const FOLDERS: never[] = []
  const resolveSelection = jest.fn().mockResolvedValue({
    files: [file("/files/a.md")],
    keyByPath: new Map([["/files/a.md", "canvas:a"]]),
    missing: [],
    sessions: [],
  })
  act(() => useFilesLibraryStore.getState().openShare(["canvas:a"]))
  const { rerender } = render(
    <FilesShareDialog entries={ENTRIES} folders={FOLDERS} resolveSelection={resolveSelection} />
  )
  await waitFor(() => expect(lastProps().picked.files).toHaveLength(1))
  rerender(
    <FilesShareDialog
      entries={[entry("canvas:a", { title: "Renamed" })]}
      folders={FOLDERS}
      resolveSelection={resolveSelection}
    />
  )
  expect(resolveSelection).toHaveBeenCalledTimes(1)
})
