/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

let revision = "0:0"
const liveQuery = jest.fn((query: () => unknown) => {
  // The live query's own work is the turn table's revision; the test drives it.
  void query
  return revision
})
jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: (query: () => unknown) => liveQuery(query),
}))
jest.mock("@/lib/task-workspace/client", () => ({
  onTaskWorkspaceLedgerChange: jest.fn(() => () => undefined),
}))
jest.mock("@/lib/files-library/workspace-files-io", () => ({
  loadWorkspaceFileIndex: jest.fn(async () => []),
}))

import type { TaskResourceIndexEntry } from "@/lib/task-workspace/types"
import { useWorkspaceFileIndex } from "./use-workspace-file-index"

function entry(path: string): TaskResourceIndexEntry {
  return {
    sessionId: "s1",
    taskId: "t",
    runId: "r",
    workspaceRoot: "/repo",
    executionRoot: "/repo",
    path,
    kind: "created",
    oldPath: null,
    mediaType: "text/plain",
    size: 1,
    hash: null,
    binary: false,
    firstChangedAt: 1,
    changedAt: 1,
    adoption: "applied",
  }
}

beforeEach(() => {
  revision = "0:0"
  liveQuery.mockClear()
})

it("reads nothing where this device lists no workspace files", () => {
  const load = jest.fn(async () => [entry("a.md")])
  const { result } = renderHook(() => useWorkspaceFileIndex(false, { load }))
  expect(result.current).toBeUndefined()
  expect(load).not.toHaveBeenCalled()
})

it("reads the index, and again when a turn settles or the page comes back", async () => {
  const load = jest.fn(async () => [entry("a.md")])
  const { result, rerender } = renderHook(() => useWorkspaceFileIndex(true, { load }))
  await waitFor(() => expect(result.current).toEqual({ index: [entry("a.md")] }))
  expect(load).toHaveBeenCalledTimes(1)

  // A settle writes a turn row: the live query's revision moves.
  load.mockResolvedValueOnce([entry("b.md")])
  revision = "1:5"
  rerender()
  await waitFor(() => expect(result.current).toEqual({ index: [entry("b.md")] }))

  await act(async () => {
    window.dispatchEvent(new Event("focus"))
  })
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3))
})

it("reads again when this renderer changes the ledger, and stops listening on unmount", async () => {
  const load = jest.fn(async () => [entry("a.md")])
  let fire: () => void = () => undefined
  const stop = jest.fn()
  const onLedgerChange = jest.fn((listener: () => void) => {
    fire = listener
    return stop
  })
  const { result, unmount } = renderHook(() =>
    useWorkspaceFileIndex(true, { load, onLedgerChange })
  )
  await waitFor(() => expect(result.current).toEqual({ index: [entry("a.md")] }))
  // An apply or undo rewrites a turn row without moving its count or newest time.
  load.mockResolvedValueOnce([entry("applied.md")])
  await act(async () => fire())
  await waitFor(() => expect(result.current).toEqual({ index: [entry("applied.md")] }))
  unmount()
  expect(stop).toHaveBeenCalled()
})

it("keeps the newest read's answer, and a null when the ledger cannot be asked", async () => {
  let release: (value: TaskResourceIndexEntry[] | null) => void = () => undefined
  const slow = new Promise<TaskResourceIndexEntry[] | null>((resolve) => {
    release = resolve
  })
  const load = jest
    .fn<Promise<TaskResourceIndexEntry[] | null>, []>()
    .mockReturnValueOnce(slow)
    .mockResolvedValueOnce(null)
  const { result, rerender } = renderHook(() => useWorkspaceFileIndex(true, { load }))
  revision = "1:1"
  rerender()
  await waitFor(() => expect(result.current).toEqual({ index: null }))
  // The first read answers late: it is dropped.
  await act(async () => release([entry("stale.md")]))
  expect(result.current).toEqual({ index: null })
})
