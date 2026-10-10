/**
 * @jest-environment jsdom
 */
import { type ComponentProps, createElement, type ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"

const entriesState: { entries: unknown; imagesTruncated: boolean; loadMoreImages: jest.Mock } = {
  entries: undefined,
  imagesTruncated: false,
  loadMoreImages: jest.fn(),
}
jest.mock("./use-files-entries", () => ({ useFilesEntries: () => entriesState }))
const folderState: { folders: unknown[] } = { folders: [] }
jest.mock("./use-files-folders", () => ({ useFilesFolders: () => folderState.folders }))
const actions = { preview: jest.fn() }
const actionsFor = jest.fn()
jest.mock("./use-files-actions", () => ({
  useFilesActions: (ops: unknown) => {
    actionsFor(ops)
    return actions
  },
}))
const deepLink = jest.fn()
jest.mock("./use-files-deep-link", () => ({ useFilesDeepLink: () => deepLink() }))

import type { LibraryFolder } from "@/lib/db/files-library-types"
import type { FilesEntry } from "@/lib/files-library/types"
import { DEFAULT_FILES_VIEW_FILTERS, useFilesLibraryStore } from "@/stores/files-library"
import { useProjectStore } from "@/stores/project/project-store"
import { localFilesCapabilities, type FilesOps } from "@/lib/files-library/ops"
import { PAIRED_FILES_CAPABILITIES } from "@/lib/files-library/remote/remote-ops"
import { FilesBackendProvider, type FilesBackend } from "./files-backend"
import { FILES_PAGE_SIZE, useFilesPage } from "./use-files-page"

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
    searchText: key,
    ...overrides,
  }
}

const folder = (id: string, parentFolderId = "root"): LibraryFolder => ({
  id,
  name: id,
  parentFolderId,
  createdAt: 1,
  updatedAt: 1,
})

beforeEach(() => {
  entriesState.entries = undefined
  entriesState.imagesTruncated = false
  folderState.folders = []
  deepLink.mockClear()
  useProjectStore.setState({ activeProjectId: "p1" } as never)
  useFilesLibraryStore.setState({
    section: { kind: "all" },
    lens: "suggested",
    search: "",
    filters: DEFAULT_FILES_VIEW_FILTERS,
    sort: null,
    projectScope: "current",
    selectedKey: null,
  })
})

it("reads the URL and reports a first load as nothing yet, not empty", () => {
  const { result } = renderHook(() => useFilesPage())
  expect(deepLink).toHaveBeenCalled()
  expect(result.current.entries).toBeUndefined()
  expect(result.current.page).toEqual([])
  expect(result.current.empty).toBe(false)
  expect(result.current.hasMore).toBe(false)
  expect(result.current.actions).toBe(actions)
})

it("pages the view and keeps Show more until the view changes", () => {
  entriesState.entries = Array.from({ length: FILES_PAGE_SIZE + 5 }, (_, i) =>
    entry(`artifact:${String(i).padStart(3, "0")}`)
  )
  const { result } = renderHook(() => useFilesPage())
  expect(result.current.page).toHaveLength(FILES_PAGE_SIZE)
  expect(result.current.hasMore).toBe(true)
  act(() => result.current.showMore())
  expect(result.current.page).toHaveLength(FILES_PAGE_SIZE + 5)
  expect(result.current.hasMore).toBe(false)
  act(() => useFilesLibraryStore.getState().setLens("mine"))
  expect(result.current.page).toHaveLength(FILES_PAGE_SIZE)
})

it("offers older images only where images are listed, after the loaded page", () => {
  entriesState.entries = [entry("image:h1", { kind: "image" })]
  entriesState.imagesTruncated = true
  const { result } = renderHook(() => useFilesPage())
  expect(result.current.showImagesMore).toBe(true)
  result.current.loadMoreImages()
  expect(entriesState.loadMoreImages).toHaveBeenCalled()
  act(() => useFilesLibraryStore.getState().setSection({ kind: "group", group: "documents" }))
  expect(result.current.showImagesMore).toBe(false)
})

it("counts items filed directly in each folder, leaving out trashed and removed ones", () => {
  entriesState.entries = [
    entry("artifact:a", { folderId: "f1" }),
    entry("artifact:b", { folderId: "f1" }),
    entry("artifact:c", { folderId: "f1", trashedAt: 5 }),
    entry("artifact:d", { folderId: "f2", hidden: true }),
  ]
  folderState.folders = [folder("f1"), folder("f2")]
  const { result } = renderHook(() => useFilesPage())
  expect(result.current.folderItemCounts.get("f1")).toBe(2)
  expect(result.current.folderItemCounts.has("f2")).toBe(false)
})

