import {
  renderDist,
  renderEntry,
  renderGitignore,
  renderPackageJson,
  renderProject,
  renderReadme,
  renderTsconfig,
} from "./scaffold"
import type { PluginManifest } from "@/types/plugin/plugin"

const MANIFEST = {
  id: "playwright-mcp",
  name: "Playwright",
  version: "0.1.0",
  description: "Browser automation.",
  type: "frontend",
  capabilities: ["mcp-server-preset"],
  main: "dist/index.js",
} as unknown as PluginManifest

describe("renderEntry", () => {
  const entry = renderEntry(MANIFEST, "mcp")

  it("imports the manifest instead of restating it", () => {
    expect(entry).toContain('import manifest from "../plugin.json"')
    // No second copy of any manifest data: the contribution names may
    // appear in prose, but never as an assigned literal.
    expect(entry).not.toMatch(/mcpServerPresets\s*:/)
    expect(entry).not.toMatch(/capabilities\s*:/)
    expect(entry).not.toMatch(/\bid\s*:\s*"/)
  })

  it("registers nothing imperatively", () => {
    expect(entry).not.toContain("registerMcpServerPreset")
    expect(entry).not.toContain("registerSkill")
  })

  it("has no runtime import, so esbuild needs nothing installed", () => {
    const imports = entry.match(/^import .*$/gm) ?? []
    expect(imports).toEqual([
      'import type { PluginContext, PluginDefinition, PluginManifest } from "@cognia/plugin-sdk"',
      'import manifest from "../plugin.json"',
    ])
    // The SDK import is erased at build time; only the manifest survives.
    expect(entry).not.toMatch(/^import \{/m)
  })

  it("explains which host mechanism does the registering", () => {
    expect(renderEntry(MANIFEST, "mcp")).toContain("overlay dispatch")
    expect(renderEntry(MANIFEST, "skill")).toContain("overlay dispatch")
    expect(renderEntry(MANIFEST, "cli")).toContain("plugin manager")
  })
})

describe("renderPackageJson", () => {
  const pkg = JSON.parse(renderPackageJson(MANIFEST))

  it("names the package after the plugin id", () => {
    expect(pkg.name).toBe("playwright-mcp")
    expect(pkg.version).toBe("0.1.0")
  })

  it("builds to the manifest's entry point", () => {
    expect(pkg.scripts.build).toContain("--outfile=dist/index.js")
    expect(pkg.scripts.build).toContain("--format=cjs")
  })

  it("has no runtime dependency, so a fresh directory builds with nothing installed", () => {
    expect(pkg.dependencies).toBeUndefined()
    expect(pkg.devDependencies["@cognia/plugin-sdk"]).toBeTruthy()
    expect(pkg.devDependencies.esbuild).toBeTruthy()
  })
})

describe("renderTsconfig", () => {
  it("enables JSON module resolution so the entry can import the manifest", () => {
    const tsconfig = JSON.parse(renderTsconfig())
    expect(tsconfig.compilerOptions.resolveJsonModule).toBe(true)
    expect(tsconfig.include).toContain("plugin.json")
  })
})

describe("renderGitignore", () => {
  const gitignore = renderGitignore()

  it("does NOT ignore dist — the GitHub installer performs a build-free install", () => {
    expect(gitignore).not.toMatch(/^dist\/$/m)
  })

  it("ignores the signing-key directory", () => {
    expect(gitignore).toMatch(/^\.cognia\/$/m)
  })
})

describe("renderReadme", () => {
  it("lists the outstanding todos when there are any", () => {
    const readme = renderReadme(MANIFEST, "mcp", ["env GITHUB_TOKEN is a credential"])
    expect(readme).toContain("## Before this plugin works")
    expect(readme).toContain("env GITHUB_TOKEN is a credential")
  })

  it("omits the todo section when the conversion is complete", () => {
    expect(renderReadme(MANIFEST, "mcp", [])).not.toContain("## Before this plugin works")
  })

  it("states that nothing was executed and no values were copied", () => {
    const readme = renderReadme(MANIFEST, "mcp", [])
    expect(readme).toMatch(/Nothing was executed/)
    expect(readme).toMatch(/no value from it was\s+copied/)
  })

  it("explains why dist is committed", () => {
    expect(renderReadme(MANIFEST, "mcp", [])).toMatch(/build-free install/)
  })

  it("carries the argv DSL reference for the cli branch", () => {
    const readme = renderReadme(MANIFEST, "cli", [])
    expect(readme).toContain("eachPrefixedBy")
    expect(readme).toContain("successExitCodes")
    expect(readme).toContain("plugins/ripgrep-tools")
  })

  it("explains field placements for the mcp branch", () => {
    const readme = renderReadme(MANIFEST, "mcp", [])
    for (const placement of ["env", "arg-replace", "header", "url"]) {
      expect(readme).toContain(`placement: "${placement}"`)
    }
  })

  it("explains the inline vs local-bundle trade-off for the skill branch", () => {
    const readme = renderReadme(MANIFEST, "skill", [])
    expect(readme).toContain("inline")
    expect(readme).toContain("local-bundle")
    expect(readme).toMatch(/desktop-only/)
  })
})

describe("renderDist", () => {
  const dist = renderDist(MANIFEST)

  it("exports the definition the host loader looks for", () => {
    // `PluginLoader.extractDefinition` reads `exports.default`.
    expect(dist).toContain("module.exports = { __esModule: true, default: definition }")
  })

  it("inlines the manifest so the file needs nothing at runtime", () => {
    expect(dist).not.toMatch(/\brequire\(/)
    expect(dist).not.toMatch(/^\s*import[\s(]/m)
    expect(JSON.parse(dist.match(/const manifest = ([\s\S]*?);\n/)![1])).toEqual(MANIFEST)
  })

  it("tells the reader it is generated and how to refresh it", () => {
    expect(dist).toContain("pnpm build")
  })
})

describe("renderDist ≡ esbuild(renderEntry)", () => {
  /**
   * The pre-generated `dist/index.js` only stays honest if it behaves like
   * what the project's own build produces. This runs the real esbuild over
   * the generated entry — exactly the invocation `package.json`'s build
   * script and `cognia plugin build` use — and compares the two loaded
   * modules.
   */
  const load = (source: string): { default: unknown } => {
    // Both files are CommonJS, so evaluate them with a synthetic module
    // object rather than reaching for a real loader.
    const cjs = { exports: {} as Record<string, unknown> }
    new Function("module", "exports", source)(cjs, cjs.exports)
    return cjs.exports as { default: unknown }
  }

  let esbuildOutput: string

  beforeAll(async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const esbuild = await import("esbuild")

    const dir = mkdtempSync(join(tmpdir(), "cognia-convert-eq-"))
    try {
      mkdirSync(join(dir, "src"))
      writeFileSync(join(dir, "plugin.json"), JSON.stringify(MANIFEST, null, 2))
      writeFileSync(join(dir, "src", "index.ts"), renderEntry(MANIFEST, "mcp"))
      const result = await esbuild.build({
        entryPoints: [join(dir, "src", "index.ts")],
        bundle: true,
        format: "cjs",
        platform: "neutral",
        target: "es2022",
        write: false,
      })
      esbuildOutput = result.outputFiles[0].text
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("both modules expose a default export with the same manifest", () => {
    const built = load(esbuildOutput).default as { manifest: unknown }
    const preGenerated = load(renderDist(MANIFEST)).default as { manifest: unknown }
    expect(preGenerated.manifest).toEqual(built.manifest)
    expect(preGenerated.manifest).toEqual(MANIFEST)
  })

  it("both modules expose the same lifecycle surface", () => {
    const built = load(esbuildOutput).default as Record<string, unknown>
    const preGenerated = load(renderDist(MANIFEST)).default as Record<string, unknown>
    expect(Object.keys(preGenerated).sort()).toEqual(Object.keys(built).sort())
    expect(typeof preGenerated.activate).toBe("function")
    expect(typeof preGenerated.deactivate).toBe("function")
  })

  it("both activate implementations log the same line", async () => {
    const calls: string[] = []
    const ctx = { logger: { info: (m: string) => calls.push(m) } }
    const built = load(esbuildOutput).default as {
      activate: (c: unknown) => Promise<void>
    }
    const preGenerated = load(renderDist(MANIFEST)).default as {
      activate: (c: unknown) => Promise<void>
    }
    await built.activate(ctx)
    await preGenerated.activate(ctx)
    expect(calls).toEqual(["playwright-mcp activated", "playwright-mcp activated"])
  })
})

describe("renderProject", () => {
  const files = renderProject(MANIFEST, "mcp", [])

  it("emits an installable project, build output included", () => {
    expect([...files.keys()].sort()).toEqual([
      ".gitignore",
      "README.md",
      "dist/index.js",
      "package.json",
      "plugin.json",
      "src/index.ts",
      "tsconfig.json",
    ])
  })

  it("ships the file manifest.main points at, so the project installs as generated", () => {
    expect(files.has(MANIFEST.main!)).toBe(true)
  })

  it("writes the manifest verbatim", () => {
    expect(JSON.parse(files.get("plugin.json")!)).toEqual(MANIFEST)
  })
})
