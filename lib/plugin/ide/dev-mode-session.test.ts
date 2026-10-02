jest.mock("@/lib/platform/detect", () => ({ isTauri: () => true }))
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(async (_command: string, args?: { enabled?: boolean }) => ({
    enabled: args?.enabled ?? false,
    devPaths: [],
  })),
}))

import { invoke } from "@tauri-apps/api/core"
import type { Plugin } from "@/types/plugin"

import { isDevModeActive, resetDevModeForTests } from "./dev-mode"
import {
  DEV_MODE_ENDED_REASON,
  enterManagedIdeDevMode,
  leaveManagedIdeDevMode,
  type DevModeSessionDependencies,
} from "./dev-mode-session"

const plugin = (id: string, status: Plugin["status"], source: Plugin["source"] = "local") =>
  ({ manifest: { id }, status, source }) as unknown as Plugin

function deps(receipts: Record<string, string | null>, plugins: Plugin[]) {
  const disabled: Array<[string, string]> = []
  const dependencies: DevModeSessionDependencies = {
    plugins: async () => plugins,
    readReceipt: jest.fn(async (pluginId: string) =>
      receipts[pluginId] ? { verifiedVia: receipts[pluginId]! } : null
    ),
    disablePlugin: jest.fn(async (pluginId: string, reason: string) => {
      if (pluginId === "stuck") throw new Error("busy")
      disabled.push([pluginId, reason])
    }),
    clearVerificationCache: jest.fn(async () => undefined),
  }
  return { dependencies, disabled }
}

beforeEach(() => {
  resetDevModeForTests()
  jest.clearAllMocks()
})

it("entering switches the host on and re-checks verification", async () => {
  const { dependencies } = deps({}, [])
  await expect(enterManagedIdeDevMode(dependencies)).resolves.toEqual({
    enabled: true,
    devPaths: [],
  })
  expect(invoke).toHaveBeenCalledWith("plugin_managed_ide_dev_mode_set", { enabled: true })
  expect(isDevModeActive()).toBe(true)
  expect(dependencies.clearVerificationCache).toHaveBeenCalledTimes(1)
})

it("leaving disables exactly the running plugins trusted only through local-dev receipts", async () => {
  const { dependencies, disabled } = deps(
    { dev: "local-dev", signed: "signature", idle: "local-dev", stuck: "local-dev" },
    [
      plugin("dev", "enabled"),
      plugin("signed", "enabled"),
      plugin("idle", "disabled"),
      plugin("core", "enabled", "builtin"),
      plugin("stuck", "suspended"),
    ]
  )
  await enterManagedIdeDevMode(dependencies)
  const left = await leaveManagedIdeDevMode(dependencies)
  expect(left.status.enabled).toBe(false)
  expect(isDevModeActive()).toBe(false)
  expect(left.disabled).toEqual(["dev"])
  expect(disabled).toEqual([["dev", DEV_MODE_ENDED_REASON]])
  expect(left.failed).toEqual([{ pluginId: "stuck", error: "busy" }])
  // Receipts were read before the switch went off, and never for builtins.
  expect(dependencies.readReceipt).not.toHaveBeenCalledWith("core")
  const setOff = jest
    .mocked(invoke)
    .mock.calls.findIndex(
      ([command, args]) =>
        command === "plugin_managed_ide_dev_mode_set" &&
        (args as { enabled: boolean }).enabled === false
    )
  expect(jest.mocked(dependencies.readReceipt).mock.invocationCallOrder.at(-1)).toBeLessThan(
    jest.mocked(invoke).mock.invocationCallOrder[setOff]
  )
})
