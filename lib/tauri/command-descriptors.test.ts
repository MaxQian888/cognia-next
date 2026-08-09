import { getCommandDescriptor, getCommandManifest } from "./command-descriptors"

describe("companion command descriptors", () => {
  it("loads a unique, capability-complete manifest", () => {
    const manifest = getCommandManifest()
    const names = manifest.commands.map((command) => command.name)

    expect(manifest.schemaVersion).toBe(2)
    expect(names.length).toBeGreaterThanOrEqual(900)
    expect(new Set(names).size).toBe(names.length)
    expect(manifest.commands.every((command) => command.capability.length > 0)).toBe(true)
  })

  it("does not expose the retired renderer-owned MCP process probe", () => {
    expect(getCommandDescriptor("test_mcp_server")).toBeUndefined()
  })

  it("keeps client-owned definitions local and service commands internal", () => {
    expect(getCommandDescriptor("app_settings_update")?.target).toBe("client")
    expect(getCommandDescriptor("keyring_secret_get")?.target).toBe("service")
    expect(getCommandDescriptor("secret_store_get")?.target).toBe("service")
    expect(getCommandDescriptor("plugin_set_status")?.target).toBe("service")
    expect(getCommandDescriptor("git_status")?.target).toBe("execution")
  })
})
