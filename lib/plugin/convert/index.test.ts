import { convert, listCandidates } from "./index"
import type { PluginManifest } from "@/types/plugin/plugin"

const MCP_CONFIG = JSON.stringify({
  mcpServers: {
    playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
    github: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "ghp_live_secret" },
    },
    deepwiki: { type: "http", url: "https://mcp.deepwiki.com/mcp" },
  },
})

const SKILL_MD = `---
name: Code Review
description: Review a diff.
---

Read the diff, report findings.
`

describe("listCandidates", () => {
  it("lists MCP servers", () => {
    expect(
      listCandidates({ kind: "mcp", text: MCP_CONFIG, sourceName: ".cursor/mcp.json" }).map(
        (c) => c.id
      )
    ).toEqual(["playwright", "github", "deepwiki"])
  })

  it("lists the single skill in a folder", () => {
    expect(listCandidates({ kind: "skill", text: SKILL_MD, sourceName: "cr" })[0].id).toBe(
      "code-review"
    )
  })

  it("lists the binary for a cli source", () => {
    expect(listCandidates({ kind: "cli", binary: "rg" })[0].id).toBe("rg")
  })

  it("explains what is missing when the source text was not supplied", () => {
    expect(() => listCandidates({ kind: "mcp" })).toThrow(/needs the source file's contents/)
  })
})

describe("convert — mcp, greenfield", () => {
  const result = convert(
    { kind: "mcp", text: MCP_CONFIG, sourceName: ".cursor/mcp.json", pick: "github" },
    { hostVersion: "1.4.0", gitAuthor: "Ada" }
  )

  it("produces a complete, installable project layout", () => {
    expect(result.mode).toBe("create")
    expect([...result.files.keys()].sort()).toEqual([
      ".gitignore",
      "README.md",
      "dist/index.js",
      "package.json",
      "plugin.json",
      "src/index.ts",
      "tsconfig.json",
    ])
  })

  it("derives the plugin id from the picked server", () => {
    expect(result.pluginId).toBe("github-mcp")
  })

  it("declares exactly the capability it contributes", () => {
    expect(result.manifest.capabilities).toEqual(["mcp-server-preset"])
    expect(result.manifest.mcpServerPresets).toHaveLength(1)
  })

  it("blocks browser and mobile because the server is spawned as a process", () => {
    expect(result.manifest.runtimeCompatibility?.browser?.availability).toBe("blocked")
    expect(result.manifest.runtimeCompatibility?.mobile?.availability).toBe("blocked")
    expect(result.manifest.runtimeCompatibility?.tauri?.availability).toBe("supported")
  })

  it("leaks no credential into ANY generated file", () => {
    for (const [path, contents] of result.files) {
      expect(`${path}:${contents}`).not.toContain("ghp_live_secret")
    }
  })

  it("tells the author which value they must now supply", () => {
    expect(result.todos.join(" ")).toContain("GITHUB_TOKEN")
  })

  it("leaks no machine-specific path into ANY generated file, description included", () => {
    // Regression: the preset description was once rendered from the raw
    // config, which put the author's home directory into plugin.json,
    // package.json, and README.md even though `args` had been tokenized.
    const withPath = convert({
      kind: "mcp",
      pick: "fs",
      text: JSON.stringify({
        mcpServers: {
          fs: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/ada/Documents"],
          },
        },
      }),
    })
    for (const [path, contents] of withPath.files) {
      expect(`${path}:${contents}`).not.toContain("/Users/ada")
    }
  })

  it("generates no signing material", () => {
    expect(JSON.stringify([...result.files.values()])).not.toMatch(/publicKey|PRIVATE KEY/)
  })

  it("keeps a remote http server portable across all three shells", () => {
    const remote = convert({ kind: "mcp", text: MCP_CONFIG, pick: "deepwiki" })
    expect(remote.manifest.runtimeCompatibility?.browser?.availability).toBe("supported")
    expect(remote.manifest.runtimeCompatibility?.mobile?.availability).toBe("supported")
  })

  it("requires --pick when the file holds several servers", () => {
    expect(() => convert({ kind: "mcp", text: MCP_CONFIG })).toThrow(/--pick is required/)
  })

  it("honours identity overrides", () => {
    const custom = convert({
      kind: "mcp",
      text: MCP_CONFIG,
      pick: "playwright",
      identity: { id: "my.browser", name: "My Browser", version: "2.0.0" },
    })
    expect(custom.pluginId).toBe("my.browser")
    expect(custom.manifest.name).toBe("My Browser")
    expect(custom.manifest.version).toBe("2.0.0")
  })
})

