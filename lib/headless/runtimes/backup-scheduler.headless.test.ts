/** @jest-environment node */

import { bootstrapHeadlessRuntimes } from "../bootstrap"
import { __resetHeadlessRuntimesForTesting } from "../registry"
import type { HeadlessRuntimeContext } from "../types"
import { startBackupScheduler } from "@/lib/data/backup-scheduler"
import { resolveBackupHostFilesystem } from "@/lib/data/backup-host-filesystem"

const stop = jest.fn()
jest.mock("@/lib/data/backup-scheduler", () => ({
  startBackupScheduler: jest.fn(() => stop),
}))
const mockStart = startBackupScheduler as jest.MockedFunction<typeof startBackupScheduler>

const filesystem = {
  writeTextFile: jest.fn(async () => undefined),
  readDirNames: jest.fn(async () => []),
  remove: jest.fn(async () => undefined),
}

function context(withFilesystem = true): HeadlessRuntimeContext {
  return {
    host: "brain",
    accountId: "local_acct_headless",
    bridge: {
      listen: async () => () => undefined,
      invoke: async () => null,
      respondMedia: async () => {},
    },
    notifyDbWrite: () => undefined,
    backupFilesystem: withFilesystem ? filesystem : undefined,
    resolveMessage: (key) => `translated:${key}`,
    log: jest.fn(),
  }
}

beforeAll(async () => {
  __resetHeadlessRuntimesForTesting()
  await import("./backup-scheduler")
})

beforeEach(() => {
  jest.clearAllMocks()
})

it("boots the shared backup scheduler with the Node host filesystem and translated messages", async () => {
  const ctx = context()
  const result = await bootstrapHeadlessRuntimes(ctx)

  expect(result.failed).toEqual([])
  expect(result.started).toEqual(["backup-scheduler"])
  expect(mockStart).toHaveBeenCalledWith(
    expect.objectContaining({
      filesystem,
      messages: {
        missingDestination: "translated:settings.data.webdav.startup.scheduledMissingDestination",
        autoKeyUnavailable: "translated:settings.data.webdav.startup.autoKeyUnavailable",
        syncPassphraseLocked: "translated:settings.data.webdav.startup.syncPassphraseLocked",
        newerTitle: "translated:settings.data.webdav.startup.newerFound",
        newerBody: "translated:settings.data.webdav.startup.newerBody",
      },
    })
  )

  // The scheduled `backup` executor's local leg resolves the same Node
  // filesystem through the host seam while the runtime is up …
  const host = await resolveBackupHostFilesystem()
  expect(host?.kind).toBe("injected")
  expect(host?.filesystem).toBe(filesystem)

  await result.stop()
  expect(stop).toHaveBeenCalledTimes(1)
  // … and the seam is cleared again once the runtime stops.
  expect(await resolveBackupHostFilesystem()).toBeNull()
})

it("fails visibly instead of silently disabling backups without a host filesystem", async () => {
  const result = await bootstrapHeadlessRuntimes(context(false))
  expect(result.started).toEqual([])
  expect(result.failed).toEqual([
    expect.objectContaining({
      name: "backup-scheduler",
      error: expect.objectContaining({
        message: "backup-scheduler requires a host filesystem adapter",
      }),
    }),
  ])
  expect(mockStart).not.toHaveBeenCalled()
})
