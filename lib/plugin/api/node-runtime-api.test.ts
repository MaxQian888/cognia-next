jest.mock("../core/transport", () => ({
  ...jest.requireActual("../core/transport"),
  isPluginGatewayAvailable: jest.fn(() => true),
  invokePluginApi: jest.fn(),
}))

import { createNodeRuntimeAPI } from "./node-runtime-api"
import { initializePluginPermissions, revokePluginPermissions } from "./permission-api"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { invokePluginApi, isPluginGatewayAvailable } from "../core/transport"
import type { PluginPermission } from "@/types/plugin"
import { getPluginApiMethodContract } from "@/lib/plugin/contracts/interface-catalog"
import { getPluginApiWireOpContract } from "@cognia/plugin-sdk/contracts"

const pluginId = "runtime-test"
const declaration = { directory: "runtime", entry: "probe.mjs" }
const prepared = {
  state: "prepared",
  prepared: true,
  fingerprint: "sha256:fixture",
  updatedAt: 1,
  packageManager: "pnpm@10.0.0",
}
const permissions: PluginPermission[] = [
  "filesystem:read",
  "filesystem:write",
  "shell:execute",
  "network:fetch",
]

function grantPermissions(grants: PluginPermission[]) {
  revokePluginPermissions(pluginId)
  getPermissionGuard().unregisterPlugin(pluginId)
  initializePluginPermissions(pluginId, grants)
  getPermissionGuard().registerPlugin(pluginId, grants)
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(isPluginGatewayAvailable).mockReturnValue(true)
  jest.mocked(invokePluginApi).mockResolvedValue(prepared)
  grantPermissions(permissions)
})

afterEach(() => {
  revokePluginPermissions(pluginId)
  getPermissionGuard().unregisterPlugin(pluginId)
})

it("does not install or load anything when the API is created", () => {
  createNodeRuntimeAPI(pluginId, declaration)
  expect(invokePluginApi).not.toHaveBeenCalled()
})

it("status reads metadata using only the read grant", async () => {
  grantPermissions(["filesystem:read"])
  await expect(createNodeRuntimeAPI(pluginId, declaration).status()).resolves.toEqual(prepared)
  expect(invokePluginApi).toHaveBeenCalledWith(
    pluginId,
    "nodeRuntime:status",
    {},
    {
      timeoutMs: 30_000,
      retries: 0,
    }
  )
})

it.each(["status", "prepare", "cancel", "probe", "remove"] as const)(
  "%s routes only the owning plugin id and empty operation payload",
  async (method) => {
    await expect(createNodeRuntimeAPI(pluginId, declaration)[method]()).resolves.toEqual(prepared)
    expect(invokePluginApi).toHaveBeenCalledWith(
      pluginId,
      `nodeRuntime:${method}`,
      {},
      {
        timeoutMs: method === "probe" ? 40_000 : 30_000,
        retries: 0,
      }
    )
  }
)

it.each(["prepare", "cancel", "probe", "remove"] as const)(
  "%s requires each execution/write/read grant without requesting permissions",
  async (method) => {
    for (const missing of ["shell:execute", "filesystem:write", "filesystem:read"] as const) {
      grantPermissions(permissions.filter((permission) => permission !== missing))
      await expect(createNodeRuntimeAPI(pluginId, declaration)[method]()).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
        message: expect.stringContaining(missing),
      })
    }
    expect(invokePluginApi).not.toHaveBeenCalled()
  }
)

it("requires network permission for preparation but not loading an installed package", async () => {
  grantPermissions(permissions.filter((permission) => permission !== "network:fetch"))
  const api = createNodeRuntimeAPI(pluginId, declaration)
  await expect(api.prepare()).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
  await expect(api.probe()).resolves.toEqual(prepared)
})

it("honors revoked grants even if the API grant cache still contains them", async () => {
  getPermissionGuard().registerPlugin(pluginId, permissions)
  getPermissionGuard().revoke(pluginId, "shell:execute")
  await expect(createNodeRuntimeAPI(pluginId, declaration).probe()).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  })
  expect(invokePluginApi).not.toHaveBeenCalled()
})

it("fails explicitly on unconnected web/mobile without contacting a native module", async () => {
  jest.mocked(isPluginGatewayAvailable).mockReturnValue(false)
  await expect(createNodeRuntimeAPI(pluginId, declaration).status()).rejects.toMatchObject({
    code: "NOT_SUPPORTED",
  })
  expect(invokePluginApi).not.toHaveBeenCalled()
})

it("rejects undeclared and unsafe runtime packages before contacting the host", async () => {
  await expect(createNodeRuntimeAPI(pluginId, undefined).prepare()).rejects.toMatchObject({
    code: "NOT_SUPPORTED",
  })
  await expect(
    createNodeRuntimeAPI(pluginId, { ...declaration, entry: "../probe.mjs" }).prepare()
  ).rejects.toMatchObject({
    code: "INVALID_REQUEST",
  })
  expect(invokePluginApi).not.toHaveBeenCalled()
})

it("preserves host errors and does not retry preparation or probing", async () => {
  const failure = new Error("Pinned package could not be prepared")
  jest.mocked(invokePluginApi).mockRejectedValue(failure)
  await expect(createNodeRuntimeAPI(pluginId, declaration).prepare()).rejects.toBe(failure)
  expect(invokePluginApi).toHaveBeenCalledTimes(1)
})

it("publishes the same permissions in the governed SDK and transport contracts", () => {
  for (const method of ["status", "prepare", "cancel", "probe", "remove"]) {
    const publicContract = getPluginApiMethodContract(`nodeRuntime.${method}`)
    const wireContract = getPluginApiWireOpContract(`nodeRuntime:${method}`)
    expect(publicContract).toBeDefined()
    expect(wireContract).toBeDefined()
    expect(wireContract?.requiredPermissions).toEqual(publicContract?.requiredPermissions)
    expect(wireContract?.idempotent).toBe(method === "status")
  }
})
