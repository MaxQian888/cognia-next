/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/files-library/remote/live-transport", () => ({
  liveFilesRemoteClient: jest.fn(() => {
    throw new Error("tests inject a client")
  }),
}))

import type { FilesRemoteClient } from "@/lib/files-library/remote/client"
import { FilesRemoteError } from "@/lib/files-library/remote/client"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FILES_REMOTE_SEARCH_DEBOUNCE_MS, useRemoteFilesBackend } from "./use-remote-files-backend"

const entry = (key: string) => ({ key, kind: "artifact", sessionIds: [] }) as unknown as FilesEntry

function client(over: Partial<FilesRemoteClient> = {}): jest.Mocked<FilesRemoteClient> {
  return {
    list: jest.fn(async () => ({ entries: [entry("artifact:a")], imagesTruncated: true })),
    folders: jest.fn(async () => [
      { id: "lbf_1", name: "F", parentFolderId: "root", createdAt: 1, updatedAt: 1 },
    ]),
    search: jest.fn(async () => [
      { key: "artifact:b", kind: "artifact" as const, title: "b", updatedAt: 1, projectIds: [] },
    ]),
    trash: jest.fn(async () => undefined),
    readMedia: jest.fn(),
    ...over,
  } as unknown as jest.Mocked<FilesRemoteClient>
}

beforeEach(() => {
  useFilesLibraryStore.setState({ search: "" })
})

afterEach(() => {
  jest.useRealTimers()
})

it("reads the host's list and folders on mount", async () => {
  const c = client()
  const { result } = renderHook(() => useRemoteFilesBackend({ client: c }))
  expect(result.current.source.entries).toBeUndefined()
  await waitFor(() => expect(result.current.source.entries).toHaveLength(1))
  expect(result.current.source.imagesTruncated).toBe(true)
  expect(result.current.source.folders.map((f) => f.id)).toEqual(["lbf_1"])
  expect(result.current.ops.mode).toBe("remote")
  expect(typeof result.current.source.refresh).toBe("function")
})

it("keeps what it showed and reports the code when a read fails, then recovers", async () => {
  const c = client()
  const { result } = renderHook(() => useRemoteFilesBackend({ client: c }))
  await waitFor(() => expect(result.current.source.entries).toHaveLength(1))
  c.list.mockRejectedValueOnce(new FilesRemoteError("files_remote_busy"))
  await act(() => result.current.source.refresh!())
  expect(result.current.source.error).toBe("files_remote_busy")
  expect(result.current.source.entries).toHaveLength(1)
  c.list.mockRejectedValueOnce(new Error("socket closed"))
  await act(() => result.current.source.refresh!())
  expect(result.current.source.error).toBe("files_remote_unreachable")
  await act(() => result.current.source.refresh!())
  expect(result.current.source.error).toBeUndefined()
})

it("drops an answer that lost the race to a newer read", async () => {
  let resolveSlow!: (value: { entries: FilesEntry[]; imagesTruncated: boolean }) => void
  const c = client()
  const { result } = renderHook(() => useRemoteFilesBackend({ client: c }))
  await waitFor(() => expect(result.current.source.entries).toHaveLength(1))
  c.list
    .mockImplementationOnce(() => new Promise((resolve) => (resolveSlow = resolve)))
    .mockResolvedValueOnce({ entries: [entry("artifact:new")], imagesTruncated: false })
  let slow!: Promise<void>
  act(() => {
    slow = result.current.source.refresh!()
  })
  await act(() => result.current.source.refresh!())
  await act(async () => {
    resolveSlow({ entries: [entry("artifact:stale")], imagesTruncated: false })
    await slow
  })
  expect(result.current.source.entries!.map((e) => e.key)).toEqual(["artifact:new"])
})

it("re-reads after its own change, when the page comes back, and on a timer", async () => {
  jest.useFakeTimers()
  const c = client()
  const { result } = renderHook(() => useRemoteFilesBackend({ client: c, refreshMs: 1000 }))
  await act(async () => {})
  const before = c.list.mock.calls.length
  await act(() => result.current.ops.trash([entry("artifact:a")]))
  expect(c.list.mock.calls.length).toBe(before + 1)
  await act(async () => {
    window.dispatchEvent(new Event("focus"))
  })
  expect(c.list.mock.calls.length).toBe(before + 2)
  await act(async () => {
    jest.advanceTimersByTime(1000)
  })
  expect(c.list.mock.calls.length).toBe(before + 3)
})

it("widens the image window and asks the host for the same entries", async () => {
  const c = client()
  const { result } = renderHook(() => useRemoteFilesBackend({ client: c }))
  await waitFor(() => expect(c.list).toHaveBeenCalled())
  const first = c.list.mock.calls[0]![0]
  act(() => result.current.source.loadMoreImages())
  await waitFor(() => expect(c.list.mock.calls.at(-1)![0]).toBeGreaterThan(first))
})

it("asks the host which items match inside their bodies, after a pause", async () => {
  jest.useFakeTimers()
  const c = client()
  const { result } = renderHook(() => useRemoteFilesBackend({ client: c }))
  act(() => useFilesLibraryStore.setState({ search: "revenue" }))
  expect(c.search).not.toHaveBeenCalled()
  await act(async () => {
    jest.advanceTimersByTime(FILES_REMOTE_SEARCH_DEBOUNCE_MS)
  })
  expect(c.search).toHaveBeenCalledWith("revenue", expect.any(Number), 200)
  expect([...result.current.source.contentMatches!]).toEqual(["artifact:b"])
  // A new query drops the old matches at once.
  act(() => useFilesLibraryStore.setState({ search: "other" }))
  expect(result.current.source.contentMatches).toBeUndefined()
})

it("hands each entry a loader for its bytes on the host", async () => {
  const c = client()
  const { result } = renderHook(() => useRemoteFilesBackend({ client: c }))
  expect(typeof result.current.mediaLoaderFor!(entry("image:x"))).toBe("function")
})