describe("convert — skill, greenfield", () => {
  it("inlines a resource-free skill and stays portable", () => {
    const result = convert({ kind: "skill", text: SKILL_MD, sourceName: "cr" })
    expect(result.pluginId).toBe("code-review-skill")
    expect(result.manifest.capabilities).toEqual(["skills"])
    expect(result.manifest.skills?.[0].source).toEqual({
      kind: "inline",
      markdown: expect.stringContaining("Read the diff"),
    })
    expect(result.manifest.runtimeCompatibility?.mobile?.availability).toBe("supported")
    expect(result.copies).toEqual([])
  })

  it("bundles a resource-bearing skill and marks it desktop-only", () => {
    const result = convert({
      kind: "skill",
      text: SKILL_MD,
      sourceName: "cr",
      resources: ["references/checklist.md"],
    })
    expect(result.manifest.skills?.[0].source).toEqual({
      kind: "local-bundle",
      path: "skills/code-review",
    })
    expect(result.manifest.runtimeCompatibility?.browser?.availability).toBe("blocked")
    expect(result.copies).toEqual([
      { from: "SKILL.md", to: "skills/code-review/SKILL.md" },
      { from: "references/checklist.md", to: "skills/code-review/references/checklist.md" },
    ])
  })
})

describe("convert — cli, greenfield", () => {
  const result = convert({ kind: "cli", binary: "rg" })

  it("declares the capability, permission, and binary requirement", () => {
    expect(result.pluginId).toBe("rg-tools")
    expect(result.manifest.capabilities).toEqual(["cli-tools"])
    expect(result.manifest.permissions).toEqual(["cli:execute"])
    expect(result.manifest.requires).toEqual({ binaries: [{ name: "rg" }] })
  })

  it("ships an EMPTY cliTools table, which the host validator flags as unfinished", () => {
    expect(result.manifest.cliTools).toEqual([])
  })

  it("hands the author the argv DSL reference", () => {
    expect(result.files.get("README.md")).toContain("eachPrefixedBy")
  })
})

describe("convert — merge into an existing plugin", () => {
  const existing = JSON.stringify({
    id: "my-plugin",
    name: "My Plugin",
    version: "1.2.3",
    description: "Existing.",
    type: "frontend",
    capabilities: ["commands"],
    main: "dist/index.js",
    permissions: [],
  })

  it("rewrites only plugin.json", () => {
    const result = convert(
      { kind: "mcp", text: MCP_CONFIG, pick: "playwright" },
      { existingManifestText: existing, existingManifestPath: "my-plugin/plugin.json" }
    )
    expect(result.mode).toBe("merge")
    expect([...result.files.keys()]).toEqual(["plugin.json"])
    expect(result.pluginId).toBe("my-plugin")
    const manifest = JSON.parse(result.files.get("plugin.json")!) as PluginManifest
    expect(manifest.version).toBe("1.2.3")
    expect(manifest.capabilities).toEqual(["commands", "mcp-server-preset"])
    expect(manifest.mcpServerPresets).toHaveLength(1)
  })

  it("renames the contribution with --id, since the plugin id is fixed by the target", () => {
    const result = convert(
      { kind: "mcp", text: MCP_CONFIG, pick: "playwright", identity: { id: "browser" } },
      { existingManifestText: existing }
    )
    const manifest = JSON.parse(result.files.get("plugin.json")!) as PluginManifest
    expect(result.pluginId).toBe("my-plugin")
    expect(manifest.mcpServerPresets?.[0].id).toBe("browser")
  })

  it("lets --id resolve an id collision", () => {
    const occupied = JSON.stringify({
      ...JSON.parse(existing),
      capabilities: ["mcp-server-preset"],
      mcpServerPresets: [{ id: "playwright" }],
    })
    expect(() =>
      convert(
        { kind: "mcp", text: MCP_CONFIG, pick: "playwright" },
        {
          existingManifestText: occupied,
        }
      )
    ).toThrow(/already contains an entry with id "playwright"/)

    const resolved = convert(
      { kind: "mcp", text: MCP_CONFIG, pick: "playwright", identity: { id: "playwright-2" } },
      { existingManifestText: occupied }
    )
    const manifest = JSON.parse(resolved.files.get("plugin.json")!) as PluginManifest
    expect(manifest.mcpServerPresets?.map((p) => p.id)).toEqual(["playwright", "playwright-2"])
  })

  it("merges a skill the same way", () => {
    const result = convert(
      { kind: "skill", text: SKILL_MD, sourceName: "cr" },
      { existingManifestText: existing }
    )
    const manifest = JSON.parse(result.files.get("plugin.json")!) as PluginManifest
    expect(manifest.skills).toHaveLength(1)
  })

  it("refuses --into for a cli source, which contributes nothing to merge", () => {
    expect(() =>
      convert({ kind: "cli", binary: "rg" }, { existingManifestText: existing })
    ).toThrow(/--into is not supported for --from cli/)
  })
})
