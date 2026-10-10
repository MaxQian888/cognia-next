/**
 * @jest-environment jsdom
 */
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
const actions = {
  open: jest.fn(async () => {}),
  preview: jest.fn(),
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
  moveFolder: jest.fn(async () => {}),
  setFolderStyle: jest.fn(async () => {}),
}
jest.mock("@/hooks/files-library/use-files-actions", () => ({
  ...jest.requireActual("@/hooks/files-library/use-files-actions"),
  useFilesActions: () => actions,
}))
jest.mock("./files-image-thumb", () => ({ FilesImageThumb: () => <div data-testid="thumb" /> }))
jest.mock("@/hooks/document-templates/use-document-templates", () => ({
  useDocumentTemplates: () => ({ enabled: true, options: [] }),
}))
jest.mock("./files-preview-pane", () => ({
  FilesPreviewPane: ({ entry }: { entry: { key: string } }) => (
    <div data-testid={`preview-${entry.key}`} />
  ),
}))
let compact = false
jest.mock("@/hooks/ui/use-compact-layout", () => ({ useCompactLayout: () => compact }))
jest.mock("./mobile/files-mobile-library", () => ({
  FilesMobileLibrary: () => <div data-testid="files-mobile" />,
}))
let params = new URLSearchParams()
const router = { push: jest.fn(), replace: jest.fn() }
jest.mock("next/navigation", () => ({
  useSearchParams: () => params,
  useRouter: () => router,
  usePathname: () => "/files",
}))

import type { FilesEntry } from "@/lib/files-library/types"
import { DEFAULT_FILES_VIEW_FILTERS, useFilesLibraryStore } from "@/stores/files-library"
import { useProjectStore } from "@/stores/project/project-store"
import { FILES_PAGE_SIZE, FilesLibrary } from "./files-library"

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

const grid = () => within(screen.getByTestId("files-grid"))

beforeEach(() => {
  compact = false
  params = new URLSearchParams()
  router.replace.mockClear()
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
  })
})

it("shows a skeleton until the first load", () => {
  render(<FilesLibrary />)
  expect(screen.getByLabelText("Loading files")).toHaveAttribute("aria-busy", "true")
})

it("lists this workspace's entries and hides removed and trashed ones", () => {
  entriesState.entries = [
    entry("mine", { projectIds: ["p1"] }),
    entry("shared"),
    entry("other", { projectIds: ["p2"] }),
    entry("removed", { hidden: true }),
    entry("binned", { trashedAt: 5 }),
  ]
  render(<FilesLibrary />)
  expect(
    grid()
      .getAllByRole("button", { name: /^Open / })
      .map((el) => el.getAttribute("aria-label"))
  ).toEqual(expect.arrayContaining(["Open mine", "Open shared"]))
  for (const name of ["Open other", "Open removed", "Open binned"]) {
    expect(grid().queryByRole("button", { name })).toBeNull()
  }
  expect(screen.getByText("2 items")).toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "All" })).toBeInTheDocument()
})

it("opens Suggested with the template strip, and nowhere else", () => {
  entriesState.entries = [entry("a")]
  const { rerender } = render(<FilesLibrary />)
  expect(screen.getByTestId("files-template-strip")).toBeInTheDocument()
  act(() => useFilesLibraryStore.getState().setLens("favorites"))
  rerender(<FilesLibrary />)
  expect(screen.queryByTestId("files-template-strip")).toBeNull()
  act(() => {
    useFilesLibraryStore.getState().setLens("suggested")
    useFilesLibraryStore.getState().setSection({ kind: "trash" })
  })
  rerender(<FilesLibrary />)
  expect(screen.queryByTestId("files-template-strip")).toBeNull()
  act(() => {
    useFilesLibraryStore.getState().setSection({ kind: "all" })
    useFilesLibraryStore.getState().setSearch("zzz")
  })
  rerender(<FilesLibrary />)
  expect(screen.queryByTestId("files-template-strip")).toBeNull()
})

it("narrows by lens", () => {
  entriesState.entries = [entry("by-me"), entry("by-ai", { creator: "ai" })]
  render(<FilesLibrary />)
  // The resizable panel group claims every pointerdown in jsdom (all rects
  // sit at 0,0, inside its separator's hit area), so press the tab directly.
  fireEvent.mouseDown(screen.getByRole("tab", { name: "AI-generated" }), { button: 0 })
  expect(grid().getByRole("button", { name: "Open by-ai" })).toBeInTheDocument()
  expect(grid().queryByRole("button", { name: "Open by-me" })).toBeNull()
})

it("shows the Trash with Empty Trash and no lenses", async () => {
  entriesState.entries = [entry("binned", { trashedAt: 5 }), entry("live")]
  useFilesLibraryStore.setState({ section: { kind: "trash" } })
  render(<FilesLibrary />)
  expect(screen.getByRole("heading", { name: "Trash" })).toBeInTheDocument()
  expect(screen.queryByRole("tablist")).toBeNull()
  expect(grid().getByRole("button", { name: "Open binned" })).toBeInTheDocument()
  expect(grid().queryByRole("button", { name: "Open live" })).toBeNull()
  await userEvent.setup().click(screen.getByRole("button", { name: "Empty Trash" }))
  expect(useFilesLibraryStore.getState().emptyTrashOpen).toBe(true)
  expect(await screen.findByTestId("files-empty-trash-dialog")).toBeInTheDocument()
})

