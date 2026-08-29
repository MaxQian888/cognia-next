import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/sites/wrangler-detect", () => ({
  detectWranglerBinary: jest.fn(async () => ({
    path: "/usr/bin/wrangler",
    version: "3.90.0",
    ready: true,
  })),
  ensureWranglerApproved: jest.fn(async () => ({
    path: "/usr/bin/wrangler",
    version: "3.90.0",
    ready: true,
  })),
  redetectWranglerBinary: jest.fn(async () => ({
    path: "/usr/bin/wrangler",
    version: "4.0.0",
    ready: true,
  })),
}))
const uploadSiteVersion = jest.fn(async () => "cf-version-1")
jest.mock("@/lib/sites/publish-version", () => ({
  uploadSiteVersion: (...args: unknown[]) => uploadSiteVersion(...args),
}))
jest.mock("@/lib/sites/build-version", () => ({
  buildAndSaveSiteVersion: jest.fn(async () => ({})),
}))
jest.mock("@/lib/sites/preview", () => ({
  startSitePreview: jest.fn(async () => ({
    siteId: "site_1",
    terminalSessionId: "t1",
    url: "http://localhost:5173",
  })),
  stopSitePreview: jest.fn(async () => undefined),
}))
jest.mock("@/lib/sites/artifact-package", () => ({
  materializeSiteArtifact: jest.fn(async () => ({
    entryPath: "/e",
    assetsPath: "/a",
    fileCount: 1,
  })),
}))
jest.mock("@/lib/file/file-operations", () => ({ createDir: jest.fn(async () => undefined) }))
jest.mock("@/lib/db/sites", () => ({
  cancelSiteOperation: jest.fn(async () => ({ id: "op1", status: "cancelled" })),
  getSiteArtifact: jest.fn(async () => ({ bytes: new Uint8Array([1]) })),
  getSiteOperation: jest.fn(async () => ({ id: "op1" })),
}))

import { cancelSiteOperation } from "@/lib/db/sites"
import { buildAndSaveSiteVersion } from "@/lib/sites/build-version"
import { startSitePreview, stopSitePreview } from "@/lib/sites/preview"
import { detectWranglerBinary, ensureWranglerApproved } from "@/lib/sites/wrangler-detect"
import type { SiteEnvironmentRevisionRow, SiteProjectRow, SiteVersionRow } from "@/types/sites"
import type { SiteLiveData } from "./use-site-live-data"
import { useSitePublishActions } from "./use-site-publish-actions"

