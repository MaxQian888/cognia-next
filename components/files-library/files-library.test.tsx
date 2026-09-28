/**
 * @jest-environment jsdom
 */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const entriesState: { entries: unknown; imagesTruncated: boolean; loadMoreImages: jest.Mock } = {
  entries: undefined,
  imagesTruncated: false,
  loadMoreImages: jest.fn(),
}
jest.mock("@/hooks/files-library/use-files-entries", () => ({
  useFilesEntries: () => entriesState,
}))
jest.mock("@/hooks/files-library/use-files-folders", () => ({ useFilesFolders: () => [] }))
const actions = {
  open: jest.fn(async () => {}),
  preview: jest.fn(),
  toggleFavorite: jest.fn(async () => {}),
  moveToFolder: jest.fn(async () => {}),
  remove: jest.fn(async () => {}),
  deleteOwned: jest.fn(async () => {}),
  download: jest.fn(async () => {}),
  useInChat: jest.fn(async () => {}),
  upload: jest.fn(async () => {}),
  newCanvasDocument: jest.fn(),
}
jest.mock("@/hooks/files-library/use-files-actions", () => ({
  ...jest.requireActual("@/hooks/files-library/use-files-actions"),
  useFilesActions: () => actions,
}))
jest.mock("./files-image-thumb", () => ({ FilesImageThumb: () => <div data-testid="thumb" /> }))
jest.mock("./files-preview-pane", () => ({
  FilesPreviewPane: ({ entry }: { entry: { key: string } }) => (
    <div data-testid={`preview-${entry.key}`} />
  ),
}))
let platform = "web"
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => platform,
}))
let params = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useSearchParams: () => params,
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => "/files",
}))

import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { useProjectStore } from "@/stores/project/project-store"
import { FILES_PAGE_SIZE, FilesLibrary } from "./files-library"

function entry(key: string, overrides: Partial<FilesEntry> = {}): FilesEntry {
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
    searchText: key.toLowerCase(),
    ...overrides,
  }
}

beforeEach(() => {
  platform = "web"
  params = new URLSearchParams()
  entriesState.entries = undefined
  entriesState.imagesTruncated = false
  useProjectStore.setState({ activeProjectId: "p1" } as never)
  useFilesLibraryStore.setState({
    tab: "recent",
    folderId: "root",
    search: "",
    type: "all",
    sort: "recent",
    projectScope: "current",
    viewMode: "grid",
    selectedKey: null,
    moveTarget: null,
  })
})

it("shows a skeleton until the first load", () => {
  render(<FilesLibrary />)
  expect(screen.getByLabelText("Loading files")).toHaveAttribute("aria-busy", "true")
})

it("lists this workspace's entries and hides removed ones", () => {
  entriesState.entries = [
    entry("mine", { projectIds: ["p1"] }),
    entry("shared"),
    entry("other", { projectIds: ["p2"] }),
    entry("removed", { hidden: true }),
  ]
  render(<FilesLibrary />)
  const grid = screen.getByTestId("files-grid")
  expect(
    within(grid)
      .getAllByRole("button", { name: /^Open / })
      .map((el) => el.getAttribute("aria-label"))
  ).toEqual(expect.arrayContaining(["Open mine", "Open shared"]))
  expect(within(grid).queryByRole("button", { name: "Open other" })).toBeNull()
  expect(within(grid).queryByRole("button", { name: "Open removed" })).toBeNull()
  expect(screen.getByText("2 items")).toBeInTheDocument()
})

it("switches to the list layout and to an empty filtered state that can be cleared", async () => {
  entriesState.entries = [entry("alpha")]
  useFilesLibraryStore.setState({ viewMode: "list", search: "zzz" })
  render(<FilesLibrary />)
  expect(screen.getByText("No matches")).toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole("button", { name: "Clear search and filters" }))
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
  expect(screen.getAllByRole("button", { name: /^Open e/ })).toHaveLength(FILES_PAGE_SIZE)
  await user.click(screen.getByRole("button", { name: "Show more" }))
  expect(screen.getAllByRole("button", { name: /^Open e/ })).toHaveLength(FILES_PAGE_SIZE + 5)
  await user.click(screen.getByRole("button", { name: "Load older images" }))
  expect(entriesState.loadMoreImages).toHaveBeenCalled()
})

it("follows the ?tab= and ?item= deep link into the preview pane", () => {
  entriesState.entries = [entry("artifact:a1")]
  params = new URLSearchParams("tab=all&item=artifact:a1")
  render(<FilesLibrary />)
  expect(useFilesLibraryStore.getState().tab).toBe("all")
  expect(screen.getByTestId("preview-artifact:a1")).toBeInTheDocument()
})

it("explains itself on the phone shell instead of reading this database", () => {
  platform = "mobile"
  render(<FilesLibrary />)
  expect(screen.getByTestId("files-mobile-unsupported")).toBeInTheDocument()
  expect(screen.queryByTestId("files-body")).toBeNull()
})
