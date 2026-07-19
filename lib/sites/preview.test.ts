/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { createSiteEnvironmentRevision, createSiteProject } from "@/lib/db/sites"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  __resetSitePreviewsForTesting,
  getSitePreviewSession,
  startSitePreview,
  stopSitePreview,
} from "./preview"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
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
