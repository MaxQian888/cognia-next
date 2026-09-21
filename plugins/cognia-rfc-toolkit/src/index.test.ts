import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

import definition from "./index"
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

  it("logs activation and deactivation without registering privileged runtime behavior", async () => {
    const info = jest.fn()
    const context = { logger: { info } }

    await definition.activate?.(context as never)
    await definition.deactivate?.(context as never)

    expect(info).toHaveBeenNthCalledWith(1, "cognia-rfc-toolkit activated")
    expect(info).toHaveBeenNthCalledWith(2, "cognia-rfc-toolkit deactivated")
  })
})