function site(overrides: Partial<SiteProjectRow> = {}): SiteProjectRow {
  return {
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/repo",
    sourceSubpath: "apps/docs",
    executionTarget: { kind: "local" },
    executionTargetKey: "local",
    provider: "cloudflare",
    providerConfig: { accountId: "a", workerName: "docs" },
    authoringPolicy: { ownerAccountId: "owner", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const environment: SiteEnvironmentRevisionRow = {
  id: "env_1",
  siteId: "site_1",
  sequence: 1,
  variables: {},
  secretRefs: [],
  createdAt: 1,
}

function liveData(overrides: Partial<SiteLiveData> = {}): SiteLiveData {
  return {
    sites: [site()],
    selectedId: "site_1",
    activeDeployments: [],
    operationSignals: [],
    versions: [],
    deployments: [],
    environments: [environment],
    resources: [],
    operations: [],
    events: [],
    loading: false,
    ...overrides,
  }
}

function setup(overrides: Record<string, unknown> = {}) {
  const service = {
    saveProviderToken: jest.fn(async () => undefined),
    saveEnvironment: jest.fn(async () => undefined),
    provisionBindings: jest.fn(async () => undefined),
    uploadVersion: jest.fn(async () => undefined),
    deployVersion: jest.fn(async () => undefined),
    addDomain: jest.fn(async () => undefined),
    removeDomain: jest.fn(async () => undefined),
    reconcileVisitorAccess: jest.fn(async () => undefined),
    takeDown: jest.fn(async () => undefined),
    restore: jest.fn(async () => undefined),
    reconcile: jest.fn(async () => ({ resolved: 1, remaining: 0 })),
    recoverInterruptedOperations: jest.fn(async () => 0),
  }
  const run = jest.fn(async (_key: string, action: () => Promise<unknown>) => {
    try {
      return await action()
    } catch {
      return undefined
    }
  })
  const manifest = {
    state: {
      status: "ok" as const,
      path: "/p",
      text: "{}",
      manifest: { cloudflare: { bindings: [] } } as never,
    },
    ready: true,
    text: "{}",
    refresh: jest.fn(async () => undefined),
    scaffold: jest.fn(async () => undefined),
    save: jest.fn(async () => undefined),
  }
  const preview = { url: null as string | null, resolved: true, adopt: jest.fn() }
  const rendered = renderHook(() =>
    useSitePublishActions({
      site: site(),
      actorAccountId: "owner",
      manifest,
      preview,
      live: liveData(),
      run: run as never,
      service: (() => service) as never,
      loadProjects: jest.fn(),
      ...overrides,
    })
  )
  return { ...rendered, service, run, manifest, preview }
}

beforeEach(() => {
  jest.clearAllMocks()
})

it("probes for wrangler without hashing it", async () => {
  // `ensureWranglerApproved` SHA-256s a multi-megabyte binary to record it in
  // the tool ledger. Mounting the console is not a reason to pay that.
  const { result } = setup()
  await waitFor(() => expect(result.current.wrangler?.ready).toBe(true))
  expect(detectWranglerBinary).toHaveBeenCalled()
  expect(ensureWranglerApproved).not.toHaveBeenCalled()
})

it("falls back to not-found when detection rejects", async () => {
  ;(detectWranglerBinary as jest.Mock).mockRejectedValueOnce(new Error("no ipc"))
  const { result } = setup()
  await waitFor(() =>
    expect(result.current.wrangler).toEqual({
      path: null,
      version: null,
      ready: false,
    })
  )
})

it("no longer sweeps for interrupted operations on mount", async () => {
  // It swept the selected Site only, and only for its owner, so a crash
  // mid-upload stayed wedged until somebody opened /sites and clicked that
  // exact Site. `lib/sites/boot.ts` sweeps every owned Site at startup instead.
  const { service } = setup()
  await waitFor(() => expect(detectWranglerBinary).toHaveBeenCalled())
  expect(service.recoverInterruptedOperations).not.toHaveBeenCalled()
})

it("derives the step states from the manifest, environment, and versions", async () => {
  const { result } = setup()
  await waitFor(() => expect(result.current.wrangler).not.toBeNull())
  expect(result.current.stepStates.manifest).toBe("done")
  expect(result.current.stepStates.environment).toBe("done")
  expect(result.current.stepStates.build).toBe("idle")
})

it("reports the manifest step idle when there is no manifest", async () => {
  const manifest = {
    state: { status: "missing" as const, path: "/p" },
    ready: false,
    text: "",
    refresh: jest.fn(),
    scaffold: jest.fn(),
    save: jest.fn(),
  }
  const { result } = setup({ manifest })
  await waitFor(() => expect(result.current.wrangler).not.toBeNull())
  expect(result.current.stepStates.manifest).toBe("idle")
})

it("saves the provider token, environment, and manifest through the runner", async () => {
  const { result, service, manifest } = setup()
  await act(async () => {
    result.current.saveToken("cf-token")
    result.current.saveEnvironment({ variables: { A: "1" }, secrets: {} })
    result.current.saveManifest("{}")
  })
  expect(service.saveProviderToken).toHaveBeenCalledWith("site_1", "cf-token")
  expect(service.saveEnvironment).toHaveBeenCalledWith({
    siteId: "site_1",
    variables: { A: "1" },
    secrets: {},
  })
  expect(manifest.save).toHaveBeenCalledWith("{}", undefined)
})

it("provisions from the manifest already in hand instead of re-reading the file", async () => {
  const { result, service } = setup()
  await act(async () => {
    result.current.provision()
  })
  expect(service.provisionBindings).toHaveBeenCalledWith("site_1", [])
})

it("refuses to provision when the manifest is unavailable", async () => {
  const manifest = {
    state: { status: "missing" as const, path: "/p" },
    ready: false,
    text: "",
    refresh: jest.fn(),
    scaffold: jest.fn(),
    save: jest.fn(),
  }
  const { result, service } = setup({ manifest })
  await act(async () => {
    result.current.provision()
  })
  expect(service.provisionBindings).not.toHaveBeenCalled()
})

it("builds against the newest environment revision", async () => {
  const { result } = setup()
  await act(async () => {
    result.current.build({
      runtime: "node@24",
      packageManager: "pnpm@10",
      installNetworkHosts: ["registry.npmjs.org"],
      buildNetworkHosts: [],
    })
  })
  expect(buildAndSaveSiteVersion).toHaveBeenCalledWith({
    siteId: "site_1",
    environmentRevisionId: "env_1",
    runtime: "node@24",
    packageManager: "pnpm@10",
    installNetworkHosts: ["registry.npmjs.org"],
    buildNetworkHosts: [],
    actorAccountId: "owner",
  })
})

it("refuses to build or preview without an environment revision", async () => {
  const { result } = setup({ live: liveData({ environments: [] }) })
  await act(async () => {
    result.current.build({
      runtime: "r",
      packageManager: "p",
      installNetworkHosts: [],
      buildNetworkHosts: [],
    })
    result.current.startPreview()
  })
  expect(buildAndSaveSiteVersion).not.toHaveBeenCalled()
  expect(startSitePreview).not.toHaveBeenCalled()
})

it("adopts the preview URL on start and clears it on stop", async () => {
  const { result, preview } = setup()
  await act(async () => {
    result.current.startPreview()
  })
  expect(preview.adopt).toHaveBeenCalledWith("http://localhost:5173")

  await act(async () => {
    result.current.stopPreview()
  })
  expect(stopSitePreview).toHaveBeenCalledWith("site_1")
  expect(preview.adopt).toHaveBeenLastCalledWith(null)
})

it("hands upload the approval callback, so the ledger hash happens there", async () => {
  const { result } = setup()
  await waitFor(() => expect(result.current.wrangler).not.toBeNull())
  await act(async () => {
    result.current.upload({ id: "v1", artifactDigest: "abc" } as SiteVersionRow)
  })
  expect(uploadSiteVersion).toHaveBeenCalledWith(
    { siteId: "site_1", versionId: "v1", actorAccountId: "owner" },
    expect.objectContaining({ ensureWrangler: expect.any(Function) })
  )
})

it("deploys, takes down, restores, and reconciles through the service", async () => {
  const onResult = jest.fn()
  const { result, service } = setup()
  await act(async () => {
    result.current.deploy({ id: "v1" } as SiteVersionRow)
    result.current.takeDown()
    result.current.restore()
    result.current.reconcile(onResult)
  })
  expect(service.deployVersion).toHaveBeenCalledWith("site_1", "v1")
  expect(service.takeDown).toHaveBeenCalledWith("site_1")
  expect(service.restore).toHaveBeenCalledWith("site_1")
  expect(onResult).toHaveBeenCalledWith({ resolved: 1, remaining: 0 })
})

it("manages domains and the visitor policy", async () => {
  const { result, service } = setup()
  await act(async () => {
    result.current.addDomain("docs.example.com")
    result.current.removeDomain("res_1")
    result.current.applyAccess({ mode: "public" }, "docs.example.com")
  })
  expect(service.addDomain).toHaveBeenCalledWith("site_1", "docs.example.com")
  expect(service.removeDomain).toHaveBeenCalledWith("site_1", "res_1")
  expect(service.reconcileVisitorAccess).toHaveBeenCalledWith(
    "site_1",
    { mode: "public" },
    "docs.example.com"
  )
})

it("re-checks a single operation silently", async () => {
  const { result, run } = setup()
  await act(async () => {
    result.current.refreshOperation("op1")
  })
  expect(run).toHaveBeenCalledWith("operation:op1", expect.any(Function), {
    successMessage: null,
  })
})

it("exposes only the versions that are ready to publish", async () => {
  const { result } = setup({
    live: liveData({
      versions: [
        { id: "v1", status: "ready" } as SiteVersionRow,
        { id: "v2", status: "failed" } as SiteVersionRow,
      ],
    }),
  })
  await waitFor(() => expect(result.current.wrangler).not.toBeNull())
  expect(result.current.readyVersions.map((version) => version.id)).toEqual(["v1"])
})

it("abandons a wedged operation", async () => {
  const { result } = setup()
  await act(async () => {
    result.current.cancelOperation("op1")
  })
  expect(cancelSiteOperation).toHaveBeenCalledWith({ operationId: "op1" })
})
