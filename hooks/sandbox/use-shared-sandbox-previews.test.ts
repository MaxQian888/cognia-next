/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { useSharedSandboxPreviews } from "./use-shared-sandbox-previews"
import {
  closeSharedPreview,
  listSharedPreviews,
  openSharedPreview,
  SharedPreviewsError,
} from "@/lib/sandbox/paired-previews"
import { openExternal } from "@/lib/tauri/opener"
import type { RemoteHostEndpoint } from "@/lib/tauri/transport-routing"

jest.mock("@/lib/sandbox/paired-previews", () => {
  class SharedPreviewsError extends Error {
    constructor(readonly status: number) {
      super(String(status))
    }
  }
  return {
    SharedPreviewsError,
    listSharedPreviews: jest.fn(),
    openSharedPreview: jest.fn(),
    closeSharedPreview: jest.fn(),
  }
})
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn() }))

const list = jest.mocked(listSharedPreviews)
const openRelay = jest.mocked(openSharedPreview)
const closeRelay = jest.mocked(closeSharedPreview)
const endpoint = { baseUrl: "https://host", deviceId: "desk" } as RemoteHostEndpoint
const preview = (id: string, projectId = "p") => ({
  id,
  projectId,
  workspaceId: "w",
  resolvedPort: 3000,
  expiresAt: Date.now() + 60_000,
  relayPath: `/api/sandbox/previews/${id}/`,
})

beforeEach(() => {
  jest.clearAllMocks()
  list.mockResolvedValue([preview("a"), preview("b", "other")])
  openRelay.mockResolvedValue({ port: 5, url: "http://127.0.0.1:5/" })
  closeRelay.mockResolvedValue(undefined)
  jest.mocked(openExternal).mockResolvedValue(undefined as never)
})

it("lists only this project's shared grants and opens one through its own relay", async () => {
  const { result } = renderHook(() => useSharedSandboxPreviews(endpoint, "p"))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.previews.map((row) => row.id)).toEqual(["a"])
  await act(() => result.current.open("a"))
  expect(openRelay).toHaveBeenCalledWith(endpoint, { id: "a" })
  expect(openExternal).toHaveBeenCalledWith("http://127.0.0.1:5/")
  expect(result.current.opened).toEqual({ a: "http://127.0.0.1:5/" })
  // A second open reuses the bound relay instead of rebinding it.
  await act(() => result.current.open("a"))
  expect(openRelay).toHaveBeenCalledTimes(1)
  await act(() => result.current.close("a"))
  expect(closeRelay).toHaveBeenCalledWith("a")
  expect(result.current.opened).toEqual({})
})

it("closes the relay of a grant that leaves the Host's list", async () => {
  const { result } = renderHook(() => useSharedSandboxPreviews(endpoint, "p"))
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(() => result.current.open("a"))
  list.mockResolvedValue([])
  await act(() => result.current.refresh())
  await waitFor(() => expect(closeRelay).toHaveBeenCalledWith("a"))
  expect(result.current.previews).toEqual([])
})

it("treats a 403 as withdrawn control and tears every relay down", async () => {
  const { result } = renderHook(() => useSharedSandboxPreviews(endpoint, "p"))
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(() => result.current.open("a"))
  list.mockRejectedValue(new SharedPreviewsError(403))
  await act(() => result.current.refresh())
  expect(result.current.error).toBe("forbidden")
  expect(result.current.previews).toEqual([])
  expect(closeRelay).toHaveBeenCalledWith("a")
})

it("reports a failed open without keeping a half-bound relay", async () => {
  openRelay.mockRejectedValueOnce(new Error("bind failed"))
  const { result } = renderHook(() => useSharedSandboxPreviews(endpoint, "p"))
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(() => result.current.open("a"))
  expect(result.current.error).toBe("open")
  expect(closeRelay).toHaveBeenCalledWith("a")
  expect(result.current.opened).toEqual({})
})

it("stops every relay it opened on unmount", async () => {
  const { result, unmount } = renderHook(() => useSharedSandboxPreviews(endpoint, "p"))
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(() => result.current.open("a"))
  unmount()
  expect(closeRelay).toHaveBeenCalledWith("a")
})
