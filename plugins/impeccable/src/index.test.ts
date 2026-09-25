import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

import { createTestPluginContext } from "@cognia/plugin-sdk/testing"

import definition, { manifest as moduleManifest } from "./index"
import manifest from "../plugin.json"

const pluginRoot = resolve(__dirname, "..")
const skillRoot = join(pluginRoot, "skills", "impeccable")

function listFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })
}

describe("cognia-impeccable plugin", () => {
  it("declares a permissionless desktop skill contribution", () => {
    expect(manifest).toMatchObject({
      id: "cognia-impeccable",
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
        id: "cognia-impeccable:impeccable",
        slug: "impeccable",
        name: "Impeccable (frontend design)",
        source: { kind: "local-bundle", path: "skills/impeccable" },
        // The detector scripts run through Bash and the references are Read.
        allowedTools: ["Bash", "Read"],
      }),
    ])
  })

  it("packages every local-bundle resource and only existing allowlist paths", () => {
    const included = new Set(manifest.bundle_include)
    const resources = listFiles(skillRoot).map((path) =>
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

  it("binds resources through the Cognia plugin root and omits unsafe automation", () => {
    const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8")

    expect(skill).toContain("${COGNIA_PLUGIN_ROOT}/skills/impeccable/")
    expect(skill).toContain("implementation scripts are not shipped")
    expect(existsSync(join(skillRoot, "scripts", "live-server.mjs"))).toBe(false)
    expect(existsSync(join(skillRoot, "scripts", "hook.mjs"))).toBe(false)
    expect(existsSync(join(skillRoot, "scripts", "pin.mjs"))).toBe(false)
    expect(existsSync(join(skillRoot, "reference", "live.md"))).toBe(false)
    expect(existsSync(join(skillRoot, "reference", "hooks.md"))).toBe(false)
  })

  it("carries no upstream install paths or instructions for unshipped features", () => {
    // The reference docs are what the agent reads verbatim: an upstream
    // `.agents/skills/...` invocation or a link to a deliberately unshipped
    // file (live server, hooks, pin/unpin, the live-only manual-edit
    // applier) fails at runtime in the user's project. Scripts that *detect*
    // upstream installs left behind in a project are exempt — scanning user
    // config for those paths is their job.
    const detectionAllowlist = new Set([
      "skills/impeccable/scripts/context.mjs",
      "skills/impeccable/scripts/lib/staleness-deep.mjs",
    ])
    const forbidden = [
      /\.agents\/skills\/impeccable/,
      /\.claude\/skills\/impeccable/,
      /live-server\.mjs/,
      /live-poll\.mjs/,
      /live-commit-manual-edits\.mjs/,
      /scripts\/hook(-before-edit)?\.mjs/,
      /scripts\/pin\.mjs/,
      /\blive\.md\b/,
      /\bhooks\.md\b/,
      /manual.edit.applier/i,
      /\$impeccable live\b/,
    ]

    const offenders = listFiles(skillRoot)
      .map((path) => relative(pluginRoot, path).split(sep).join("/"))
      .filter((path) => !detectionAllowlist.has(path))
      .filter((path) => {
        const body = readFileSync(join(pluginRoot, path), "utf8")
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

  it("documents that main is build output the plugin needs before it can load", () => {
    expect(manifest.main).toBe("dist/index.js")
    const readme = readFileSync(join(pluginRoot, "README.md"), "utf8")
    expect(readme).toContain("pnpm exec node plugins/impeccable/build.mjs")
    expect(readme).toContain("cannot load")
    expect(readme).not.toMatch(/attach the `impeccable` skill to a character/)
  })
})
