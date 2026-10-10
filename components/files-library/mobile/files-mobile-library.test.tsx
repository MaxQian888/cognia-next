/**
 * @jest-environment jsdom
 */
import "@/components/interactions/test-pointer-polyfill"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const entriesState: { entries: unknown; imagesTruncated: boolean; loadMoreImages: jest.Mock } = {
  entries: undefined,
  imagesTruncated: false,
  loadMoreImages: jest.fn(),
}
jest.mock("@/hooks/files-library/use-files-entries", () => ({
  useFilesEntries: () => entriesState,
}))
const folderState: { folders: unknown[] } = { folders: [] }
jest.mock("@/hooks/files-library/use-files-folders", () => ({
  useFilesFolders: () => folderState.folders,
}))
const mockActions = {
  open: jest.fn(async () => {}),
  preview: jest.fn((entry: { key: string }) => {
    // The real action selects the item, which is what the drawer follows.
    const { useFilesLibraryStore } = jest.requireActual("@/stores/files-library")
    useFilesLibraryStore.getState().select(entry.key)
  }),
  toggleFavorite: jest.fn(async () => {}),
  setFavorite: jest.fn(async () => {}),
  moveToFolder: jest.fn(async () => {}),
  trash: jest.fn(async () => {}),
  restore: jest.fn(async () => {}),
  deleteForever: jest.fn(async () => {}),
  rename: jest.fn(async () => true),
  duplicate: jest.fn(async () => {}),
  download: jest.fn(async () => {}),
  exportZip: jest.fn(async () => {}),
  useInChat: jest.fn(async () => {}),
  goToConversation: jest.fn(async () => {}),
  upload: jest.fn(async () => {}),
  newCanvasDocument: jest.fn(),
  newFromTemplate: jest.fn(),
  deleteTemplate: jest.fn(),
  moveFolder: jest.fn(async () => {}),
  setFolderStyle: jest.fn(async () => {}),
}
jest.mock("@/hooks/files-library/use-files-actions", () => ({
  ...jest.requireActual("@/hooks/files-library/use-files-actions"),
  useFilesActions: () => mockActions,
}))
jest.mock("../files-image-thumb", () => ({ FilesImageThumb: () => <div data-testid="thumb" /> }))
jest.mock("@/hooks/document-templates/use-document-templates", () => ({
  useDocumentTemplates: () => ({ enabled: true, options: [] }),
}))
jest.mock("../files-preview-pane", () => ({
  FilesPreviewPane: ({ entry, touch }: { entry: { key: string }; touch?: boolean }) => (
    <div data-testid={`preview-${entry.key}`} data-touch={touch ? "true" : undefined} />
  ),
}))
// The drawer itself is vaul's; what matters here is when it opens.
jest.mock("@/components/shared/responsive-detail-sheet", () => ({
  ResponsiveDetailSheet: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: React.ReactNode
  }) =>
    open ? (
      <div data-testid="preview-drawer">
        <button type="button" onClick={() => onOpenChange(false)}>
          dismiss
        </button>
        {children}
      </div>
    ) : null,
}))
jest.mock("@/lib/capacitor/haptics", () => ({ impact: jest.fn(async () => undefined) }))
let mockParams = new URLSearchParams()
const mockRouter = { push: jest.fn(), replace: jest.fn() }
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockParams,
  useRouter: () => mockRouter,
  usePathname: () => "/files",
}))

import type { LibraryFolder } from "@/lib/db/files-library-types"
import type { FilesEntry } from "@/lib/files-library/types"
import { DEFAULT_FILES_VIEW_FILTERS, useFilesLibraryStore } from "@/stores/files-library"
import { useProjectStore } from "@/stores/project/project-store"
import { FilesMobileLibrary } from "./files-mobile-library"

function entry(key: string, overrides: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key,
    kind: "artifact",
    sourceId: key,
    title: key,
    sourceTitle: key,
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: key.toLowerCase(),
    ...overrides,
  }
}

const folder = (id: string, name: string): LibraryFolder => ({
  id,
  name,
  parentFolderId: "root",
  createdAt: 1,
  updatedAt: 1,
})

