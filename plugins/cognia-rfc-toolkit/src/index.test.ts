import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

import { createTestPluginContext } from "@cognia/plugin-sdk/testing"

import definition, { manifest as moduleManifest } from "./index"
import manifest from "../plugin.json"

const pluginRoot = resolve(__dirname, "..")
const skillsRoot = join(pluginRoot, "skills")

function listFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })
}

describe("cognia-rfc-toolkit plugin", () => {
  it("declares a permissionless desktop skill contribution", () => {
    expect(manifest).toMatchObject({
      id: "cognia-rfc-toolkit",
      type: "frontend",
      capabilities: ["skills"],
      permissions: [],
      activationEvents: ["startup"],
      runtimeCompatibility: {
        browser: { availability: "blocked" },
        tauri: { availability: "supported" },
        mobile: { availability: "blocked" },
      },
    })
    expect(manifest.skills).toEqual([
      expect.objectContaining({
        id: "cognia-rfc-toolkit:rfc-write-plan",
        source: { kind: "local-bundle", path: "skills/rfc-write-plan" },
      }),
      expect.objectContaining({
        id: "cognia-rfc-toolkit:rfc-reflect",
        source: { kind: "local-bundle", path: "skills/rfc-reflect" },
      }),
      expect.objectContaining({
        id: "cognia-rfc-toolkit:mermaid-visualizer",
        source: { kind: "local-bundle", path: "skills/mermaid-visualizer" },
      }),
    ])
  })

  it("packages every skill resource and only existing allowlist paths", () => {
    const included = new Set(manifest.bundle_include)
    const resources = listFiles(skillsRoot).map((path) =>
      relative(pluginRoot, path).split(sep).join("/")
    )

    expect(resources.filter((path) => !included.has(path))).toEqual([])
    expect(
      manifest.bundle_include.filter(
        (path) => path.startsWith("/") || path.split("/").includes("..")
      )
    ).toEqual([])
    expect(manifest.bundle_include.filter((path) => !existsSync(join(pluginRoot, path)))).toEqual(
      []
    )
  })

  it("binds resources through the Cognia plugin root with no foreign-ecosystem tokens", () => {
    const plan = readFileSync(join(skillsRoot, "rfc-write-plan", "SKILL.md"), "utf8")
    const mermaid = readFileSync(join(skillsRoot, "mermaid-visualizer", "SKILL.md"), "utf8")

    expect(plan).toContain("${COGNIA_PLUGIN_ROOT}/skills/rfc-write-plan/references/")
    expect(mermaid).toContain("${COGNIA_PLUGIN_ROOT}/skills/mermaid-visualizer/references/")

    // Leftover foreign-ecosystem root tokens resolve to nothing at runtime.
    for (const body of [plan, mermaid]) {
      expect(body).not.toContain("${CLAUDE_PLUGIN_ROOT}")
      expect(body).not.toContain("${CODEX_PLUGIN_ROOT}")
    }
  })

  it("keeps the vendor-specific tooling the port removed out of every shipped file", () => {
    const forbidden = [
      /CLAUDE_PLUGIN_ROOT/,
      /CODEX_PLUGIN_ROOT/,
      /AIDEN_/,
      /SDMA_/,
      /bytedcli/,
      /RepoSearch|MediaSearch|SearchCodebase|ReadCodeFiles/,
      /bytedance-deepwiki|mcp__search_knowledge/,
      /bam-fetch|\bpsm\b/i,
      /D2C|GenUICode/,
      /Skill\(skill_name=/,
    ]

    const offenders = listFiles(skillsRoot).filter((path) => {
      const body = readFileSync(path, "utf8")
      return forbidden.some((pattern) => pattern.test(body))
    })

    expect(offenders).toEqual([])
  })

  it("loads each task guide and template the write-plan skill references", () => {
    for (const file of [
      "bugfix-guide.txt",
      "bugfix-template.md",
      "newfeature-guide.txt",
      "newfeature-template.md",
      "refactor.txt",
      "refactor-template.md",
    ]) {
      expect(existsSync(join(skillsRoot, "rfc-write-plan", "references", file))).toBe(true)
    }
    expect(
      existsSync(join(skillsRoot, "mermaid-visualizer", "references", "syntax-rules.md"))
    ).toBe(true)
  })

  it("adopts plugin.json verbatim and registers nothing imperatively", async () => {
    expect(moduleManifest).toBe(manifest)
    const { ctx, calls } = createTestPluginContext({ pluginId: manifest.id })
    await definition.activate(ctx)
    expect(calls).toEqual([])
    expect(definition.deactivate).toBeUndefined()
  })

  it("is installable: main is the CLI build output, never the TypeScript source", () => {
    // The desktop loader evaluates `main` as CommonJS, and `cognia plugin
    // build` writes its esbuild output to `main` — pointing it at
    // src/index.ts made the build refuse to overwrite its own input.
    expect(manifest.main).toBe("dist/index.js")
    expect(manifest.runtimeCompatibility.tauri.entrypoint).toBe("dist/index.js")
    expect(manifest.bundle_include).not.toContain("src/index.ts")
    const readme = readFileSync(join(pluginRoot, "README.md"), "utf8")
    expect(readme).toContain("cognia plugin build --path plugins/cognia-rfc-toolkit")
    expect(readme).toContain("cognia plugin install")
  })

  it("gives every skill a namespaced id, a slug, and a user-facing name", () => {
    for (const skill of manifest.skills) {
      expect(skill.id).toBe(`cognia-rfc-toolkit:${skill.slug}`)
      expect(skill.name).not.toBe(skill.slug)
      expect(skill.description.length).toBeGreaterThan(40)
    }
  })
})
