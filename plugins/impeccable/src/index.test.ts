import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

import definition from "./index"
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
        id: "impeccable",
        source: { kind: "local-bundle", path: "skills/impeccable" },
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

  it("logs activation and deactivation without registering privileged runtime behavior", async () => {
    const info = jest.fn()
    const context = { logger: { info } }

    await definition.activate?.(context as never)
    await definition.deactivate?.(context as never)

    expect(info).toHaveBeenNthCalledWith(1, "cognia-impeccable activated")
    expect(info).toHaveBeenNthCalledWith(2, "cognia-impeccable deactivated")
  })
})
