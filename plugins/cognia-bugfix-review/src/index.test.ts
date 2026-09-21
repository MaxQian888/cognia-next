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
        disallowedTools: expect.arrayContaining(["Task", "dispatch_agent"]),
      }),
    ])
    // The skill names the namespaced runtime id (`<plugin>:<subagent>`).
    const skill = readFileSync(join(skillsRoot, "bugfix-review", "SKILL.md"), "utf8")
    expect(skill).toContain("cognia-bugfix-review:bugfix-reviewer")
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

  it("logs activation and deactivation without registering privileged runtime behavior", async () => {
    const info = jest.fn()
    const context = { logger: { info } }

    await definition.activate?.(context as never)
    await definition.deactivate?.(context as never)

    expect(info).toHaveBeenNthCalledWith(1, "cognia-bugfix-review activated")
    expect(info).toHaveBeenNthCalledWith(2, "cognia-bugfix-review deactivated")
  })
})