it("shows subfolders before the items of a folder", () => {
  folderState.folders = [
    { id: "lbf_a", name: "Specs", parentFolderId: "root", createdAt: 1, updatedAt: 1 },
    { id: "lbf_b", name: "Drafts", parentFolderId: "lbf_a", createdAt: 1, updatedAt: 1 },
  ]
  entriesState.entries = [entry("filed", { folderId: "lbf_a" }), entry("loose")]
  useFilesLibraryStore.setState({ section: { kind: "folder", folderId: "lbf_a" } })
  render(<FilesLibrary />)
  expect(screen.getByRole("heading", { name: "Specs" })).toBeInTheDocument()
  expect(screen.getByTestId("files-folder-tiles")).toHaveTextContent("Drafts")
  expect(grid().getByRole("button", { name: "Open filed" })).toBeInTheDocument()
  expect(grid().queryByRole("button", { name: "Open loose" })).toBeNull()
})

it("switches to the list layout and to an empty filtered state that can be cleared", async () => {
  entriesState.entries = [entry("alpha")]
  useFilesLibraryStore.setState({ viewMode: "list", search: "zzz" })
  render(<FilesLibrary />)
  expect(screen.getByText("No matches")).toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole("button", { name: "Clear filters" }))
  expect(useFilesLibraryStore.getState().search).toBe("")
  expect(await screen.findByTestId("files-list")).toBeInTheDocument()
})

it("pages long lists and offers older images", async () => {
  entriesState.entries = Array.from({ length: FILES_PAGE_SIZE + 5 }, (_, i) =>
    entry(`e${String(i).padStart(3, "0")}`)
  )
  entriesState.imagesTruncated = true
  const user = userEvent.setup()
  render(<FilesLibrary />)
  expect(grid().getAllByRole("button", { name: /^Open e/ })).toHaveLength(FILES_PAGE_SIZE)
  await user.click(screen.getByTestId("files-show-more"))
  expect(grid().getAllByRole("button", { name: /^Open e/ })).toHaveLength(FILES_PAGE_SIZE + 5)
  await user.click(screen.getByRole("button", { name: "Load older images" }))
  expect(entriesState.loadMoreImages).toHaveBeenCalled()
})

it("selects with modifiers, shows the bulk bar, and clears on Esc", async () => {
  entriesState.entries = [entry("a"), entry("b")]
  render(<FilesLibrary />)
  fireEvent.click(grid().getByRole("button", { name: "Open a" }), { metaKey: true })
  fireEvent.click(grid().getByRole("button", { name: "Open b" }), { metaKey: true })
  expect(screen.getByRole("toolbar", { name: "Selected items" })).toHaveTextContent("2 selected")
  fireEvent.keyDown(grid().getByRole("button", { name: "Open a" }), { key: "Escape" })
  expect(screen.queryByRole("toolbar", { name: "Selected items" })).toBeNull()
})

it("selects everything with ⌘A and trashes the selection with Delete", () => {
  entriesState.entries = [entry("a"), entry("b")]
  render(<FilesLibrary />)
  const body = screen.getByTestId("files-body")
  fireEvent.keyDown(body, { key: "a", metaKey: true })
  expect(screen.getByTestId("files-bulk-count")).toHaveTextContent("2 selected")
  fireEvent.keyDown(body, { key: "Delete" })
  expect(actions.trash).toHaveBeenCalledWith([
    expect.objectContaining({ key: "a" }),
    expect.objectContaining({ key: "b" }),
  ])
})

it("follows the ?item= deep link into the preview pane", () => {
  entriesState.entries = [entry("artifact:a1")]
  params = new URLSearchParams("item=artifact:a1")
  render(<FilesLibrary />)
  expect(screen.getByTestId("preview-artifact:a1")).toBeInTheDocument()
})

it("opens the place and lens a link names without rewriting it", () => {
  entriesState.entries = []
  params = new URLSearchParams("section=trash")
  render(<FilesLibrary />)
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "trash" })
  expect(router.replace).not.toHaveBeenCalled()
})

it("rewrites an ADR-0200 ?tab= link to its place", () => {
  entriesState.entries = []
  params = new URLSearchParams("tab=folders")
  render(<FilesLibrary />)
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "folder", folderId: "root" })
  expect(router.replace).toHaveBeenCalledWith("/files?section=folder%3Aroot")
})

it("keeps the URL on the place and lens the person picks", () => {
  entriesState.entries = []
  render(<FilesLibrary />)
  expect(router.replace).not.toHaveBeenCalled()
  act(() => useFilesLibraryStore.getState().setLens("favorites"))
  expect(router.replace).toHaveBeenLastCalledWith("/files?tab=favorites")
  act(() => useFilesLibraryStore.getState().setSection({ kind: "group", group: "images" }))
  expect(router.replace).toHaveBeenLastCalledWith("/files?section=group%3Aimages&tab=favorites")
})

it("lays a phone-width page out as the compact list (ADR-0223 §9)", () => {
  compact = true
  entriesState.entries = [entry("artifact:a")]
  render(<FilesLibrary />)
  expect(screen.getByTestId("files-mobile")).toBeInTheDocument()
  expect(screen.queryByTestId("files-grid")).toBeNull()
  expect(screen.queryByTestId("files-sidebar")).toBeNull()
})
