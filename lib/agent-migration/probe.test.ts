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

  it("prefers OpenCode's data dir over its config dir, and falls back to it", async () => {
    // The ordering used to be an `||` in a hand-written map. It now comes from
    // the ecosystem catalog's `probeRootKeys`, so this pins that the order
    // survived the move: data dir first, config dir only when it is empty.
    const probed: string[] = []
    const run = async (opencodeDataDir: string, opencodeConfigDir: string) => {
      probed.length = 0
      return probeVendors({
        roots: async () => ({
          claudeConfigDir: "",
          codexHome: "",
          opencodeConfigDir,
          opencodeDataDir,
          piAgentDir: "",
          piSessionDir: "",
          geminiDir: "",
          continueDir: "",
        }),
        exists: async (path) => {
          probed.push(path)
          return true
        },
        readAgentConfig: async () => ({ exists: false, path: null }),
      })
    }

    await run("/opencode-data", "/opencode-config")
    expect(probed).toContain("/opencode-data")
    expect(probed).not.toContain("/opencode-config")

    await run("", "/opencode-config")
    expect(probed).toContain("/opencode-config")
  })
})
