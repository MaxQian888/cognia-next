import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "tauri") }))

import { usePlatform } from "@/hooks/use-platform"
import type { SiteProjectRow } from "@/types/sites"
import { useSiteHostingManifest, type SiteHostingManifestDeps } from "./use-site-hosting-manifest"

const usePlatformMock = usePlatform as jest.Mock

const VALID = JSON.stringify({
  schemaVersion: 1,
  build: { command: ["pnpm", "build"], entry: ".cognia/worker.js", assets: "dist" },
  preview: { command: ["pnpm", "dev"], url: "http://localhost:5173" },
  cloudflare: { compatibilityDate: "2026-08-19", compatibilityFlags: [], bindings: [] },
})

function site(): SiteProjectRow {
  return {
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/repo",
    sourceSubpath: "apps/docs",
    executionTarget: { kind: "local" },
    executionTargetKey: "local",
    provider: "cloudflare",
    providerConfig: { accountId: "account", workerName: "docs" },
    authoringPolicy: { ownerAccountId: "owner", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
  }
}

function deps(overrides: Partial<SiteHostingManifestDeps> = {}): SiteHostingManifestDeps {
  return {
    read: jest.fn(async () => ({
      status: "ok" as const,
      path: "/repo/apps/docs/.cognia/hosting.json",
      text: VALID,
      manifest: JSON.parse(VALID),
    })),
    write: jest.fn(async () => "/repo/apps/docs/.cognia/hosting.json"),
    probe: jest.fn(async () => ({
      entries: ["package.json", "vite.config.ts"],
      rootEntries: ["pnpm-lock.yaml"],
      packageJson: '{"devDependencies":{"vite":"7"}}',
    })),
    today: () => "2026-08-19",
    ...overrides,
  }
}

beforeEach(() => {
  usePlatformMock.mockReturnValue("tauri")
})

it("reads the manifest on mount and reports it ready", async () => {
  const injected = deps()
  const { result } = renderHook(() => useSiteHostingManifest(site(), injected))

  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(result.current.state.status).toBe("ok")
  expect(result.current.text).toBe(VALID)
  expect(injected.read).toHaveBeenCalledWith({ sourceRoot: "/repo", sourceSubpath: "apps/docs" })
})

it("never touches the filesystem outside the desktop shell", async () => {
  usePlatformMock.mockReturnValue("web")
  const injected = deps()
  const { result } = renderHook(() => useSiteHostingManifest(site(), injected))

  await waitFor(() => expect(result.current.state.status).toBe("unsupported"))
  expect(injected.read).not.toHaveBeenCalled()
  expect(result.current.ready).toBe(false)
  expect(result.current.text).toBe("")
})

it("surfaces a missing manifest as its own state, not an error", async () => {
  const { result } = renderHook(() =>
    useSiteHostingManifest(
      site(),
      deps({
        read: jest.fn(async () => ({ status: "missing" as const, path: "/repo/x/hosting.json" })),
      })
    )
  )

  await waitFor(() => expect(result.current.state.status).toBe("missing"))
  expect(result.current.ready).toBe(false)
  expect(result.current.text).toBe("")
})

it("keeps the text of an invalid manifest so the editor can show the fix", async () => {
  const { result } = renderHook(() =>
    useSiteHostingManifest(
      site(),
      deps({
        read: jest.fn(async () => ({
          status: "invalid" as const,
          path: "/p",
          text: "{ broken",
          error: "must be valid JSON",
        })),
      })
    )
  )

  await waitFor(() => expect(result.current.state.status).toBe("invalid"))
  expect(result.current.text).toBe("{ broken")
})

it("reports a host read failure instead of throwing out of the effect", async () => {
  const { result } = renderHook(() =>
    useSiteHostingManifest(
      site(),
      deps({
        read: jest.fn(async () => {
          throw new Error("IPC is down")
        }),
      })
    )
  )

  await waitFor(() => expect(result.current.state.status).toBe("invalid"))
  expect(result.current.state).toMatchObject({ error: "IPC is down" })
})

it("scaffolds from the probed source without writing anything", async () => {
  const injected = deps()
  const { result } = renderHook(() => useSiteHostingManifest(site(), injected))
  await waitFor(() => expect(result.current.ready).toBe(true))

  let draft: Awaited<ReturnType<typeof result.current.scaffold>>
  await act(async () => {
    draft = await result.current.scaffold()
  })

  expect(draft?.kind).toBe("vite")
  expect(draft?.packageManager).toBe("pnpm")
  expect(draft?.confidence).toBe("detected")
  expect(draft?.text).toContain('"compatibilityDate": "2026-08-19"')
  expect(injected.write).not.toHaveBeenCalled()
})

it("writes the manifest with its companion files and re-reads from disk", async () => {
  const injected = deps()
  const { result } = renderHook(() => useSiteHostingManifest(site(), injected))
  await waitFor(() => expect(result.current.ready).toBe(true))
  ;(injected.read as jest.Mock).mockClear()

  await act(async () => {
    await result.current.save(VALID, [{ relativePath: ".cognia/worker.js", contents: "x" }])
  })

  expect(injected.write).toHaveBeenCalledWith(
    { sourceRoot: "/repo", sourceSubpath: "apps/docs" },
    {
      manifestText: VALID,
      extraFiles: [{ relativePath: ".cognia/worker.js", contents: "x" }],
    }
  )
  expect(injected.read).toHaveBeenCalledTimes(1)
})

it("refuses to save and to scaffold when there is no host", async () => {
  usePlatformMock.mockReturnValue("web")
  const injected = deps()
  const { result } = renderHook(() => useSiteHostingManifest(site(), injected))
  await waitFor(() => expect(result.current.state.status).toBe("unsupported"))

  await expect(result.current.save(VALID)).rejects.toThrow(/desktop host/)
  await expect(result.current.scaffold()).resolves.toBeUndefined()
  expect(injected.write).not.toHaveBeenCalled()
  expect(injected.probe).not.toHaveBeenCalled()
})

it("survives a caller that rebuilds its dependency object on every render", async () => {
  // The read effect used to key off the injected object's identity, so an
  // inline literal re-ran it forever and exhausted the heap.
  const read = jest.fn(async () => ({ status: "missing" as const, path: "/p" }))
  const { result } = renderHook(() => useSiteHostingManifest(site(), deps({ read })))

  await waitFor(() => expect(result.current.state.status).toBe("missing"))
  expect(read).toHaveBeenCalledTimes(1)
})

it("re-reads on demand", async () => {
  const injected = deps()
  const { result } = renderHook(() => useSiteHostingManifest(site(), injected))
  await waitFor(() => expect(result.current.ready).toBe(true))
  ;(injected.read as jest.Mock).mockClear()

  await act(async () => {
    await result.current.refresh()
  })
  expect(injected.read).toHaveBeenCalledTimes(1)
})

it("stays in loading until a Site is selected", async () => {
  const injected = deps()
  const { result } = renderHook(() => useSiteHostingManifest(null, injected))
  await waitFor(() => expect(result.current.state.status).toBe("loading"))
  expect(injected.read).not.toHaveBeenCalled()
})
