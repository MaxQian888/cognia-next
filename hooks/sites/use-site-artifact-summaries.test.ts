import { renderHook, waitFor } from "@testing-library/react"

import type { SiteArtifactRow, SiteVersionRow } from "@/types/sites"
import { useSiteArtifactSummaries } from "./use-site-artifact-summaries"

function version(id: string, artifactDigest?: string): SiteVersionRow {
  return {
    id,
    siteId: "site_1",
    sequence: 1,
    status: "ready",
    environmentRevisionId: "env_1",
    source: { commitSha: "abc", dirty: false, lockfileDigest: "l", inputDigest: "i" },
    build: {
      command: "[]",
      runtime: "node@24",
      packageManager: "pnpm@10",
      compatibilityDate: "2026-08-19",
      compatibilityFlags: [],
      routes: [],
      bindings: [],
    },
    createdAt: 1,
    ...(artifactDigest ? { artifactDigest } : {}),
  }
}

function artifact(digest: string, size: number, fileCount: number): SiteArtifactRow {
  return {
    digest,
    bytes: new Uint8Array([1]),
    mediaType: "application/zip",
    size,
    fileCount,
    createdAt: 1,
  }
}

it("loads a summary for every version that has an artifact", async () => {
  const read = jest.fn(async (digest: string) => artifact(digest, 1024, 7))
  const { result } = renderHook(() =>
    useSiteArtifactSummaries([version("v1", "abc"), version("v2", "def")], true, { read })
  )

  await waitFor(() => expect(result.current.size).toBe(2))
  expect(result.current.get("abc")).toEqual({ size: 1024, fileCount: 7 })
  expect(read).toHaveBeenCalledTimes(2)
})

it("reads nothing while the caller does not need the numbers", async () => {
  const read = jest.fn(async (digest: string) => artifact(digest, 1, 1))
  const { result } = renderHook(() =>
    useSiteArtifactSummaries([version("v1", "abc")], false, { read })
  )

  await waitFor(() => expect(result.current.size).toBe(0))
  expect(read).not.toHaveBeenCalled()
})

it("skips versions that never produced an artifact", async () => {
  const read = jest.fn(async (digest: string) => artifact(digest, 1, 1))
  renderHook(() => useSiteArtifactSummaries([version("v1")], true, { read }))
  await waitFor(() => expect(read).not.toHaveBeenCalled())
})

it("reads each digest exactly once, across re-renders and repeats", async () => {
  const read = jest.fn(async (digest: string) => artifact(digest, 1, 1))
  const { result, rerender } = renderHook(() =>
    useSiteArtifactSummaries([version("v1", "abc"), version("v2", "abc")], true, { read })
  )
  await waitFor(() => expect(result.current.size).toBe(1))
  rerender()
  rerender()
  expect(read).toHaveBeenCalledTimes(1)
})

it("loads a newly built version without re-reading the old ones", async () => {
  const read = jest.fn(async (digest: string) => artifact(digest, 1, 1))
  const { result, rerender } = renderHook(
    ({ versions }: { versions: SiteVersionRow[] }) =>
      useSiteArtifactSummaries(versions, true, { read }),
    { initialProps: { versions: [version("v1", "abc")] } }
  )
  await waitFor(() => expect(result.current.size).toBe(1))

  rerender({ versions: [version("v2", "def"), version("v1", "abc")] })
  await waitFor(() => expect(result.current.size).toBe(2))
  expect(read).toHaveBeenCalledTimes(2)
})

it("does not retry a digest whose artifact is gone", async () => {
  const read = jest.fn(async () => undefined)
  const { rerender } = renderHook(() =>
    useSiteArtifactSummaries([version("v1", "abc")], true, { read })
  )
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  rerender()
  rerender()
  expect(read).toHaveBeenCalledTimes(1)
})

it("survives a read that throws", async () => {
  const read = jest.fn(async (digest: string) => {
    if (digest === "bad") throw new Error("corrupt")
    return artifact(digest, 5, 5)
  })
  const { result } = renderHook(() =>
    useSiteArtifactSummaries([version("v1", "bad"), version("v2", "good")], true, { read })
  )
  await waitFor(() => expect(result.current.get("good")).toEqual({ size: 5, fileCount: 5 }))
  expect(result.current.has("bad")).toBe(false)
})
