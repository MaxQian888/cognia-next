/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const liveQuery = jest.fn()
jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: (query: () => unknown, deps: unknown[]) => liveQuery(query, deps),
}))
jest.mock("@/lib/files-library/sources", () => ({
  FILES_IMAGE_PAGE_SIZE: 500,
  loadFilesSources: jest.fn(async () => ({ input: {}, imagesTruncated: false })),
}))
jest.mock("@/lib/files-library/aggregate", () => ({
  aggregateFilesEntries: jest.fn(() => [{ key: "artifact:a" }]),
}))

import { aggregateFilesEntries } from "@/lib/files-library/aggregate"
import { loadFilesSources } from "@/lib/files-library/sources"
import { useFilesEntries } from "./use-files-entries"

beforeEach(() => liveQuery.mockReset())

it("is undefined until the sources load, then aggregates them", () => {
  liveQuery.mockReturnValue(undefined)
  const { result, rerender } = renderHook(() => useFilesEntries())
  expect(result.current.entries).toBeUndefined()
  expect(result.current.imagesTruncated).toBe(false)
  liveQuery.mockReturnValue({ input: { artifacts: [] }, imagesTruncated: true })
  rerender()
  expect(result.current.entries).toEqual([{ key: "artifact:a" }])
  expect(result.current.imagesTruncated).toBe(true)
  expect(aggregateFilesEntries).toHaveBeenCalledWith({ artifacts: [] })
})

it("widens the image window on demand", async () => {
  liveQuery.mockReturnValue(undefined)
  const { result } = renderHook(() => useFilesEntries())
  // deps: [enabled, artifacts, canvasDocuments, imageLimit]
  expect(liveQuery.mock.calls.at(-1)![1][3]).toBe(500)
  act(() => result.current.loadMoreImages())
  expect(liveQuery.mock.calls.at(-1)![1][3]).toBe(1000)
  await liveQuery.mock.calls.at(-1)![0]()
  expect(loadFilesSources).toHaveBeenCalledWith(expect.objectContaining({ imageLimit: 1000 }))
})

it("reads nothing while disabled, for a page drawing another device's library", async () => {
  liveQuery.mockReturnValue(undefined)
  ;(loadFilesSources as jest.Mock).mockClear()
  const { result } = renderHook(() => useFilesEntries({ enabled: false }))
  expect(await liveQuery.mock.calls.at(-1)![0]()).toBeUndefined()
  expect(loadFilesSources).not.toHaveBeenCalled()
  expect(result.current.entries).toBeUndefined()
})
