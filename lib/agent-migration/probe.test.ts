import { probeVendors } from "./probe"

describe("probeVendors", () => {
  it("combines config-file and environment-aware directory probes", async () => {
    const result = await probeVendors({
      roots: async () => ({
        claudeConfigDir: "/claude",
        codexHome: "/codex",
        opencodeConfigDir: "/opencode",
        opencodeDataDir: "/opencode-data",
      }),
      exists: async (path) => path === "/opencode-data",
      readAgentConfig: async (vendor) => ({
        exists: vendor === "codex",
        path: vendor === "codex" ? "/codex/config.toml" : null,
      }),
    })
    expect(result).toEqual([
      expect.objectContaining({ vendor: "claude-code", installed: false }),
      expect.objectContaining({ vendor: "codex", installed: true }),
      expect.objectContaining({ vendor: "opencode", installed: true }),
    ])
  })
})
