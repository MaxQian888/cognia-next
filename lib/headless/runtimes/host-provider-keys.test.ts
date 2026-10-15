/** @jest-environment node */

import { bootstrapHeadlessRuntimes } from "../bootstrap"
import { __resetHeadlessRuntimesForTesting } from "../registry"
import type { HeadlessRuntimeContext } from "../types"

const mockStop = jest.fn()
let mockDeps: unknown = { load: jest.fn(), subscribe: jest.fn() }
let releaseFirstLoad: () => void = () => undefined
jest.mock("@/lib/host-secrets/provider-key-overlay", () => ({
  defaultHostProviderKeyDeps: () => mockDeps,
  installHostProviderKeys: jest.fn(() => ({
    ready: new Promise<void>((resolve) => {
      releaseFirstLoad = resolve
    }),
    stop: mockStop,
  })),
}))

import { installHostProviderKeys } from "@/lib/host-secrets/provider-key-overlay"

function context(log = jest.fn()): HeadlessRuntimeContext {
  return {
    host: "brain",
    localAccountId: "local_acct_headless",
    bridge: {
      listen: async () => () => undefined,
      invoke: async () => null,
      respondMedia: async () => {},
    },
    notifyDbWrite: () => undefined,
    resolveMessage: (key) => key,
    log,
  }
}

beforeAll(async () => {
  __resetHeadlessRuntimesForTesting()
  await import("./host-provider-keys")
})

beforeEach(() => {
  jest.clearAllMocks()
  mockDeps = { load: jest.fn(), subscribe: jest.fn() }
})

it("does not finish starting until the first load has, so the scheduler sees the keys", async () => {
  let started = false
  const boot = bootstrapHeadlessRuntimes(context()).then((result) => {
    started = true
    return result
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(installHostProviderKeys).toHaveBeenCalledTimes(1)
  expect(started).toBe(false)
  releaseFirstLoad()
  const result = await boot
  expect(result.started).toEqual(["host-provider-keys"])
  await result.stop()
  expect(mockStop).toHaveBeenCalledTimes(1)
})

it("says so and starts nothing where there is no host secret store", async () => {
  mockDeps = null
  const log = jest.fn()
  const result = await bootstrapHeadlessRuntimes(context(log))
  expect(result.status()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "host-provider-keys", criticality: "required" }),
    ])
  )
  expect(result.failed).toEqual([])
  expect(installHostProviderKeys).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("no host secret store"))
})
