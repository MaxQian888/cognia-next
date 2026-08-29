import { getCommandDescriptor, getCommandManifest, isLocalOnlyCommand } from "./command-descriptors"

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

  it("classifies host settings as execution-owned and service commands as internal", () => {
    expect(getCommandDescriptor("app_settings_update")?.target).toBe("execution")
    expect(getCommandDescriptor("keyring_secret_get")?.target).toBe("service")
    expect(getCommandDescriptor("secret_store_get")?.target).toBe("service")
    expect(getCommandDescriptor("plugin_set_status")?.target).toBe("service")
    expect(getCommandDescriptor("git_status")?.target).toBe("execution")
  })

  it("requires an interactive host lease for critical external-agent configuration", () => {
    for (const name of [
      "external_agent_config_create",
      "external_agent_config_delete",
      "external_agent_config_get",
      "external_agent_config_list",
      "external_agent_config_reconcile",
      "external_agent_config_update",
      "external_agent_list",
      "external_agent_update",
    ]) {
      expect(getCommandDescriptor(name)).toMatchObject({
        target: "execution",
        capability: "process.spawn",
        risk: "critical",
        approval: "interactive",
      })
    }
  })

  describe("isLocalOnlyCommand", () => {
    it("names every client-target command, and nothing else", () => {
      // Derived from the manifest rather than a hand-kept list: the predicate's
      // whole value is that it cannot drift from what the Host enforces.
      const manifest = getCommandManifest()
      const clientTargets = manifest.commands.filter((command) => command.target === "client")
      const reachable = manifest.commands.filter((command) => command.target !== "client")

      expect(clientTargets.length).toBeGreaterThan(0)
      expect(clientTargets.every((command) => isLocalOnlyCommand(command.name))).toBe(true)
      expect(reachable.some((command) => isLocalOnlyCommand(command.name))).toBe(false)
    })

    it("holds for the sandbox probes, which a paired host can never answer", () => {
      // The concrete regression: a browser paired to a cognia-server sent these
      // over HTTP every poll and collected a 403 each time.
      for (const name of ["sandbox_health_check", "sandbox_health_probe", "sandbox_exec"]) {
        expect(getCommandDescriptor(name)?.transports).toEqual(["internal"])
        expect(isLocalOnlyCommand(name)).toBe(true)
      }
    })

    it("treats an unknown command as reachable, leaving the refusal to the host", () => {
      // A name this build has no descriptor for may be one a newer Host knows.
      // Refusing it locally would make a forward-compatible call unreachable.
      expect(isLocalOnlyCommand("some_command_from_a_newer_host")).toBe(false)
    })
  })
})
