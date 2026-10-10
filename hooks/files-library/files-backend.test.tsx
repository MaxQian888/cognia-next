/**
 * @jest-environment jsdom
 */
import type { ReactNode } from "react"
import { renderHook } from "@testing-library/react"

const entriesHook = jest.fn((_: unknown) => ({
  entries: [{ key: "artifact:a" }],
  imagesTruncated: false,
  loadMoreImages: jest.fn(),
}))
const foldersHook = jest.fn((_: unknown) => [])
jest.mock("./use-files-entries", () => ({ useFilesEntries: (o: unknown) => entriesHook(o) }))
jest.mock("./use-files-folders", () => ({ useFilesFolders: (o: unknown) => foldersHook(o) }))

import type { FilesOps } from "@/lib/files-library/ops"
import type { FilesEntry } from "@/lib/files-library/types"
import {
  FilesBackendProvider,
  useFilesBackendContext,
  useFilesMediaLoader,
  useFilesOps,
  useLocalFilesBackend,
  type FilesBackend,
} from "./files-backend"

const remoteOps = { mode: "remote" } as FilesOps

function provide(backend: FilesBackend) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <FilesBackendProvider backend={backend}>{children}</FilesBackendProvider>
  }
}

const entry = (key: string, extra: Partial<FilesEntry> = {}) =>
  ({ key, mediaHash: "h", sessionIds: ["s1"], ...extra }) as FilesEntry

beforeEach(() => {
  entriesHook.mockClear()
  foldersHook.mockClear()
})

it("is this device's library outside a provider", () => {
  expect(renderHook(() => useFilesOps()).result.current.mode).toBe("local")
  expect(renderHook(() => useFilesBackendContext()).result.current).toBeNull()
  expect(renderHook(() => useFilesMediaLoader(entry("image:a"))).result.current).toBeUndefined()
})

it("hands the mounted backend's ops and media loader to everything below", () => {
  const loader = jest.fn()
  const mediaLoaderFor = jest.fn(() => loader)
  const backend: FilesBackend = {
    source: { entries: [], imagesTruncated: false, loadMoreImages: jest.fn(), folders: [] },
    ops: remoteOps,
    mediaLoaderFor,
  }
  const wrapper = provide(backend)
  expect(renderHook(() => useFilesOps(), { wrapper }).result.current).toBe(remoteOps)
  expect(renderHook(() => useFilesBackendContext(), { wrapper }).result.current).toBe(backend)
  const first = entry("image:a")
  const { result, rerender } = renderHook(({ e }) => useFilesMediaLoader(e), {
    wrapper,
    initialProps: { e: first },
  })
  expect(result.current).toBe(loader)
  expect(mediaLoaderFor).toHaveBeenLastCalledWith(first)
  rerender({ e: first })
  expect(mediaLoaderFor).toHaveBeenCalledTimes(1)
  const reread = entry("image:a", { mediaHash: "h2" })
  rerender({ e: reread })
  expect(mediaLoaderFor).toHaveBeenLastCalledWith(reread)
  expect(
    renderHook(() => useFilesMediaLoader(undefined), { wrapper }).result.current
  ).toBeUndefined()
})

it("reads the local library live, or not at all when told", () => {
  const { result } = renderHook(() => useLocalFilesBackend())
  expect(result.current.source.entries).toEqual([{ key: "artifact:a" }])
  expect(result.current.ops.mode).toBe("local")
  expect(result.current.source.refresh).toBeUndefined()
  expect(entriesHook).toHaveBeenLastCalledWith({ enabled: true })
  renderHook(() => useLocalFilesBackend({ enabled: false }))
  expect(entriesHook).toHaveBeenLastCalledWith({ enabled: false })
  expect(foldersHook).toHaveBeenLastCalledWith({ enabled: false })
})
