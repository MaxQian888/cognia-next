import { getCommandDescriptor, getCommandManifest } from "./command-descriptors"

describe("companion command descriptors", () => {
  it("loads a unique, capability-complete manifest", () => {
    const manifest = getCommandManifest()
    const names = manifest.commands.map((command) => command.name)

    expect(manifest.schemaVersion).toBe(1)
    expect(names.length).toBeGreaterThanOrEqual(900)
    expect(new Set(names).size).toBe(names.length)
    expect(manifest.commands.every((command) => command.capability.length > 0)).toBe(true)
  })

  it("classifies arbitrary MCP process probing as critical signed policy", () => {
    expect(getCommandDescriptor("test_mcp_server")).toEqual(
      expect.objectContaining({
        target: "service",
        capability: "process.spawn",
        risk: "critical",
        approval: "signed-policy",
        idempotency: "required",
      })
    )
  })

  it("keeps client-owned definitions local and service commands internal", () => {
    expect(getCommandDescriptor("app_settings_update")?.target).toBe("client")
    expect(getCommandDescriptor("keyring_secret_get")?.target).toBe("service")
    expect(getCommandDescriptor("git_status")?.target).toBe("execution")
  })
})
