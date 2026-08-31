jest.mock("@/lib/db/characters", () => ({
  listCharacters: jest.fn(async () => []),
}))
jest.mock("@/lib/db/twins", () => ({ listTwins: jest.fn(async () => []) }))
jest.mock("@/lib/db/skills", () => ({ listSkills: jest.fn(async () => []) }))
jest.mock("@/lib/db/adapter-instances", () => ({
  listAdapterInstances: jest.fn(async () => []),
}))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: jest.fn(async () => []) }))
jest.mock("@/lib/db/plugins", () => ({ listPlugins: jest.fn(async () => []) }))

import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security/permission-guard"

import { createResourcesAPI } from "./resources-api"

const PLUGIN_ID = "test-plugin"

describe("createResourcesAPI", () => {
  beforeEach(() => {
    resetPermissionGuard()
    getPermissionGuard().registerPlugin(PLUGIN_ID, ["database:read"])
  })

  it("publishes every resource lookup through one host-owned API", () => {
    expect(Object.keys(createResourcesAPI(PLUGIN_ID)).sort()).toEqual(
      [
        "listAdapterInstances",
        "listCharacters",
        "listMcpServers",
        "listPlugins",
        "listSkills",
        "listTwins",
      ].sort()
    )
  })

  it("refuses a plugin that did not declare database:read", () => {
    getPermissionGuard().registerPlugin("unprivileged", [])
    expect(() => createResourcesAPI("unprivileged").listMcpServers()).toThrow()
  })
})
