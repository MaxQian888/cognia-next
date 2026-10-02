let desktop = true
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => desktop }))
const hostState = { enabled: false, devPaths: [] as string[] }
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(async (command: string, args?: { enabled?: boolean; path?: string }) => {
    if (command === "plugin_managed_ide_dev_mode_set") {
      hostState.enabled = args?.enabled ?? false
      if (!hostState.enabled) hostState.devPaths = []
    }
    if (command === "plugin_managed_ide_dev_path_register") {
      // The host canonicalizes: `/link/acme` is really `/dev/acme`.
      const canonical = args!.path!.replace("/link/", "/dev/")
      hostState.devPaths = [...new Set([...hostState.devPaths, canonical])]
      return { path: canonical, status: { ...hostState, devPaths: [...hostState.devPaths] } }
    }
    if (command === "plugin_managed_ide_dev_path_unregister") {
      hostState.devPaths = hostState.devPaths.filter((path) => path !== args!.path)
    }
    return { ...hostState, devPaths: [...hostState.devPaths] }
  }),
}))

import {
  devFolders,
  devModeStatus,
  devModeVersion,
  isDevModeActive,
  isPluginSimulated,
  readDevModeStatus,
  registerDevFolder,
  registerDevPath,
  resetDevModeForTests,
  setDevModeEnabled,
  setSimulatedPermission,
  simulatedDecision,
  simulatedPermissions,
  subscribeDevMode,
  unregisterDevPath,
} from "./dev-mode"

beforeEach(() => {
  desktop = true
  hostState.enabled = false
  hostState.devPaths = []
  resetDevModeForTests()
})

it("mirrors the host switch and its registered dev folders", async () => {
  await expect(readDevModeStatus()).resolves.toEqual({ enabled: false, devPaths: [] })
  await setDevModeEnabled(true)
  await registerDevPath("/dev/acme")
  expect(devModeStatus()).toEqual({ enabled: true, devPaths: ["/dev/acme"] })
  await unregisterDevPath("/dev/acme")
  expect(devModeStatus().devPaths).toEqual([])
  expect(isDevModeActive()).toBe(true)
})

it("is off outside the desktop and cannot be switched on there", async () => {
  desktop = false
  await expect(readDevModeStatus()).resolves.toEqual({ enabled: false, devPaths: [] })
  await expect(setDevModeEnabled(true)).rejects.toThrow("MANAGED_IDE_DEV_MODE_DESKTOP_ONLY")
})

it("simulates only during Dev Mode, per plugin and permission, and forgets it when Dev Mode ends", async () => {
  expect(() => setSimulatedPermission("acme", "process:spawn", "deny")).toThrow(
    "MANAGED_IDE_DEV_MODE_OFF"
  )
  await setDevModeEnabled(true)
  setSimulatedPermission("acme", "process:spawn", "deny")
  setSimulatedPermission("acme", "editor:read", "ask")
  expect(simulatedDecision("acme", "process:spawn")).toBe("deny")
  expect(simulatedDecision("other", "process:spawn")).toBeUndefined()
  expect(isPluginSimulated("acme")).toBe(true)
  expect(simulatedPermissions()).toEqual([
    { pluginId: "acme", permission: "process:spawn", decision: "deny" },
    { pluginId: "acme", permission: "editor:read", decision: "ask" },
  ])
  setSimulatedPermission("acme", "process:spawn", null)
  setSimulatedPermission("acme", "editor:read", null)
  expect(isPluginSimulated("acme")).toBe(false)

  setSimulatedPermission("acme", "process:spawn", "allow")
  await setDevModeEnabled(false)
  expect(simulatedDecision("acme", "process:spawn")).toBeUndefined()
  await setDevModeEnabled(true)
  // A new session starts clean.
  expect(simulatedPermissions()).toEqual([])
})

it("tells subscribers about every change", async () => {
  const listener = jest.fn()
  const unsubscribe = subscribeDevMode(listener)
  const before = devModeVersion()
  await setDevModeEnabled(true)
  setSimulatedPermission("acme", "editor:read", "allow")
  expect(listener).toHaveBeenCalledTimes(2)
  expect(devModeVersion()).toBe(before + 2)
  unsubscribe()
  setSimulatedPermission("acme", "editor:read", null)
  expect(listener).toHaveBeenCalledTimes(2)
})

it("maps a registered plugin folder to its plugin by the host's canonical path", async () => {
  await setDevModeEnabled(true)
  await registerDevFolder("/link/acme", "acme")
  await registerDevFolder("/link/acme", "acme")
  expect(devFolders()).toEqual([{ path: "/dev/acme", pluginId: "acme" }])
  await unregisterDevPath("/dev/acme")
  expect(devFolders()).toEqual([])
  await registerDevFolder("/dev/beta", "beta")
  await setDevModeEnabled(false)
  expect(devFolders()).toEqual([])
})
