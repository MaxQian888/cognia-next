import { probeVendors } from "./probe"

describe("probeVendors", () => {
  it("combines config-file and environment-aware directory probes", async () => {
    const result = await probeVendors({
      roots: async () => ({
        claudeConfigDir: "/claude",
        codexHome: "/codex",
        opencodeConfigDir: "/opencode",
        opencodeDataDir: "/opencode-data",
        piAgentDir: "/pi/agent",
        piSessionDir: "/pi/agent/sessions",
        geminiDir: "/gemini",
        continueDir: "/continue",
      }),
      exists: async (path) => path === "/opencode-data" || path === "/pi/agent",
      readAgentConfig: async (vendor) => ({
        exists: vendor === "codex",
        path: vendor === "codex" ? "/codex/config.toml" : null,
      }),
    })
    expect(result).toEqual([
      expect.objectContaining({ vendor: "claude-code", installed: false }),
      expect.objectContaining({ vendor: "codex", installed: true }),
      expect.objectContaining({ vendor: "opencode", installed: true }),
      // Pi has no config file the probe can read, so the directory probe is
      // the only signal that it is installed.
      expect.objectContaining({ vendor: "pi", installed: true }),
    ])
  })

  it("reports Pi as absent when its agent dir does not exist", async () => {
    const result = await probeVendors({
      roots: async () => ({
        claudeConfigDir: "",
        codexHome: "",
        opencodeConfigDir: "",
        opencodeDataDir: "",
        piAgentDir: "/pi/agent",
        piSessionDir: "/pi/agent/sessions",
        geminiDir: "",
        continueDir: "",
      }),
      exists: async () => false,
      readAgentConfig: async () => ({ exists: false, path: null }),
    })
    expect(result.find((r) => r.vendor === "pi")?.installed).toBe(false)
  })
})