beforeEach(() => {
  mockParams = new URLSearchParams()
  mockRouter.replace.mockClear()
  for (const fn of Object.values(mockActions)) fn.mockClear()
  folderState.folders = []
  entriesState.entries = undefined
  entriesState.imagesTruncated = false
  useProjectStore.setState({ activeProjectId: "p1" } as never)
  useFilesLibraryStore.setState({
    section: { kind: "all" },
    lens: "suggested",
    search: "",
    filters: DEFAULT_FILES_VIEW_FILTERS,
    sort: null,
    projectScope: "current",
    viewMode: "grid",
    selectedKey: null,
    moveTarget: null,
    emptyTrashOpen: false,
    deleteForeverTarget: null,
    templatesCollapsed: false,
  })
})

const list = () => within(screen.getByTestId("files-mobile-list"))

function longPress(element: HTMLElement) {
  jest.useFakeTimers()
  try {
    fireEvent.pointerDown(element, { pointerType: "touch", button: 0, clientX: 5, clientY: 5 })
    act(() => {
      jest.advanceTimersByTime(600)
    })
    fireEvent.pointerUp(element)
    fireEvent.click(element)
  } finally {
    jest.useRealTimers()
  }
}

it("shows list skeletons until the first load", () => {
  render(<FilesMobileLibrary />)
  expect(screen.getByLabelText("Loading files")).toHaveAttribute("aria-busy", "true")
})

it("lists every item as a row, whatever the desktop layout preference is", () => {
  entriesState.entries = [entry("artifact:a"), entry("artifact:b")]
  render(<FilesMobileLibrary />)
  expect(list().getByTestId("files-mobile-row-artifact:a")).toBeInTheDocument()
  expect(list().getByTestId("files-mobile-row-artifact:b")).toBeInTheDocument()
  expect(screen.queryByTestId("files-grid")).toBeNull()
  expect(screen.getByTestId("files-mobile-places")).toHaveAccessibleName("Places — All")
  expect(screen.getByText("2 items")).toBeInTheDocument()
  // The templates strip opens Suggested in All.
  expect(screen.getByTestId("files-body").textContent).toContain("Start from a template")
})

it("previews a tapped row in the drawer, and closes it again", async () => {
  const user = userEvent.setup()
  entriesState.entries = [entry("artifact:a")]
  render(<FilesMobileLibrary />)
  await user.click(screen.getByTestId("files-mobile-open-artifact:a"))
  expect(mockActions.preview).toHaveBeenCalled()
  expect(screen.getByTestId("preview-artifact:a")).toHaveAttribute("data-touch", "true")
  await user.click(screen.getByRole("button", { name: "dismiss" }))
  expect(useFilesLibraryStore.getState().selectedKey).toBeNull()
  expect(screen.queryByTestId("preview-drawer")).toBeNull()
})

it("selects on a long-press, toggles on taps, and leaves with Done", async () => {
  entriesState.entries = [entry("artifact:a"), entry("artifact:b"), entry("artifact:c")]
  render(<FilesMobileLibrary />)
  expect(screen.queryByTestId("files-mobile-bulk-bar")).toBeNull()

  longPress(screen.getByTestId("files-mobile-open-artifact:a"))
  expect(screen.getByTestId("files-mobile-bulk-count")).toHaveTextContent("1 selected")
  expect(mockActions.preview).not.toHaveBeenCalled()

  fireEvent.click(screen.getByTestId("files-mobile-open-artifact:b"))
  expect(screen.getByTestId("files-mobile-bulk-count")).toHaveTextContent("2 selected")
  fireEvent.click(screen.getByTestId("files-mobile-bulk-favorite"))
  expect(mockActions.setFavorite).toHaveBeenCalledWith(
    [expect.objectContaining({ key: "artifact:a" }), expect.objectContaining({ key: "artifact:b" })],
    true
  )

  fireEvent.click(screen.getByTestId("files-mobile-select-all"))
  expect(screen.getByTestId("files-mobile-bulk-count")).toHaveTextContent("3 selected")

  fireEvent.click(screen.getByTestId("files-mobile-select-done"))
  expect(screen.queryByTestId("files-mobile-bulk-bar")).toBeNull()
  expect(screen.queryByTestId("preview-drawer")).toBeNull()
})

