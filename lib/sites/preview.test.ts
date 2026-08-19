/**
 * Runs in the fast `node` project, NOT jsdom.
 *
 * This suite carried a `@jest-environment jsdom` docblock, and that is what
 * made it fail: forcing jsdom inside the node project makes the shared DB
 * fixture's full-schema capture transaction die with `PrematureCommitError`,
 * which Jest renders as an *empty* failure message. Nothing here needs a DOM —
 * every host dependency is injected — so the node default is both correct and
 * green. Do not re-add the docblock.
 */

import { createSiteEnvironmentRevision, createSiteProject } from "@/lib/db/sites"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  __resetSitePreviewsForTesting,
  getSitePreviewSession,
  resumeSitePreviewSession,
  startSitePreview,
  stopSitePreview,
} from "./preview"

// The shared fixture owns the schema open + seed. Hand-rolling
// `getDb().delete()` / `whenSeeded()` here used to race `seedBuiltIns()`'s own
// transactions, and the first `createSiteEnvironmentRevision` died with a
// `TransactionInactiveError` whose empty message made the failure unreadable.
const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
afterAll(dbFixture.dispose)

beforeEach(async () => {
  await dbFixture.restore()
  __resetSitePreviewsForTesting()
  await createSiteProject({
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/repo",
    sourceSubpath: "apps/docs",
    executionTarget: { kind: "local" },
    provider: "cloudflare",
    providerConfig: { accountId: "account", workerName: "docs" },
    authoringPolicy: { ownerAccountId: "local-user", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
  })
})

async function environment() {
  return createSiteEnvironmentRevision({
    id: "env_1",
    siteId: "site_1",
    variables: { PUBLIC_ORIGIN: "https://example.com" },
    secretRefs: [],
  })
}

const manifest = JSON.stringify({
  schemaVersion: 1,
  build: { command: ["pnpm", "build"], entry: "dist/worker.js" },
  preview: { command: ["pnpm", "dev"], url: "http://localhost:3000" },
  cloudflare: { compatibilityDate: "2026-07-18", compatibilityFlags: [], bindings: [] },
})

it("starts one visible terminal-backed preview with strict sandbox networking disabled", async () => {
  await environment()
  const spawn = jest.fn(async (_input: unknown) => ({
    kind: "spawned" as const,
    sessionId: "terminal-1",
    shell: "pnpm",
  }))
  const waitUntilReady = jest.fn(async () => undefined)
  const deps = {
    join: async (...parts: string[]) => parts.join("/"),
    readText: async () => manifest,
    spawn,
    stop: jest.fn(async () => undefined),
    waitUntilReady,
  }

  const first = await startSitePreview("site_1", "env_1", deps)
  const second = await startSitePreview("site_1", "env_1", deps)

  expect(second).toBe(first)
  expect(spawn).toHaveBeenCalledTimes(1)
  expect((spawn.mock.calls[0][0] as { req: Record<string, unknown> }).req).toMatchObject({
    shell: "pnpm",
    args: ["dev"],
    cwd: "/repo/apps/docs",
    env: { PUBLIC_ORIGIN: "https://example.com" },
    sandboxed: true,
    sandboxNetwork: false,
    enableShellIntegration: false,
  })
  expect(waitUntilReady).toHaveBeenCalledWith("http://localhost:3000")
})

it("kills a failed or explicitly stopped preview and releases its singleton", async () => {
  await environment()
  const stop = jest.fn(async () => undefined)
  const base = {
    join: async (...parts: string[]) => parts.join("/"),
    readText: async () => manifest,
    spawn: async () => ({ kind: "spawned" as const, sessionId: "terminal-1", shell: "pnpm" }),
    stop,
  }
  await expect(
    startSitePreview("site_1", "env_1", {
      ...base,
      waitUntilReady: async () => {
        throw new Error("not ready")
      },
    })
  ).rejects.toThrow("not ready")
  expect(stop).toHaveBeenCalledWith("terminal-1")

  await startSitePreview("site_1", "env_1", {
    ...base,
    waitUntilReady: async () => undefined,
  })
  await stopSitePreview("site_1", { stop })
  expect(getSitePreviewSession("site_1")).toBeUndefined()
})

describe("resumeSitePreviewSession", () => {
  const base = {
    join: async (...parts: string[]) => parts.join("/"),
    readText: async () => manifest,
  }

  it("re-adopts a live terminal that matches the Site's project and source dir", async () => {
    const resumed = await resumeSitePreviewSession("site_1", {
      ...base,
      listSessions: () => [
        { id: "other", projectId: "project_1", cwd: "/repo/elsewhere", status: "running" },
        { id: "terminal-7", projectId: "project_1", cwd: "/repo/apps/docs", status: "running" },
      ],
    })
    expect(resumed).toEqual({
      siteId: "site_1",
      terminalSessionId: "terminal-7",
      url: "http://localhost:3000",
    })
    expect(getSitePreviewSession("site_1")).toEqual(resumed)
  })

  it("returns the already-tracked session without touching the terminal store", async () => {
    await environment()
    const first = await startSitePreview("site_1", "env_1", {
      ...base,
      spawn: async () => ({ kind: "spawned" as const, sessionId: "terminal-1", shell: "pnpm" }),
      stop: async () => undefined,
      waitUntilReady: async () => undefined,
    })
    const listSessions = jest.fn(() => [])
    await expect(resumeSitePreviewSession("site_1", { ...base, listSessions })).resolves.toBe(first)
    expect(listSessions).not.toHaveBeenCalled()
  })

  it("ignores exited terminals and terminals from another project", async () => {
    const resumed = await resumeSitePreviewSession("site_1", {
      ...base,
      listSessions: () => [
        { id: "dead", projectId: "project_1", cwd: "/repo/apps/docs", status: "exited" },
        { id: "foreign", projectId: "project_2", cwd: "/repo/apps/docs", status: "running" },
      ],
    })
    expect(resumed).toBeUndefined()
    expect(getSitePreviewSession("site_1")).toBeUndefined()
  })

  it("resolves to undefined instead of throwing when the manifest is unreadable", async () => {
    const resumed = await resumeSitePreviewSession("site_1", {
      ...base,
      readText: async () => {
        throw new Error("ENOENT")
      },
      listSessions: () => [
        { id: "terminal-7", projectId: "project_1", cwd: "/repo/apps/docs", status: "running" },
      ],
    })
    expect(resumed).toBeUndefined()
  })

  it("resolves to undefined for an unknown Site", async () => {
    await expect(
      resumeSitePreviewSession("missing", { ...base, listSessions: () => [] })
    ).resolves.toBeUndefined()
  })
})
