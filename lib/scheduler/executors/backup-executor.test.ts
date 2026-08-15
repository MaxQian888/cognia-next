/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { listBackupHistory } from "@/lib/db/backup-history"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import { executeBackupTask, __TESTING__ } from "./backup-executor"

// The host gate (`lib/scheduler/host-support`) reads `detectPlatform()`.
// State lives inside the factory: `detectPlatform()` runs during module
// import (transport selection), before a top-level `let` would be initialised.
jest.mock("@/lib/platform/detect", () => {
  const hostState = { tauri: true }
  return {
    ...jest.requireActual("@/lib/platform/detect"),
    __hostState: hostState,
    detectPlatform: () => (hostState.tauri ? "tauri" : "web"),
    isTauri: () => hostState.tauri,
  }
})
import * as platformDetect from "@/lib/platform/detect"
const hostState = (platformDetect as unknown as { __hostState: { tauri: boolean } }).__hostState

const writeTextFileMock = jest.fn(async (_path: string, _body: string) => {})
const mkdirMock = jest.fn(async (_path: string, _opts?: unknown) => {})
const attachPortableRetrievalKeysMock = jest.fn(async (pkg: unknown, _passphrase?: string) => pkg)

jest.mock(
  "@tauri-apps/plugin-fs",
  () => ({
    writeTextFile: (...args: unknown[]) => writeTextFileMock(...(args as [string, string])),
    mkdir: (...args: unknown[]) => mkdirMock(...(args as [string, unknown])),
  }),
  { virtual: true }
)

jest.mock(
  "@tauri-apps/api/path",
  () => ({
    appDataDir: jest.fn(async () => "/tmp/app-data"),
    join: jest.fn(async (...parts: string[]) => parts.join("/")),
  }),
  { virtual: true }
)

let syncPassphrase: string | null = null
jest.mock("@/lib/webdav/passphrase-cache", () => ({
  getSyncPassphrase: () => syncPassphrase,
}))

const dispatchMock = jest.fn(
  async (..._args: unknown[]): Promise<{ ok: boolean; target?: string; error?: string }> => ({
    ok: true,
    target: "/cognia-backups/cognia-backup-x.enc.cbk",
  })
)
jest.mock("@/lib/data/destinations", () => ({
  ...jest.requireActual("@/lib/data/destinations"),
  dispatchBackupDestination: (...args: unknown[]) => dispatchMock(...args),
}))
jest.mock("@/lib/data/retrieval-key-backup", () => ({
  attachPortableRetrievalKeys: (pkg: unknown, passphrase: string) =>
    attachPortableRetrievalKeysMock(pkg, passphrase),
}))

function makeTask(payload: ScheduledTask["payload"]): ScheduledTask {
  return {
    id: "task-1",
    name: "Backup",
    type: "backup",
    trigger: { type: "cron", cronExpression: "0 0 * * *" },
    payload,
    config: {
      timeout: 300_000,
      maxRetries: 0,
      retryDelay: 1000,
      runMissedOnStartup: false,
      maxMissedRuns: 1,
      allowConcurrent: false,
    },
    notification: { onStart: false, onComplete: false, onError: false, channels: ["toast"] },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function makeExecution(): TaskExecution {
  return {
    id: "exec-1",
    taskId: "task-1",
    taskName: "Backup",
    taskType: "backup",
    status: "running",
    retryAttempt: 0,
    startedAt: new Date(),
    logs: [],
  }
}

// The first `getDb()` open seeds the full Dexie schema (v140+), which can take
// longer than Jest's default 5s hook budget on a loaded machine.
jest.setTimeout(30_000)

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  hostState.tauri = true
  syncPassphrase = null
  writeTextFileMock.mockClear()
  mkdirMock.mockClear()
  dispatchMock.mockClear()
  dispatchMock.mockResolvedValue({
    ok: true,
    target: "/cognia-backups/cognia-backup-x.enc.cbk",
  })
  attachPortableRetrievalKeysMock.mockClear()
})

