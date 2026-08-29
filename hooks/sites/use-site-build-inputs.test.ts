/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { useSiteBuildInputs } from "./use-site-build-inputs"
import type { SiteVersionRow } from "@/types/sites"

function version(runtime: string): SiteVersionRow {
  return {
    id: `v-${runtime}`,
    siteId: "s1",
    sequence: 1,
    status: "ready",
    environmentRevisionId: "env_1",
    source: { commitSha: "abc", dirty: false, lockfileDigest: "l", inputDigest: "i" },
    build: {
      command: "[]",
      runtime,
      packageManager: "pnpm@10",
      compatibilityDate: "2026-01-01",
      compatibilityFlags: [],
      routes: [],
      bindings: [],
    },
    createdAt: 1,
  }
}

it("seeds from the Site's own build history", () => {
  const { result } = renderHook(() => useSiteBuildInputs("s1", [version("node@20")]))
  expect(result.current.inputs.runtime).toBe("node@20")
  expect(result.current.source).toBe("last-version")
})

it("keeps an edit for the Site it was made on", () => {
  const { result } = renderHook(() => useSiteBuildInputs("s1", []))
  act(() => result.current.setInputs({ runtime: "node@22" }))
  expect(result.current.inputs.runtime).toBe("node@22")
})

it("re-seeds when the Site changes rather than carrying edits across", () => {
  // The literals in the publish tab did not reset on selection change, so
  // Site A's runtime and network allowances were used for Site B's build.
  const { result, rerender } = renderHook(
    ({ siteId, versions }: { siteId: string; versions: SiteVersionRow[] }) =>
      useSiteBuildInputs(siteId, versions),
    { initialProps: { siteId: "s1", versions: [] as SiteVersionRow[] } }
  )
  act(() => result.current.setInputs({ runtime: "node@22", buildNetworkHosts: ["leak.example"] }))
  expect(result.current.inputs.runtime).toBe("node@22")

  rerender({ siteId: "s2", versions: [version("node@20")] })
  expect(result.current.inputs.runtime).toBe("node@20")
  expect(result.current.inputs.buildNetworkHosts).toEqual([])
})

it("merges successive edits instead of replacing them", () => {
  const { result } = renderHook(() => useSiteBuildInputs("s1", []))
  act(() => result.current.setInputs({ runtime: "node@22" }))
  act(() => result.current.setInputs({ packageManager: "bun@1" }))
  expect(result.current.inputs).toMatchObject({ runtime: "node@22", packageManager: "bun@1" })
})