it("enters selection from the Select button with nothing picked yet", () => {
  entriesState.entries = [entry("artifact:a")]
  render(<FilesMobileLibrary />)
  const select = screen.getByTestId("files-mobile-select")
  fireEvent.click(select)
  expect(select).toHaveAttribute("aria-pressed", "true")
  expect(screen.getByTestId("files-mobile-bulk-count")).toHaveTextContent(
    "Tap items to select them"
  )
  fireEvent.click(screen.getByTestId("files-mobile-open-artifact:a"))
  expect(screen.getByTestId("files-mobile-bulk-count")).toHaveTextContent("1 selected")
  expect(mockActions.preview).not.toHaveBeenCalled()
  fireEvent.click(select)
  expect(screen.queryByTestId("files-mobile-bulk-bar")).toBeNull()
})

it("ends selection mode when the place changes", () => {
  entriesState.entries = [entry("artifact:a")]
  render(<FilesMobileLibrary />)
  longPress(screen.getByTestId("files-mobile-open-artifact:a"))
  expect(screen.getByTestId("files-mobile-bulk-bar")).toBeInTheDocument()
  act(() => useFilesLibraryStore.getState().setLens("favorites"))
  expect(screen.queryByTestId("files-mobile-bulk-bar")).toBeNull()
})

it("picks a place from the sheet, which then closes", async () => {
  const user = userEvent.setup()
  entriesState.entries = [entry("artifact:a"), entry("artifact:t", { trashedAt: 5 })]
  render(<FilesMobileLibrary />)
  await user.click(screen.getByTestId("files-mobile-places"))
  const sheet = await screen.findByTestId("files-mobile-places-sheet")
  await user.click(within(sheet).getByTestId("files-place-trash"))
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "trash" })
  expect(screen.queryByTestId("files-mobile-places-sheet")).toBeNull()
  // The Trash has no lenses and no New; it can be emptied.
  expect(screen.queryByTestId("files-lens-suggested")).toBeNull()
  expect(screen.queryByTestId("files-new")).toBeNull()
  fireEvent.click(screen.getByTestId("files-empty-trash"))
  expect(useFilesLibraryStore.getState().emptyTrashOpen).toBe(true)
})

it("lists subfolders first in a folder, with its path above", () => {
  folderState.folders = [folder("f1", "Research")]
  entriesState.entries = [entry("artifact:a", { folderId: "root" })]
  useFilesLibraryStore.setState({ section: { kind: "folder", folderId: "root" } })
  render(<FilesMobileLibrary />)
  const rows = screen.getByTestId("files-mobile-list").querySelectorAll("li")
  expect(rows[0]).toHaveAttribute("data-testid", "files-mobile-folder-f1")
  expect(rows[1]).toHaveAttribute("data-testid", "files-mobile-row-artifact:a")
  expect(screen.getByTestId("files-breadcrumb")).toBeInTheDocument()
})

it("explains how to fill an empty folder by tap, not by drag", () => {
  folderState.folders = [folder("f1", "Research")]
  entriesState.entries = []
  useFilesLibraryStore.setState({ section: { kind: "folder", folderId: "f1" } })
  render(<FilesMobileLibrary />)
  expect(screen.getByTestId("files-empty-folder").textContent).toContain(
    "select items and tap Move"
  )
  expect(screen.queryByTestId("files-mobile-select")).toBeNull()
})

it("shows more of a long view on a full-width button", async () => {
  const user = userEvent.setup()
  entriesState.entries = Array.from({ length: 70 }, (_, i) =>
    entry(`artifact:${String(i).padStart(2, "0")}`)
  )
  render(<FilesMobileLibrary />)
  expect(screen.getAllByTestId(/^files-mobile-row-/)).toHaveLength(60)
  const more = screen.getByTestId("files-show-more")
  expect(more).toHaveClass("h-11")
  await user.click(more)
  expect(screen.getAllByTestId(/^files-mobile-row-/)).toHaveLength(70)
})

it("searches from its own full-width field", async () => {
  const user = userEvent.setup()
  entriesState.entries = [entry("artifact:alpha"), entry("artifact:beta")]
  render(<FilesMobileLibrary />)
  await user.type(screen.getByTestId("files-search"), "beta")
  expect(useFilesLibraryStore.getState().search).toBe("beta")
})
