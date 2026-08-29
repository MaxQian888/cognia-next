import { createSiteVersionDraft, putSiteArtifact } from "@/lib/db/sites"
import type { GitStatus } from "@/types/git"
import type { SiteEnvironmentRevisionRow, SiteProjectRow } from "@/types/sites"
import { buildAndSaveSiteVersion, collectSiteBuildOutput } from "./build-version"

const cleanStatus: GitStatus = {
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  staged: [],
  changes: [],
  merge: [],
  isRebasing: false,
  isMerging: false,
}

const manifest = JSON.stringify({
  schemaVersion: 1,
  build: {
    install: ["pnpm", "install", "--frozen-lockfile"],
    command: ["pnpm", "build"],
    entry: "dist/worker.js",
    assets: "dist/assets",
  },
  preview: { command: ["pnpm", "dev"], url: "http://localhost:3000" },
  cloudflare: {
    compatibilityDate: "2026-07-18",
    compatibilityFlags: ["nodejs_compat"],
    bindings: [],
  },
})

const site: SiteProjectRow = {
  id: "site_1",
  name: "Docs",
  projectId: "project_1",
  sourceRoot: "/repo",
  sourceSubpath: "apps/docs",
  executionTarget: { kind: "local" },
  provider: "cloudflare",
  providerConfig: { accountId: "account", workerName: "docs" },
  authoringPolicy: {
    ownerAccountId: "local-user",
    editorAccountIds: [] as string[],
    deployerAccountIds: [] as string[],
  },
  visitorPolicy: { mode: "private" },
  lifecycle: "active",
  executionTargetKey: "local",
  createdAt: 1,
  updatedAt: 1,
}

const environment: SiteEnvironmentRevisionRow = {
  id: "env_1",
  siteId: "site_1",
  sequence: 1,
  variables: { PUBLIC_ORIGIN: "https://example.com" },
  secretRefs: [],
  createdAt: 2,
}

function dependencies(
  runBuild = jest.fn(async () => ({
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    durationSeconds: 1,
    timedOut: false,
    outputTruncated: false,
  }))
) {
  let id = 0
  const bytes: Record<string, Uint8Array> = {
    "/repo/pnpm-lock.yaml": new TextEncoder().encode("lockfile"),
    "/repo/apps/docs/dist/worker.js": new TextEncoder().encode("export default {}"),
    "/repo/apps/docs/dist/assets/index.html": new TextEncoder().encode("<h1>Docs</h1>"),
  }
  const createDraft = jest.fn(async (input: Parameters<typeof createSiteVersionDraft>[0]) => ({
    ...input,
    sequence: 1,
    status: "building" as const,
    createdAt: input.now ?? 100,
  }))
  const putArtifact = jest.fn(async (input: Parameters<typeof putSiteArtifact>[0]) => ({
    ...input,
    digest: input.digest,
    size: input.bytes.byteLength,
    createdAt: input.now ?? 100,
  }))
  const completeVersion = jest.fn(
    async (input: { versionId: string; artifactDigest: string; now?: number }) => ({
      ...(await createDraft.mock.results[0].value),
      status: "ready" as const,
      artifactDigest: input.artifactDigest,
      completedAt: input.now,
    })
  )
  return {
    now: () => 100 + id,
    newId: (prefix: string) => `${prefix}_${++id}`,
    leaseOwner: "window-1",
    join: async (...parts: string[]) => parts.join("/").replaceAll("//", "/"),
    readText: async () => manifest,
    readBytes: async (path: string) => bytes[path] ?? new Uint8Array(),
    pathExists: async (path: string) => path === "/repo/pnpm-lock.yaml",
    readDir: async (path: string) =>
      path.endsWith("dist/assets")
        ? [{ name: "index.html", isFile: true, isDirectory: false, isSymlink: false }]
        : [],
    gitSnapshot: async () => ({
      commit: {
        hash: "abc123",
        shortHash: "abc123",
        summary: "build",
        body: "",
        authorName: "Cognia",
        authorEmail: "dev@example.com",
        authoredAtMs: 1,
        parents: [],
      },
      status: cleanStatus,
    }),
    runBuild,
    getSite: jest.fn(async () => site),
    getEnvironment: jest.fn(async () => environment),
    createDraft,
    queueOperation: jest.fn(async (input) => ({
      ...input,
      status: "queued" as const,
      attemptCount: 0,
      createdAt: input.now ?? 100,
      updatedAt: input.now ?? 100,
    })),
    claimOperation: jest.fn(async () => ({ id: "siteop_2" }) as never),
    putArtifact,
    completeVersion,
    completeOperation: jest.fn(async () => ({ id: "siteop_2" }) as never),
    failVersion: jest.fn(async () => ({ id: "siteversion_1" }) as never),
    failOperation: jest.fn(async () => ({ id: "siteop_2" }) as never),
    appendPhaseEvent: jest.fn(async () => undefined as never),
    putBuildLog: jest.fn(async () => ({}) as never),
  }
}