it("is empty only with no items and no subfolders", () => {
  entriesState.entries = []
  folderState.folders = [folder("f1")]
  const { result } = renderHook(() => useFilesPage())
  expect(result.current.empty).toBe(true)
  act(() => useFilesLibraryStore.getState().setSection({ kind: "folder", folderId: "root" }))
  expect(result.current.empty).toBe(false)
  expect(result.current.view.childFolders.map((f) => f.id)).toEqual(["f1"])
})

it("puts templates on Suggested in All, and not once something narrows the view", () => {
  entriesState.entries = [entry("artifact:a")]
  const { result } = renderHook(() => useFilesPage())
  expect(result.current.showTemplates).toBe(true)
  act(() => useFilesLibraryStore.getState().setSearch("zzz"))
  expect(result.current.showTemplates).toBe(false)
  act(() => {
    useFilesLibraryStore.getState().setSearch("")
    useFilesLibraryStore.getState().setLens("favorites")
  })
  expect(result.current.showTemplates).toBe(false)
})

it("finds the previewed entry and knows when the place is the Trash", () => {
  entriesState.entries = [entry("artifact:a"), entry("artifact:b")]
  const { result } = renderHook(() => useFilesPage())
  expect(result.current.previewed).toBeUndefined()
  act(() => useFilesLibraryStore.getState().select("artifact:b"))
  expect(result.current.previewed?.key).toBe("artifact:b")
  expect(result.current.trash).toBe(false)
  act(() => useFilesLibraryStore.getState().setSection({ kind: "trash" }))
  expect(result.current.trash).toBe(true)
})

describe("over a mounted backend (ADR-0223 §9)", () => {
  const remoteOps = { mode: "remote", capabilities: PAIRED_FILES_CAPABILITIES } as FilesOps
  function mounted(backend: FilesBackend) {
    return function Mounted({ children }: { children: ReactNode }) {
      return createElement(
        FilesBackendProvider,
        { backend } as ComponentProps<typeof FilesBackendProvider>,
        children
      )
    }
  }

  it("reads the mounted library, not this device's, and runs the actions on its ops", () => {
    entriesState.entries = [entry("artifact:local")]
    const refresh = jest.fn(async () => {})
    const backend: FilesBackend = {
      source: {
        entries: [entry("artifact:host")],
        imagesTruncated: false,
        loadMoreImages: jest.fn(),
        folders: [],
        refresh,
        error: "files_remote_unreachable",
      },
      ops: remoteOps,
    }
    const { result } = renderHook(() => useFilesPage(), { wrapper: mounted(backend) })
    expect(result.current.entries?.map((e) => e.key)).toEqual(["artifact:host"])
    expect(result.current.ops).toBe(remoteOps)
    expect(actionsFor).toHaveBeenLastCalledWith(remoteOps)
    expect(result.current.refresh).toBe(refresh)
    expect(result.current.error).toBe("files_remote_unreachable")
  })

  it("keeps the template strip off where documents are held back", () => {
    const backend: FilesBackend = {
      source: {
        entries: [entry("artifact:a")],
        imagesTruncated: false,
        loadMoreImages: jest.fn(),
        folders: [],
      },
      ops: remoteOps,
    }
    const { result } = renderHook(() => useFilesPage(), { wrapper: mounted(backend) })
    expect(result.current.showTemplates).toBe(false)
  })

  it("finds the host's body matches the entries' own titles miss", () => {
    const backend: FilesBackend = {
      source: {
        entries: [
          entry("artifact:a", { searchText: "plan" }),
          entry("artifact:b", { searchText: "other" }),
        ],
        imagesTruncated: false,
        loadMoreImages: jest.fn(),
        folders: [],
        contentMatches: new Set(["artifact:b"]),
      },
      ops: remoteOps,
    }
    const { result } = renderHook(() => useFilesPage(), { wrapper: mounted(backend) })
    act(() => useFilesLibraryStore.getState().setSearch("revenue"))
    expect(result.current.page.map((e) => e.key)).toEqual(["artifact:b"])
  })

  it("is this device's own library without a provider, with no refresh to offer", () => {
    entriesState.entries = [entry("artifact:local")]
    const { result } = renderHook(() => useFilesPage())
    expect(result.current.ops.capabilities).toEqual(localFilesCapabilities())
    expect(result.current.refresh).toBeUndefined()
    expect(result.current.error).toBeUndefined()
  })
})
