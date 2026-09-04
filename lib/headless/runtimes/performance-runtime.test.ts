/** @jest-environment node */
import { bootstrapHeadlessRuntimes } from "../bootstrap"
import { __resetHeadlessRuntimesForTesting } from "../registry"
import type { HeadlessRuntimeContext } from "../types"
import {
  getPerformanceHostAdapter,
  resetPerformanceHostAdapterForTesting,
} from "@/lib/perf/host-adapter"

afterEach(() => {
  resetPerformanceHostAdapterForTesting()
  jest.resetModules()
})

it("registers the Node performance host in the headless runtime roster", async () => {
  __resetHeadlessRuntimesForTesting()
  await import("./performance-runtime")
  const context: HeadlessRuntimeContext = {
    host: "brain",
    localAccountId: "account",
    bridge: {
      listen: async () => () => undefined,
      invoke: jest.fn(),
      respondMedia: async () => {},
    },
    notifyDbWrite: jest.fn(),
    resolveMessage: (key) => key,
    log: jest.fn(),
  }
  const result = await bootstrapHeadlessRuntimes(context)
  expect(result.failed).toEqual([])
  expect(result.started).toContain("performance-host")
  expect(getPerformanceHostAdapter()).toBeDefined()
  await result.stop()
  expect(() => getPerformanceHostAdapter()).toThrow(/unsupported/)
})
