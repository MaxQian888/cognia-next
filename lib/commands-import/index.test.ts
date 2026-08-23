import { previewCommandsImport } from "./index"

describe("previewCommandsImport", () => {
  it("marks Claude Code commands as already shared", async () => {
    await expect(previewCommandsImport("claude-code", {} as never)).resolves.toMatchObject({
      shared: true,
      drafts: [],
    })
  })

  it("scans the current OpenCode commands directory", async () => {
    const walkFiles = jest.fn(async () => ["/oc/commands/review.md"])
    const result = await previewCommandsImport("opencode", {
      roots: async () => ({
        claudeConfigDir: "/claude",
        codexHome: "/codex",
        opencodeConfigDir: "/oc",
        opencodeDataDir: "/data",
        piAgentDir: "",
        piSessionDir: "",
        geminiDir: "",
        continueDir: "",
      }),
      fs: { readTextFile: jest.fn(async () => "Review") } as never,
      walkFiles,
    })
    expect(walkFiles).toHaveBeenCalledWith(expect.anything(), "/oc/commands", expect.any(Function))
    expect(result.drafts[0]).toMatchObject({ name: "review", source: "opencode" })
  })

  it("does not scan when the configured vendor root is unavailable", async () => {
    const walkFiles = jest.fn()
    const result = await previewCommandsImport("codex", {
      roots: async () => ({
        claudeConfigDir: "/claude",
        codexHome: "",
        opencodeConfigDir: "/oc",
        opencodeDataDir: "/data",
        piAgentDir: "",
        piSessionDir: "",
        geminiDir: "",
        continueDir: "",
      }),
      fs: {} as never,
      walkFiles,
    })

    expect(walkFiles).not.toHaveBeenCalled()
    expect(result).toMatchObject({ drafts: [], warnings: ["Source root is unavailable."] })
  })
})
