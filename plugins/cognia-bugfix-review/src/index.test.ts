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

describe("cognia-bugfix-review plugin", () => {
  it("declares a permissionless desktop skill + subagent contribution", () => {
    expect(manifest).toMatchObject({
      id: "cognia-bugfix-review",
      type: "frontend",
      capabilities: ["skills", "subagent"],
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
        id: "cognia-bugfix-review:bugfix-review",
        source: { kind: "local-bundle", path: "skills/bugfix-review" },
      }),
    ])
  })

  it("declares the isolated reviewer subagent the skill delegates to", () => {
    expect(manifest.subagents).toEqual([
      expect.objectContaining({
        id: "bugfix-reviewer",
        disallowedTools: expect.arrayContaining([
          "Task",
          "dispatch_agent",
          "Edit",
          "Write",
          "NotebookEdit",
        ]),
      }),
    ])
    // The skill names the namespaced runtime id (`<plugin>:<subagent>`).
    const skill = readFileSync(join(skillsRoot, "bugfix-review", "SKILL.md"), "utf8")
    expect(skill).toContain("cognia-bugfix-review:bugfix-reviewer")
  })

  it("answers in the user's language and never writes into the reviewed repository", () => {
    const prompt = manifest.subagents[0].prompt
    expect(prompt).toContain("## Language")
    expect(prompt).toContain("Fixed (per static evidence)")
    expect(prompt).toContain("artifact_create")
    expect(prompt).toContain("Never write the report into the reviewed workspace")
    expect(prompt).not.toMatch(/Chinese-first/)
    expect(prompt).not.toMatch(/artifacts directory/)
    expect(manifest.description).not.toMatch(/Chinese-first/)
    const skill = readFileSync(join(skillsRoot, "bugfix-review", "SKILL.md"), "utf8")
    expect(skill).not.toMatch(/artifacts directory/)
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

  it("keeps the platform-specific capture mechanism the port removed out of every shipped file", () => {
    const forbidden = [
      /CLAUDE_PLUGIN_ROOT/,
      /CODEX_PLUGIN_ROOT/,
      /AIDEN_/,
      /SDMA_SERVER_RUN_ID/,
      /\.aiden\//,
      /abr-isolated-worker/,
      /aiden-code-review|aiden-bugfix-review/,
      /\/root\/sdma/,
    ]

    const offenders = [join(pluginRoot, "plugin.json"), ...listFiles(skillsRoot)].filter((path) => {
      const body = readFileSync(path, "utf8")
      return forbidden.some((pattern) => pattern.test(body))
    })

    expect(offenders).toEqual([])
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
    expect(readme).toContain("cognia plugin build --path plugins/cognia-bugfix-review")
    expect(readme).toContain("cognia plugin install")
  })

  it("gives every skill a namespaced id, a slug, and a user-facing name", () => {
    for (const skill of manifest.skills) {
      expect(skill.id).toBe(`cognia-bugfix-review:${skill.slug}`)
      expect(skill.name).not.toBe(skill.slug)
      expect(skill.description.length).toBeGreaterThan(40)
    }
  })
})
