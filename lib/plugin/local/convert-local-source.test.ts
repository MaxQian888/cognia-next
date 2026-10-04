import { inspectLocalPluginSource } from "./convert-local-source"
import type { LocalSourceFs } from "./local-source-snapshot"

function fakeFs(tree: Record<string, string>): LocalSourceFs {
  const dirs = new Set<string>()
  for (const path of Object.keys(tree)) {
    const parts = path.split("/")
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"))
  }
  return {
    async readDir(path) {
      if (!dirs.has(path)) throw new Error(`ENOENT ${path}`)
      const prefix = `${path}/`
      const names = new Set<string>()
      for (const candidate of [...Object.keys(tree), ...dirs]) {
        if (!candidate.startsWith(prefix)) continue
        names.add(candidate.slice(prefix.length).split("/")[0])
      }
      return [...names]
    },
    async stat(path) {
      if (path in tree) return { size: tree[path].length, isFile: true }
      if (dirs.has(path)) return { size: 0, isFile: false }
      throw new Error(`ENOENT ${path}`)
    },
    async readTextFile(path) {
      if (!(path in tree)) throw new Error(`ENOENT ${path}`)
      return tree[path]
    },
  }
}

const CLAUDE_MANIFEST = JSON.stringify({
  name: "helper",
  description: "A Claude Code plugin",
  version: "1.0.0",
})

describe("inspectLocalPluginSource", () => {
  it("converts a Claude Code bundle the picker used to reject outright", async () => {
    // Load unpacked read <dir>/plugin.json and nothing else, so this exact
    // directory produced a raw error with no hint that it is convertible.
    const result = await inspectLocalPluginSource(
      "/p",
      fakeFs({
        "/p/.claude-plugin/plugin.json": CLAUDE_MANIFEST,
        "/p/skills/review/SKILL.md": "---\nname: review\ndescription: Review code\n---\nBody",
      })
    )
    expect(result.sourceFormat).toBe("claude-code")
    expect(result.native).toBe(false)
    expect(result.convertible).toBe(true)
    expect(result.manifest?.id).toBeTruthy()
    // The installer copies the tree and overlays only what changed.
    expect(Object.keys(result.generatedFiles)).toContain("plugin.json")
  })

  it("produces an overlay the directory installer accepts for MCP configs and dotenv files", async () => {
    const result = await inspectLocalPluginSource(
      "/p",
      fakeFs({
        "/p/.claude-plugin/plugin.json": CLAUDE_MANIFEST,
        "/p/.mcp.json": JSON.stringify({
          mcpServers: { docs: { command: "npx", env: { API_KEY: "local-secret" } } },
        }),
        "/p/.env": "API_KEY=local-secret",
        "/p/skills/review/SKILL.md": "---\nname: review\ndescription: Review code\n---\nBody",
      })
    )
    expect(result.convertible).toBe(true)
    // Only generated entries plus neutralizations of files that already exist.
    expect(Object.keys(result.generatedFiles).sort()).toEqual([
      ".claude-plugin/plugin.json",
      ".env",
      ".mcp.json",
      "dist/index.js",
      "plugin.json",
    ])
    expect(result.generatedFiles[".mcp.json"]).toBe("{}\n")
    expect(result.generatedFiles[".claude-plugin/plugin.json"]).toBe("{}\n")
    expect(result.generatedFiles[".env"]).toBe("\n")
    expect(JSON.stringify(result.generatedFiles)).not.toContain("local-secret")
  })

  it("marks a native bundle as needing no conversion", async () => {
    const result = await inspectLocalPluginSource(
      "/p",
      fakeFs({
        "/p/plugin.json": JSON.stringify({
          id: "native",
          name: "Native",
          version: "1.0.0",
          main: "dist/index.js",
        }),
      })
    )
    expect(result.sourceFormat).toBe("cognia")
    expect(result.native).toBe(true)
    expect(result.convertible).toBe(true)
  })

  it("returns the blocking report instead of throwing it away", async () => {
    // An `UnsupportedPluginConversionError` carries the reason. Letting it
    // propagate would put the dialog back to showing a bare error string.
    const result = await inspectLocalPluginSource(
      "/p",
      fakeFs({
        "/p/.claude-plugin/plugin.json": CLAUDE_MANIFEST,
        "/p/hooks/hooks.json": JSON.stringify({
          hooks: {
            PostMarketplace: [{ hooks: [{ type: "command", command: "echo unsupported" }] }],
          },
        }),
      })
    )
    expect(result.convertible).toBe(false)
    expect(result.manifest).toBeUndefined()
    expect(result.report.blocking.length).toBeGreaterThan(0)
    expect(result.report.blocking.map((issue) => issue.capability)).toContain("commandHooks")
  })

  it("distinguishes an unreadable directory from a directory without a plugin", async () => {
    await expect(inspectLocalPluginSource("/nope", fakeFs({}))).rejects.toThrow(
      /cannot read plugin source directory \/nope:.*ENOENT/
    )
  })

  it("reports malformed native JSON the way the GitHub path does", async () => {
    await expect(
      inspectLocalPluginSource("/p", fakeFs({ "/p/plugin.json": "{ not json" }))
    ).rejects.toThrow("could not parse plugin.json:")
  })
})
