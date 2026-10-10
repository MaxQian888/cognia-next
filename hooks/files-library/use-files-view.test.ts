/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import type { LibraryFolder } from "@/lib/db/files-library-types"
import type { FilesEntry } from "@/lib/files-library/types"
import { DEFAULT_FILES_VIEW_FILTERS, useFilesLibraryStore } from "@/stores/files-library"
import { useProjectStore } from "@/stores/project/project-store"

import { FILES_SIDEBAR_RECENTS, useFilesView } from "./use-files-view"

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

function entry(key: string, overrides: Partial<FilesEntry> = {}): FilesEntry {
  const [kind, sourceId] = key.split(":") as [FilesEntry["kind"], string]
  return {
    key,
    kind,
    sourceId,
    title: sourceId,
    sourceTitle: sourceId,
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: sourceId,
    ...overrides,
  }
}

function folder(id: string, parentFolderId: string, name = id): LibraryFolder {
  return { id, name, parentFolderId, createdAt: 1, updatedAt: 1 }
}

const keys = (list: readonly FilesEntry[] | undefined) => list?.map((e) => e.key)

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(NOW)
  useProjectStore.setState({ activeProjectId: null } as never)
  useFilesLibraryStore.setState({
    section: { kind: "all" },
    lens: "suggested",
    sort: null,
    filters: DEFAULT_FILES_VIEW_FILTERS,
    projectScope: "current",
    search: "",
    selectedKey: null,
  })
})

afterEach(() => {
  jest.useRealTimers()
})

function view(entries: readonly FilesEntry[] | undefined, folders: readonly LibraryFolder[] = []) {
  return renderHook(({ e, f }) => useFilesView(e, f), { initialProps: { e: entries, f: folders } })
}

it("is undefined while the entries load, with empty sidebar data", () => {
  const { result } = view(undefined)
  expect(result.current.visible).toBeUndefined()
  expect(result.current.recents).toEqual([])
  expect(result.current.trashCount).toBe(0)
  expect(result.current.filtered).toBe(false)
  expect(result.current.now).toBe(NOW)
})

it("leaves trashed and hidden items out of a normal place, and counts the Trash", () => {
  const entries = [
    entry("artifact:a"),
    entry("artifact:t", { trashedAt: NOW - 10 }),
    entry("artifact:h", { hidden: true }),
    entry("canvas:t2", { trashedAt: NOW - 5 }),
  ]
  const { result } = view(entries)
  expect(keys(result.current.visible)).toEqual(["artifact:a"])
  expect(result.current.trashCount).toBe(2)
})

it("shows only trashed items in the Trash, newest-trashed first, ignoring the lens", () => {
  useFilesLibraryStore.setState({ section: { kind: "trash" }, lens: "favorites" })
  const entries = [
    entry("artifact:a"),
    entry("artifact:old", { trashedAt: NOW - 100 }),
    entry("artifact:new", { trashedAt: NOW - 1 }),
  ]
  const { result } = view(entries)
  expect(keys(result.current.visible)).toEqual(["artifact:new", "artifact:old"])
})

it("narrows by type group, lens and folder", () => {
  const entries = [
    entry("artifact:a", { creator: "ai", folderId: "lbf_1" }),
    entry("canvas:c", { favoritedAt: NOW - 1, folderId: "lbf_2" }),
    entry("image:i", { mediaType: "image/png", folderId: "lbf_1" }),
    entry("artifact:s", { sharedWithMe: true }),
  ]
  const { result } = view(entries)

  act(() => useFilesLibraryStore.getState().setSection({ kind: "group", group: "artifacts" }))
  expect(keys(result.current.visible)?.sort()).toEqual(["artifact:a", "artifact:s"])

  act(() => {
    useFilesLibraryStore.getState().setSection({ kind: "all" })
    useFilesLibraryStore.getState().setLens("ai")
  })
  expect(keys(result.current.visible)).toEqual(["artifact:a"])

  act(() => useFilesLibraryStore.getState().setLens("favorites"))
  expect(keys(result.current.visible)).toEqual(["canvas:c"])

  act(() => useFilesLibraryStore.getState().setLens("shared"))
  expect(keys(result.current.visible)).toEqual(["artifact:s"])

  act(() => {
    useFilesLibraryStore.getState().setLens("suggested")
    useFilesLibraryStore.getState().setSection({ kind: "folder", folderId: "lbf_1" })
  })
  expect(keys(result.current.visible)?.sort()).toEqual(["artifact:a", "image:i"])
})

it("sorts Recents by activity, newest first, and by the clicked column when one is set", () => {
  useFilesLibraryStore.setState({ section: { kind: "recent" } })
  const entries = [
    entry("artifact:b", { updatedAt: NOW - 3 * DAY }),
    entry("artifact:a", { updatedAt: NOW - 2 * DAY, lastAccessedAt: NOW - 10 }),
    entry("artifact:c", { updatedAt: NOW - DAY }),
  ]
  const { result } = view(entries)
  expect(keys(result.current.visible)).toEqual(["artifact:a", "artifact:c", "artifact:b"])

  act(() => useFilesLibraryStore.getState().setSort({ key: "name", dir: "asc" }))
  expect(keys(result.current.visible)).toEqual(["artifact:a", "artifact:b", "artifact:c"])
  act(() => useFilesLibraryStore.getState().setSort({ key: "name", dir: "desc" }))
  expect(keys(result.current.visible)).toEqual(["artifact:c", "artifact:b", "artifact:a"])
})

