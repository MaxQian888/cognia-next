import "fake-indexeddb/auto"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { listBackupHistory } from "@/lib/db/backup-history"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import { executeBackupTask, __TESTING__ } from "./backup-executor"

let isTauriValue = true

jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriValue,
}))

const writeTextFileMock = jest.fn(async (_path: string, _body: string) => {})
const mkdirMock = jest.fn(async (_path: string, _opts?: unknown) => {})

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

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  isTauriValue = true
  writeTextFileMock.mockClear()
  mkdirMock.mockClear()
})

describe("executeBackupTask", () => {
  it("writes an encrypted backup, records success in history, and returns the path", async () => {
    const task = makeTask({ backupType: "full", destination: "local" })
    const result = await executeBackupTask(task, makeExecution())
    expect(result.success).toBe(true)
    expect(writeTextFileMock).toHaveBeenCalledTimes(1)
    expect((result.output as { sizeBytes: number }).sizeBytes).toBeGreaterThan(0)

    const history = await listBackupHistory()
    expect(history[0]).toMatchObject({
      success: true,
      type: "scheduled",
      encryption: "auto-key",
    })
  })

  it("rejects non-local destinations with a clear error", async () => {
    const task = makeTask({ destination: "convex" })
    const result = await executeBackupTask(task, makeExecution())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/local/i)
    expect(writeTextFileMock).not.toHaveBeenCalled()
    const history = await listBackupHistory()
    expect(history[0].success).toBe(false)
  })

  it("returns an actionable error when not running under Tauri", async () => {
    isTauriValue = false
    const task = makeTask({ destination: "local" })
    const result = await executeBackupTask(task, makeExecution())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Tauri/i)
    const history = await listBackupHistory()
    expect(history[0].success).toBe(false)
  })

  it("records a failure row when writeTextFile throws", async () => {
    writeTextFileMock.mockRejectedValueOnce(new Error("disk full"))
    const task = makeTask({ destination: "local" })
    const result = await executeBackupTask(task, makeExecution())
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
    await executeBackupTask(task, makeExecution())
    expect(mkdirMock).toHaveBeenCalledTimes(1)
  })
})

describe("payloadToBuildOptions", () => {
  it("defaults to including sessions, never includes the API key", () => {
    expect(__TESTING__.payloadToBuildOptions(undefined, undefined)).toEqual({
      includeSessions: true,
      includeApiKey: false,
    })
  })

  it("settings type drops sessions", () => {
    expect(__TESTING__.payloadToBuildOptions("settings", undefined)).toEqual({
      includeSessions: false,
      includeApiKey: false,
    })
  })

  it("respects payload.options.includeSessions for the `full` type", () => {
    expect(__TESTING__.payloadToBuildOptions("full", { includeSessions: false })).toEqual({
      includeSessions: false,
      includeApiKey: false,
    })
  })

  it("falls through `plugins` to default options", () => {
    expect(__TESTING__.payloadToBuildOptions("plugins", { includeSessions: false })).toEqual({
      includeSessions: false,
      includeApiKey: false,
    })
  })
})

describe("isLocalDestination", () => {
  it("treats undefined as local", () => {
    expect(__TESTING__.isLocalDestination(undefined)).toBe(true)
  })

  it("only accepts the literal `local`", () => {
    expect(__TESTING__.isLocalDestination("local")).toBe(true)
    expect(__TESTING__.isLocalDestination("webdav")).toBe(false)
    expect(__TESTING__.isLocalDestination("convex")).toBe(false)
  })
})
