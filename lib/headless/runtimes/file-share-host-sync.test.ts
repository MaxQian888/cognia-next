/** @jest-environment node */

import { bootstrapHeadlessRuntimes } from "../bootstrap"
import { __resetHeadlessRuntimesForTesting } from "../registry"
import type { HeadlessRuntimeContext } from "../types"
import { createFileShareHostSync } from "@/lib/filespace/host-sync"
import { announceFileSpaceSessionsChanged } from "@/lib/filespace/lifecycle"

const stop = jest.fn()
const start = jest.fn(() => stop)
const sessionsChanged = jest.fn(async (_ids: readonly string[]) => {})
jest.mock("@/lib/filespace/host-sync", () => ({
  createFileShareHostSync: jest.fn(() => ({ start, sessionsChanged })),
  defaultLoadPolicy: jest.fn(),
}))
jest.mock("@/lib/filespace/mount-table", () => ({
  defaultMountTableDeps: { getSession: jest.fn(), loadSpace: jest.fn() },
}))
const mockCreate = createFileShareHostSync as jest.MockedFunction<typeof createFileShareHostSync>

function context(): HeadlessRuntimeContext {
  return {
    host: "brain",
    localAccountId: "local_acct_headless",
    bridge: {
      listen: async () => () => undefined,
      invoke: async () => null,
      respondMedia: async () => {},
    },
    notifyDbWrite: () => undefined,
    resolveMessage: (key) => `translated:${key}`,
    log: jest.fn(),
  }
}

beforeAll(async () => {
  __resetHeadlessRuntimesForTesting()
  await import("./file-share-host-sync")
})

beforeEach(() => {
  jest.clearAllMocks()
})

it("syncs the brain's own account against its own server", async () => {
  const result = await bootstrapHeadlessRuntimes(context())
  expect(result.status()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "file-share-host-sync", criticality: "optional" }),
    ])
  )
  expect(result.failed).toEqual([])
  expect(result.started).toEqual(["file-share-host-sync"])
  const deps = mockCreate.mock.calls[0]![0]
  // No host id: off the desktop that is the brain's one transport, its server.
  expect(deps.target).toEqual({})
  expect(deps.accountId()).toBe("local_acct_headless")
  expect(start).toHaveBeenCalledTimes(1)
})

it("stops refreshing when the brain shuts down", async () => {
  const result = await bootstrapHeadlessRuntimes(context())
  await result.stop()
  expect(stop).toHaveBeenCalledTimes(1)
})

it("pushes the brain's archives, restores and deletes as they happen, until it stops", async () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const result = await bootstrapHeadlessRuntimes(context())
  announceFileSpaceSessionsChanged(["s1"])
  await flush()
  expect(sessionsChanged).toHaveBeenCalledWith(["s1"])
  await result.stop()
  announceFileSpaceSessionsChanged(["s2"])
  await flush()
  expect(sessionsChanged).toHaveBeenCalledTimes(1)
})