it("runs install/build in confinement and saves a self-contained immutable version", async () => {
  const deps = dependencies()
  const version = await buildAndSaveSiteVersion(
    {
      siteId: "site_1",
      environmentRevisionId: "env_1",
      runtime: "node@24",
      packageManager: "pnpm@10",
      installNetworkHosts: ["registry.npmjs.org"],
    },
    deps
  )

  expect(version).toMatchObject({ status: "ready", source: { commitSha: "abc123", dirty: false } })
  expect(version.artifactDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(deps.putArtifact).toHaveBeenCalledWith(
    expect.objectContaining({
      mediaType: "application/zip",
      fileCount: 2,
    })
  )
  expect(deps.runBuild).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      argv: ["pnpm", "install", "--frozen-lockfile"],
      networkHosts: ["registry.npmjs.org"],
    })
  )
  expect(deps.runBuild).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ argv: ["pnpm", "build"], networkHosts: undefined })
  )
})

it("marks both the draft and operation failed when the confined build fails", async () => {
  const runBuild = jest
    .fn()
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: "installed",
      stderr: "",
      durationSeconds: 1,
      timedOut: false,
      outputTruncated: false,
    })
    .mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "compile failed",
      durationSeconds: 1,
      timedOut: false,
      outputTruncated: false,
    })

  const deps = dependencies(runBuild)
  await expect(
    buildAndSaveSiteVersion(
      {
        siteId: "site_1",
        environmentRevisionId: "env_1",
        runtime: "node@24",
        packageManager: "pnpm@10",
      },
      deps
    )
  ).rejects.toThrow("compile failed")

  expect(deps.failVersion).toHaveBeenCalledWith(
    "siteversion_1",
    "compile failed",
    expect.any(Number)
  )
  expect(deps.failOperation).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: "siteop_2", message: "compile failed" })
  )
})

it("refuses symlinks in recursively collected build assets", async () => {
  await expect(
    collectSiteBuildOutput(
      { sourceDir: "/repo", entry: "worker.js", assets: "assets" },
      {
        join: async (...parts) => parts.join("/"),
        readBytes: async () => new Uint8Array([1]),
        readDir: async () => [
          { name: "escape", isFile: false, isDirectory: false, isSymlink: true },
        ],
      }
    )
  ).rejects.toThrow("symlinks")
})

const INPUT = {
  siteId: "site_1",
  environmentRevisionId: "env_1",
  runtime: "node@24",
  packageManager: "pnpm@10",
  installNetworkHosts: ["registry.npmjs.org"],
}

it("announces every phase and stores what each one printed", async () => {
  // A multi-minute build used to show a spinner and nothing else:
  // `appendOperationEvent` fired only on lifecycle transitions, and the whole
  // stdout/stderr of a successful build was discarded.
  const deps = dependencies()
  await buildAndSaveSiteVersion(INPUT, deps)

  const phases = (deps.appendPhaseEvent as jest.Mock).mock.calls.map(
    ([call]) => `${call.phase}:${call.outcome}`
  )
  expect(phases).toEqual([
    "install:started",
    "install:succeeded",
    "build:started",
    "build:succeeded",
    "package:started",
    "package:succeeded",
  ])

  const logged = (deps.putBuildLog as jest.Mock).mock.calls.map(([row]) => row.phase)
  // `package` spawns no process, so it produces events but no log row.
  expect(logged).toEqual(["install", "build"])
  expect((deps.putBuildLog as jest.Mock).mock.calls[0][0]).toMatchObject({
    versionId: "siteversion_1",
    siteId: "site_1",
    exitCode: 0,
  })
})

it("stores the failing phase's output before it throws", async () => {
  // The output is the only thing that explains a broken build, and it used to
  // be reduced to a single Error message.
  const deps = dependencies()
  deps.runBuild = jest.fn(async () => ({
    exitCode: 1,
    stdout: "compiling…",
    stderr: "TS2304: Cannot find name 'foo'",
    durationSeconds: 3,
    timedOut: false,
    outputTruncated: false,
  })) as never

  await expect(buildAndSaveSiteVersion(INPUT, deps)).rejects.toThrow(/TS2304/)

  const rows = (deps.putBuildLog as jest.Mock).mock.calls.map(([row]) => row)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ phase: "install", exitCode: 1 })
  expect(rows[0].stderr).toContain("TS2304")

  const phases = (deps.appendPhaseEvent as jest.Mock).mock.calls.map(
    ([call]) => `${call.phase}:${call.outcome}`
  )
  expect(phases).toEqual(["install:started", "install:failed"])
})
