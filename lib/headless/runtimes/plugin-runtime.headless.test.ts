/** @jest-environment node */

import { transport } from "@/lib/tauri"
import { bootstrapHeadlessRuntimes } from "../bootstrap"
import { __resetHeadlessRuntimesForTesting } from "../registry"
import type { HeadlessRuntimeContext } from "../types"

jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn(), subscribe: jest.fn() },
}))

const mockEmitSystemBusEvent = jest.fn()
jest.mock("@/lib/plugin/messaging/message-bus", () => ({
  SystemEvents: { APP_CLOSING: "app:closing" },
  emitSystemBusEvent: (...args: unknown[]) => mockEmitSystemBusEvent(...args),
}))

const mockDisposeMicrovmAdapters = jest.fn(async () => undefined)
jest.mock("@/lib/sandbox/microvm-bridge", () => ({
  disposeMicrovmAdapters: () => mockDisposeMicrovmAdapters(),
}))

const mockDisposePackWarnings = jest.fn()
const mockInstallPackWarningRefreshWiring = jest.fn(() => mockDisposePackWarnings)
jest.mock("@/lib/plugin/character-pack/warning-refresh-wiring", () => ({
  installPackWarningRefreshWiring: () => mockInstallPackWarningRefreshWiring(),
}))

const mockSubscribe = transport.subscribe as jest.Mock

beforeAll(async () => {
  __resetHeadlessRuntimesForTesting()
  await import("./plugin-runtime")
})

beforeEach(() => {
  jest.clearAllMocks()
})

function context(pluginRuntime?: HeadlessRuntimeContext["pluginRuntime"]) {
  const logs: Array<[string, string]> = []
  const ctx: HeadlessRuntimeContext = {
    host: "brain",
    localAccountId: "account-a",
    bridge: {
      listen: async () => () => undefined,
      invoke: async () => null,
      respondMedia: async () => {},
    },
    notifyDbWrite: () => undefined,
    resolveMessage: (key) => key,
    pluginRuntime,
    log: (level, message) => logs.push([level, message]),
  }
  return { ctx, logs }
}

it("starts once, serializes same-account changes, and tears down the adapter", async () => {
  const unsubscribe = jest.fn()
  let onChange: ((payload: unknown) => void) | undefined
  mockSubscribe.mockImplementation((_event: string, handler: (payload: unknown) => void) => {
    onChange = handler
    return unsubscribe
  })
  const adapter = {
    start: jest.fn(async () => undefined),
    reconcile: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
  }
  const { ctx, logs } = context(adapter)
  const result = await bootstrapHeadlessRuntimes(ctx)

  expect(result.failed).toEqual([])
  expect(adapter.start).toHaveBeenCalledTimes(1)
  expect(mockSubscribe).toHaveBeenCalledWith("plugin://runtime-changed", expect.any(Function))

  onChange?.({ action: "installed", pluginId: "demo", accountId: "account-a" })
  onChange?.({ action: "restored", pluginId: "demo", accountId: "other-account" })
  onChange?.({ action: "unknown", pluginId: "demo" })
  await result.stop()

  expect(adapter.reconcile).toHaveBeenCalledWith({
    action: "installed",
    pluginId: "demo",
    accountId: "account-a",
  })
  expect(adapter.reconcile).toHaveBeenCalledTimes(1)
  expect(logs).toContainEqual(["warn", "plugin runtime ignored a malformed change event"])
  expect(unsubscribe).toHaveBeenCalledTimes(1)
  expect(adapter.stop).toHaveBeenCalledTimes(1)
  expect(mockEmitSystemBusEvent).toHaveBeenCalledWith("app:closing", {})
  expect(mockDisposeMicrovmAdapters).toHaveBeenCalledTimes(1)
})

it("force-disposes E2B adapters even when the headless plugin host stop fails", async () => {
  mockSubscribe.mockReturnValue(() => undefined)
  const adapter = {
    start: jest.fn(async () => undefined),
    reconcile: jest.fn(async () => undefined),
    stop: jest.fn(async () => Promise.reject(new Error("stop failed"))),
  }
  const { ctx } = context(adapter)
  const result = await bootstrapHeadlessRuntimes(ctx)

  await expect(result.stop()).resolves.toBeUndefined()
  expect(mockDisposeMicrovmAdapters).toHaveBeenCalledTimes(1)
})

it("reports the runtime as failed when the Node adapter is absent", async () => {
  const { ctx } = context()
  const result = await bootstrapHeadlessRuntimes(ctx)
  expect(result.started).toEqual([])
  expect(result.failed[0]?.name).toBe("plugin-runtime")
})

describe("character-pack warning refresh", () => {
  // Booted only from `PluginRuntimeInitializer` before ADR-0059 wiring, so on a
  // cloud host pack warnings went stale the moment a pack was added or removed.
  it("installs the refresh wiring on start and disposes it on teardown", async () => {
    mockSubscribe.mockReturnValue(() => undefined)
    const runtime = {
      start: jest.fn(async () => undefined),
      reconcile: jest.fn(async () => undefined),
    }
    const { ctx } = context(runtime)

    const result = await bootstrapHeadlessRuntimes(ctx)
    expect(result.started).toContain("plugin-runtime")
    expect(mockInstallPackWarningRefreshWiring).toHaveBeenCalledTimes(1)
    expect(mockDisposePackWarnings).not.toHaveBeenCalled()

    await result.stop()
    expect(mockDisposePackWarnings).toHaveBeenCalledTimes(1)
  })
})