describe("executeBackupTask", () => {
  it("writes an encrypted backup, records success in history, and returns the path", async () => {
    const task = makeTask({ backupType: "full", destination: "local" })
    const result = await executeBackupTask(task, makeExecution(), new AbortController().signal)
    expect(result.success).toBe(true)
    expect(writeTextFileMock).toHaveBeenCalledTimes(1)
    expect((result.output as { local: { sizeBytes: number } }).local.sizeBytes).toBeGreaterThan(0)

    const history = await listBackupHistory()
    expect(history[0]).toMatchObject({
      success: true,
      type: "scheduled",
      encryption: "auto-key",
    })
  })

  it("rejects non-local destinations with a clear error", async () => {
    const task = makeTask({ destination: "convex" })
    const result = await executeBackupTask(task, makeExecution(), new AbortController().signal)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/local/i)
    expect(writeTextFileMock).not.toHaveBeenCalled()
    const history = await listBackupHistory()
    expect(history[0].success).toBe(false)
  })

  it("returns a structured unsupported-on-host result on a host without a filesystem", async () => {
    hostState.tauri = false
    const task = makeTask({ destination: "local" })
    const result = await executeBackupTask(task, makeExecution(), new AbortController().signal)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/host filesystem/i)
    expect(result.terminalReason).toBe("unsupported-on-host")
    const history = await listBackupHistory()
    expect(history[0].success).toBe(false)
  })

  it("records a failure row when writeTextFile throws", async () => {
    writeTextFileMock.mockRejectedValueOnce(new Error("disk full"))
    const task = makeTask({ destination: "local" })
    const result = await executeBackupTask(task, makeExecution(), new AbortController().signal)
    expect(result.success).toBe(false)
    expect(result.error).toBe("disk full")
    const history = await listBackupHistory()
    expect(history[0]).toMatchObject({
      success: false,
      type: "scheduled",
      errorMessage: "disk full",
    })
  })

  it("creates the backups directory once before writing", async () => {
    const task = makeTask({ destination: "local" })
    await executeBackupTask(task, makeExecution(), new AbortController().signal)
    expect(mkdirMock).toHaveBeenCalledTimes(1)
  })

  it("uploads to webdav with the sync passphrase when unlocked", async () => {
    syncPassphrase = "sync-pass"
    const task = makeTask({ destination: "webdav" })
    const result = await executeBackupTask(task, makeExecution(), new AbortController().signal)
    expect(result.success).toBe(true)
    expect(dispatchMock).toHaveBeenCalledWith(
      "webdav",
      expect.any(String),
      expect.objectContaining({ filename: expect.stringMatching(/^cognia-backup-.*\.enc\.cbk$/) })
    )
    // webdav-only never touches the disk.
    expect(writeTextFileMock).not.toHaveBeenCalled()
    const history = await listBackupHistory()
    expect(history[0]).toMatchObject({ success: true, encryption: "passphrase" })
  })

  it("fails a webdav task when the sync passphrase is locked", async () => {
    syncPassphrase = null
    const task = makeTask({ destination: "webdav" })
    const result = await executeBackupTask(task, makeExecution(), new AbortController().signal)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unlock/i)
    expect(dispatchMock).not.toHaveBeenCalled()
    const history = await listBackupHistory()
    expect(history[0]).toMatchObject({ success: false, encryption: "passphrase" })
  })

  it("`all` writes to disk AND fans out to every remote leg (webdav, github, googledrive)", async () => {
    syncPassphrase = "sync-pass"
    const task = makeTask({ destination: "all" })
    const result = await executeBackupTask(task, makeExecution(), new AbortController().signal)
    expect(result.success).toBe(true)
    expect(writeTextFileMock).toHaveBeenCalledTimes(1)
    expect(dispatchMock.mock.calls.map((call) => call[0])).toEqual([
      "webdav",
      "github",
      "googledrive",
    ])
    expect(attachPortableRetrievalKeysMock.mock.calls.map((call) => call[1])).toEqual([
      expect.any(String),
      "sync-pass",
    ])
    const history = await listBackupHistory()
    expect(
      history
        .filter((row) => row.success)
        .map((row) => row.destination)
        .sort()
    ).toEqual(["github", "googledrive", "local", "webdav"])
  })

  it("a single remote destination (github) fails hard when its upload fails", async () => {
    syncPassphrase = "sync-pass"
    dispatchMock.mockResolvedValueOnce({ ok: false, error: "public repo" })
    const task = makeTask({ destination: "github" })
    const result = await executeBackupTask(task, makeExecution(), new AbortController().signal)
    expect(result.success).toBe(false)
    expect(result.error).toBe("public repo")
    expect(writeTextFileMock).not.toHaveBeenCalled()
    dispatchMock.mockResolvedValueOnce({ ok: true, target: "o/r:cognia-backups/x" })
    const ok = await executeBackupTask(
      makeTask({ destination: "googledrive" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(ok.success).toBe(true)
    expect((ok.output as { googledrive: { target: string } }).googledrive.target).toBe(
      "o/r:cognia-backups/x"
    )
  })

  it("refuses the deprecated convex destination with an actionable error", async () => {
    const result = await executeBackupTask(
      makeTask({ destination: "convex" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/deprecated/)
    const history = await listBackupHistory()
    expect(history[0]).toMatchObject({ success: false, destination: "convex" })
  })

  it("`all` keeps partial success but surfaces a locked webdav leg in output", async () => {
    syncPassphrase = null // sync passphrase locked this session
    const task = makeTask({ destination: "all" })
    const result = await executeBackupTask(task, makeExecution(), new AbortController().signal)
    // Local leg succeeded → partial success is still reported as success...
    expect(result.success).toBe(true)
    expect(writeTextFileMock).toHaveBeenCalledTimes(1)
    expect(dispatchMock).not.toHaveBeenCalled()
    // ...but the skipped webdav leg is no longer silent at the result level.
    expect((result.output as { webdav?: { skipped?: boolean } }).webdav).toMatchObject({
      skipped: true,
    })
  })

  it("`all` surfaces a failed webdav upload in output without failing the task", async () => {
    syncPassphrase = "sync-pass"
    dispatchMock.mockResolvedValueOnce({ ok: false, error: "server down" })
    const task = makeTask({ destination: "all" })
    const result = await executeBackupTask(task, makeExecution(), new AbortController().signal)
    expect(result.success).toBe(true)
    expect(writeTextFileMock).toHaveBeenCalledTimes(1)
    expect(
      (result.output as { webdav?: { failed?: boolean; error?: string } }).webdav
    ).toMatchObject({ failed: true, error: "server down" })
  })
})

describe("payloadToBuildOptions", () => {
  it("defaults to including sessions, never includes the API key", () => {
    expect(__TESTING__.payloadToBuildOptions(undefined, undefined)).toEqual({
      includeSessions: true,
      includeApiKey: false,
      includeSettings: true,
      includeCoreData: true,
      includePlugins: false,
      includeLocalStorage: true,
      includeArtifacts: true,
    })
  })

  it("settings type exports only settings-backed state", () => {
    expect(__TESTING__.payloadToBuildOptions("settings", undefined)).toEqual({
      includeSessions: false,
      includeApiKey: false,
      includeSettings: true,
      includeCoreData: false,
      includePlugins: false,
      includeLocalStorage: true,
      includeArtifacts: false,
    })
  })

  it("respects every selection option for the `full` type", () => {
    expect(
      __TESTING__.payloadToBuildOptions("full", {
        includeSessions: false,
        includeSettings: false,
        includeArtifacts: false,
        includeIndexedDB: false,
      })
    ).toEqual({
      includeSessions: false,
      includeApiKey: false,
      includeSettings: false,
      includeCoreData: false,
      includePlugins: false,
      includeLocalStorage: true,
      includeArtifacts: false,
    })
  })

  it("maps `plugins` to the plugin domain only", () => {
    expect(__TESTING__.payloadToBuildOptions("plugins", { includeSessions: false })).toEqual({
      includeSessions: false,
      includeApiKey: false,
      includeSettings: false,
      includeCoreData: false,
      includePlugins: true,
      includeLocalStorage: false,
    })
  })
})

describe("payload → build options", () => {
  it("maps every backup type to an exact ExportOptions contract", () => {
    const { payloadToBuildOptions } = __TESTING__
    expect(payloadToBuildOptions("sessions", undefined)).toMatchObject({
      includeApiKey: false,
      includeSessions: true,
      includeSettings: false,
      includePlugins: false,
    })
    expect(payloadToBuildOptions("settings", undefined)).toMatchObject({
      includeSettings: true,
      includeLocalStorage: true,
      includeArtifacts: false,
    })
    expect(payloadToBuildOptions("plugins", undefined)).toMatchObject({ includePlugins: true })
    expect(payloadToBuildOptions("all", undefined)).toMatchObject({
      includeSessions: true,
      includePlugins: true,
      includeArtifacts: true,
    })
    expect(
      payloadToBuildOptions("full", {
        includeSessions: false,
        includeIndexedDB: false,
        includeArtifacts: false,
      })
    ).toMatchObject({ includeSessions: false, includeCoreData: false, includeArtifacts: false })
  })
})

describe("local leg without a writable host directory", () => {
  it("fails a local-only task but keeps `all` going with a skipped local leg", async () => {
    // Injected host without a configured directory (headless brain, no dirPath).
    const { setBackupHostFilesystem, createInjectedBackupHost } =
      await import("@/lib/data/backup-host-filesystem")
    const dispose = setBackupHostFilesystem(
      createInjectedBackupHost({
        writeTextFile: async () => undefined,
        readDirNames: async () => [],
        remove: async () => undefined,
      })
    )
    try {
      const local = await executeBackupTask(
        makeTask({ destination: "local" }),
        makeExecution(),
        new AbortController().signal
      )
      expect(local.success).toBe(false)
      expect(local.error).toMatch(/no backup directory/)
      syncPassphrase = "sync-pass"
      const all = await executeBackupTask(
        makeTask({ destination: "all" }),
        makeExecution(),
        new AbortController().signal
      )
      expect(all.success).toBe(true)
      expect((all.output as { local: { skipped: boolean } }).local.skipped).toBe(true)
      expect(dispatchMock).toHaveBeenCalledTimes(3)
    } finally {
      dispose()
    }
  })
})

describe("destination helpers", () => {
  it("supports local / webdav / all / undefined, rejects other clouds", () => {
    expect(__TESTING__.isSupportedDestination(undefined)).toBe(true)
    expect(__TESTING__.isSupportedDestination("local")).toBe(true)
    expect(__TESTING__.isSupportedDestination("webdav")).toBe(true)
    expect(__TESTING__.isSupportedDestination("all")).toBe(true)
    expect(__TESTING__.isSupportedDestination("convex")).toBe(false)
    expect(__TESTING__.isSupportedDestination("github")).toBe(true)
    expect(__TESTING__.isSupportedDestination("googledrive")).toBe(true)
  })

  it("routes local vs webdav intent", () => {
    expect(__TESTING__.wantsLocal("local")).toBe(true)
    expect(__TESTING__.wantsLocal("all")).toBe(true)
    expect(__TESTING__.wantsLocal("webdav")).toBe(false)
    expect(__TESTING__.wantsWebdav("webdav")).toBe(true)
    expect(__TESTING__.wantsWebdav("all")).toBe(true)
    expect(__TESTING__.wantsWebdav("local")).toBe(false)
  })
})