it("filters by search, format, modified window and workspace, and flags the narrowing", () => {
  useProjectStore.setState({ activeProjectId: "p1" } as never)
  const entries = [
    entry("artifact:lexer", { searchText: "lexer tokens", projectIds: ["p1"] }),
    entry("artifact:parser", { searchText: "parser tokens", projectIds: ["p2"] }),
    entry("image:pic", { mediaType: "image/png", updatedAt: NOW - 40 * DAY }),
  ]
  const { result } = view(entries)
  // Current workspace: p2's item is foreign, the unscoped image is shared.
  expect(keys(result.current.visible)?.sort()).toEqual(["artifact:lexer", "image:pic"])
  expect(result.current.filtered).toBe(false)

  act(() => useFilesLibraryStore.getState().setProjectScope("all"))
  expect(result.current.visible).toHaveLength(3)
  // The workspace scope is a preference, not a narrowing filter.
  expect(result.current.filtered).toBe(false)

  act(() => useFilesLibraryStore.getState().setSearch("TOKENS parser"))
  expect(keys(result.current.visible)).toEqual(["artifact:parser"])
  expect(result.current.filtered).toBe(true)

  act(() => {
    useFilesLibraryStore.getState().setSearch("")
    useFilesLibraryStore.getState().setFilters({ formats: ["image"] })
  })
  expect(keys(result.current.visible)).toEqual(["image:pic"])
  expect(result.current.filtered).toBe(true)

  act(() => useFilesLibraryStore.getState().setFilters({ formats: [], modified: "month" }))
  expect(keys(result.current.visible)?.sort()).toEqual(["artifact:lexer", "artifact:parser"])

  act(() => useFilesLibraryStore.getState().resetFilters())
  expect(result.current.visible).toHaveLength(3)
  expect(result.current.filtered).toBe(false)
})

it("lists child folders only while a folder is in view", () => {
  const folders = [
    folder("lbf_b", "lbf_root_x", "Beta"),
    folder("lbf_a", "lbf_root_x", "Alpha"),
    folder("lbf_c", "lbf_other"),
  ]
  const { result } = view([], folders)
  expect(result.current.childFolders).toEqual([])
  act(() => useFilesLibraryStore.getState().setSection({ kind: "folder", folderId: "lbf_root_x" }))
  expect(result.current.childFolders.map((f) => f.id)).toEqual(["lbf_a", "lbf_b"])
  act(() => useFilesLibraryStore.getState().setSection({ kind: "trash" }))
  expect(result.current.childFolders).toEqual([])
})

it("lists the newest few live items as recents", () => {
  const entries = Array.from({ length: FILES_SIDEBAR_RECENTS + 2 }, (_, i) =>
    entry(`artifact:n${i}`, { updatedAt: NOW - (i + 1) * DAY })
  )
  entries.push(entry("artifact:trashed", { updatedAt: NOW, trashedAt: NOW }))
  entries.push(entry("artifact:hidden", { updatedAt: NOW, hidden: true }))
  entries.push(entry("artifact:opened", { updatedAt: NOW - 30 * DAY, lastAccessedAt: NOW - 1 }))
  const { result } = view(entries)
  expect(FILES_SIDEBAR_RECENTS).toBe(5)
  expect(keys(result.current.recents)).toEqual([
    "artifact:opened",
    "artifact:n0",
    "artifact:n1",
    "artifact:n2",
    "artifact:n3",
  ])
})

it("keeps a workspace file out of the recents until it is kept or opened (ADR-0223 §8)", () => {
  const entries = [
    entry("workspace-file:loose", { kind: "workspace-file", updatedAt: NOW }),
    entry("workspace-file:opened", {
      kind: "workspace-file",
      updatedAt: NOW - DAY,
      lastAccessedAt: NOW - 1,
    }),
    entry("artifact:a", { updatedAt: NOW - 2 * DAY }),
  ]
  const { result } = view(entries)
  expect(keys(result.current.recents)).toEqual(["workspace-file:opened", "artifact:a"])
})

it("breaks recency ties by key", () => {
  const entries = [entry("artifact:z"), entry("artifact:m"), entry("artifact:a")]
  const { result } = view(entries)
  expect(keys(result.current.recents)).toEqual(["artifact:a", "artifact:m", "artifact:z"])
})

it("moves its clock once a minute, re-evaluating the modified window", () => {
  useFilesLibraryStore.setState({ filters: { ...DEFAULT_FILES_VIEW_FILTERS, modified: "day" } })
  // Just inside the one-day window now; outside it two minutes later.
  const entries = [entry("artifact:edge", { updatedAt: NOW - DAY + 60_000 })]
  const { result } = view(entries)
  expect(keys(result.current.visible)).toEqual(["artifact:edge"])
  act(() => {
    jest.advanceTimersByTime(59_000)
  })
  expect(result.current.now).toBe(NOW)
  act(() => {
    jest.advanceTimersByTime(61_000)
  })
  expect(result.current.now).toBe(NOW + 120_000)
  expect(result.current.visible).toEqual([])
})

it("keeps what a paired host matched inside bodies the entries do not carry", () => {
  const entries = [entry("artifact:plan"), entry("artifact:notes")]
  const { result, rerender } = renderHook(({ m }) => useFilesView(entries, [], m), {
    initialProps: { m: undefined as ReadonlySet<string> | undefined },
  })
  act(() => useFilesLibraryStore.getState().setSearch("revenue"))
  expect(keys(result.current.visible)).toEqual([])
  rerender({ m: new Set(["artifact:notes"]) })
  expect(keys(result.current.visible)).toEqual(["artifact:notes"])
})
