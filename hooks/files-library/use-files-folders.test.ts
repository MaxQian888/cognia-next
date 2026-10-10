/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

const liveQuery = jest.fn()
jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: (query: () => unknown, deps: unknown[], initial: unknown) =>
    liveQuery(query, deps, initial),
}))
jest.mock("@/lib/db/files-library-folders", () => ({ listLibraryFolders: jest.fn(async () => []) }))

import { listLibraryFolders } from "@/lib/db/files-library-folders"
import { useFilesFolders } from "./use-files-folders"

it("returns the live folder list, empty until it resolves", async () => {
  liveQuery.mockReturnValueOnce(undefined)
  const { result, rerender } = renderHook(() => useFilesFolders())
  expect(result.current).toEqual([])
  const folders = [{ id: "lbf_a", name: "A", parentFolderId: "root", createdAt: 1, updatedAt: 1 }]
  liveQuery.mockReturnValue(folders)
  rerender()
  expect(result.current).toBe(folders)
  await liveQuery.mock.calls[0]![0]()
  expect(listLibraryFolders).toHaveBeenCalled()
})

it("reads no folders while disabled", async () => {
  ;(listLibraryFolders as jest.Mock).mockClear()
  liveQuery.mockReturnValue(undefined)
  renderHook(() => useFilesFolders({ enabled: false }))
  expect(await liveQuery.mock.calls.at(-1)![0]()).toEqual([])
  expect(liveQuery.mock.calls.at(-1)![1]).toEqual([false])
  expect(listLibraryFolders).not.toHaveBeenCalled()
})
