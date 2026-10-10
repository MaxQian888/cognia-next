import { FILES_TRASH_RETENTION_MS, type LibraryItemRow } from "@/lib/db/files-library-types"

const mockRegisterTaskExecutor = jest.fn()
const mockGetAllTasks = jest.fn()
const mockCreateTask = jest.fn()

jest.mock("@/lib/scheduler/task-scheduler", () => ({
  registerTaskExecutor: (...args: unknown[]) => mockRegisterTaskExecutor(...args),
  getTaskScheduler: () => ({ getAllTasks: mockGetAllTasks, createTask: mockCreateTask }),
}))

import {
  FILES_TRASH_PURGE_INTERVAL_MS,
  FILES_TRASH_PURGE_TASK_TAG,
  FILES_TRASH_PURGE_TASK_TYPE,
  installFilesTrashPurgeSchedule,
  registerFilesTrashPurgeExecutor,
  runFilesTrashPurge,
} from "./trash-purge-schedule"

const row = { key: "image:h1", kind: "image", sourceId: "h1" } as LibraryItemRow

beforeEach(() => {
  mockRegisterTaskExecutor.mockReset()
  mockGetAllTasks.mockReset()
  mockCreateTask.mockReset()
})

describe("runFilesTrashPurge", () => {
  it("purges rows trashed before the retention cutoff", async () => {
    const listExpired = jest.fn(async () => [row])
    const resolveTargets = jest.fn(async () => [
      {
        key: row.key,
        kind: row.kind,
        sourceId: row.sourceId,
        ownedByFiles: false,
        originAlive: false,
      },
    ])
    const purge = jest.fn(async () => ({ deleted: 1, retired: 0 }))
    const outcome = await runFilesTrashPurge({
      now: () => FILES_TRASH_RETENTION_MS + 100,
      hostOwnsData: () => false,
      listExpired,
      resolveTargets,
      purge,
    })
    expect(listExpired).toHaveBeenCalledWith(100)
    expect(resolveTargets).toHaveBeenCalledWith([row])
    expect(outcome).toEqual({ expired: 1, deleted: 1, retired: 0 })
  })

  it("skips on a paired client whose Host owns the library", async () => {
    const listExpired = jest.fn()
    expect(await runFilesTrashPurge({ hostOwnsData: () => true, listExpired })).toEqual({
      expired: 0,
      deleted: 0,
      retired: 0,
      skipped: "host-owned",
    })
    expect(listExpired).not.toHaveBeenCalled()
  })

  it("does not resolve anything when nothing expired", async () => {
    const resolveTargets = jest.fn()
    expect(
      await runFilesTrashPurge({
        hostOwnsData: () => false,
        listExpired: async () => [],
        resolveTargets,
      })
    ).toEqual({ expired: 0, deleted: 0, retired: 0 })
    expect(resolveTargets).not.toHaveBeenCalled()
  })
})

describe("schedule install", () => {
  it("registers the executor under its task type", () => {
    registerFilesTrashPurgeExecutor()
    expect(mockRegisterTaskExecutor).toHaveBeenCalledWith(
      FILES_TRASH_PURGE_TASK_TYPE,
      expect.any(Function)
    )
  })

  it("creates exactly one interval task, tagged as system maintenance", async () => {
    mockGetAllTasks.mockResolvedValueOnce([])
    await installFilesTrashPurgeSchedule()
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: FILES_TRASH_PURGE_TASK_TYPE,
        trigger: { type: "interval", intervalMs: FILES_TRASH_PURGE_INTERVAL_MS },
        tags: [FILES_TRASH_PURGE_TASK_TAG],
      })
    )
    mockGetAllTasks.mockResolvedValueOnce([{ type: FILES_TRASH_PURGE_TASK_TYPE }])
    await installFilesTrashPurgeSchedule()
    expect(mockCreateTask).toHaveBeenCalledTimes(1)
  })
})
