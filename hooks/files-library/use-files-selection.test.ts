/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

import { useFilesSelection } from "./use-files-selection"

function entry(key: string): FilesEntry {
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
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: sourceId,
  }
}

const PLAIN = { ctrlKey: false, metaKey: false, shiftKey: false }
const CTRL = { ctrlKey: true, metaKey: false, shiftKey: false }
const META = { ctrlKey: false, metaKey: true, shiftKey: false }
const SHIFT = { ctrlKey: false, metaKey: false, shiftKey: true }

const visible = ["artifact:a", "canvas:b", "image:c", "upload:d"].map(entry)

function selection(list: readonly FilesEntry[] | undefined = visible) {
  return renderHook(({ v }) => useFilesSelection(v), { initialProps: { v: list } })
}

const selectedKeys = (s: { entries: FilesEntry[] }) => s.entries.map((e) => e.key)

beforeEach(() => {
  useFilesLibraryStore.setState({ section: { kind: "all" }, lens: "suggested" })
})

it("mirrors the visible order, and is empty while loading", () => {
  expect(selection().result.current.order).toEqual([
    "artifact:a",
    "canvas:b",
    "image:c",
    "upload:d",
  ])
  const loading = renderHook(() => useFilesSelection(undefined)).result.current
  expect(loading.order).toEqual([])
  expect(loading.entries).toEqual([])
})

it("plain click selects one; Ctrl/⌘-click toggles", () => {
  const { result } = selection()
  act(() => result.current.handleClick("canvas:b", PLAIN))
  expect(selectedKeys(result.current)).toEqual(["canvas:b"])
  expect(result.current.anchorId).toBe("canvas:b")
  act(() => result.current.handleClick("upload:d", CTRL))
  act(() => result.current.handleClick("artifact:a", META))
  expect(selectedKeys(result.current)).toEqual(["artifact:a", "canvas:b", "upload:d"])
  act(() => result.current.handleClick("canvas:b", CTRL))
  expect(selectedKeys(result.current)).toEqual(["artifact:a", "upload:d"])
  act(() => result.current.handleClick("image:c", PLAIN))
  expect(selectedKeys(result.current)).toEqual(["image:c"])
})

it("Shift-click selects the range from the anchor", () => {
  const { result } = selection()
  act(() => result.current.handleClick("upload:d", PLAIN))
  act(() => result.current.handleClick("canvas:b", SHIFT))
  expect(selectedKeys(result.current)).toEqual(["canvas:b", "image:c", "upload:d"])
  expect(result.current.anchorId).toBe("upload:d")
})

it("returns the selected entries in view order, whatever order they were picked in", () => {
  const { result, rerender } = selection()
  act(() => result.current.handleClick("upload:d", CTRL))
  act(() => result.current.handleClick("artifact:a", CTRL))
  expect(selectedKeys(result.current)).toEqual(["artifact:a", "upload:d"])
  // The view reorders: entries follow it.
  rerender({ v: [...visible].reverse() })
  expect(selectedKeys(result.current)).toEqual(["upload:d", "artifact:a"])
  // An item that leaves the view leaves the selection.
  rerender({ v: visible.filter((e) => e.key !== "upload:d") })
  expect(selectedKeys(result.current)).toEqual(["artifact:a"])
})

it("selects every item in view", () => {
  const { result } = selection()
  act(() => result.current.selectAll())
  expect(selectedKeys(result.current)).toEqual(visible.map((e) => e.key))
})

it("starts over when the place changes", () => {
  const { result } = selection()
  act(() => result.current.handleClick("canvas:b", PLAIN))
  expect(result.current.selected.size).toBe(1)
  act(() => useFilesLibraryStore.getState().setSection({ kind: "recent" }))
  expect(result.current.selected.size).toBe(0)
  expect(result.current.entries).toEqual([])
  expect(result.current.anchorId).toBeNull()
})

it("starts over when the folder in view changes", () => {
  useFilesLibraryStore.setState({ section: { kind: "folder", folderId: "lbf_1" } })
  const { result } = selection()
  act(() => result.current.handleClick("canvas:b", PLAIN))
  act(() => useFilesLibraryStore.getState().setSection({ kind: "folder", folderId: "lbf_2" }))
  expect(result.current.selected.size).toBe(0)
})

it("starts over when the lens changes", () => {
  const { result } = selection()
  act(() => result.current.selectAll())
  act(() => useFilesLibraryStore.getState().setLens("favorites"))
  expect(result.current.selected.size).toBe(0)
})

it("keeps the selection across unrelated store changes", () => {
  const { result } = selection()
  act(() => result.current.handleClick("canvas:b", PLAIN))
  act(() => {
    useFilesLibraryStore.getState().setSearch("x")
    useFilesLibraryStore.getState().select("canvas:b")
    // Same place, fresh object.
    useFilesLibraryStore.setState({ section: { kind: "all" } })
  })
  expect(selectedKeys(result.current)).toEqual(["canvas:b"])
})
