/** @cognia-host-integration-test — validates plugin.json with the host's real validator. */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { buildArgv } from "@cognia/plugin-sdk"
import type { PluginCliArgvToken } from "@cognia/plugin-sdk"
import { validatePluginManifest } from "@/lib/plugin/core/validation"
import type { PluginManifest } from "@/types/plugin"

import manifestJson from "./plugin.json"

const pluginRoot = __dirname
const vendorRoot = join(pluginRoot, "vendor")
const manifest = manifestJson as unknown as PluginManifest
const raw = manifestJson as unknown as Record<string, unknown>

const CLI_ENTRY = "${COGNIA_PLUGIN_ROOT}/vendor/packages/cli/src/bin.ts"
const binSource = readFileSync(join(vendorRoot, "packages/cli/src/bin.ts"), "utf8")

interface CliToolJson {
  name: string
  description: string
  descriptionKey?: string
  access?: string
  confinedPathParams?: string[]
  parameters: {
    type: string
    properties: Record<string, { type: string; pattern?: string; enum?: string[] }>
    required?: string[]
    additionalProperties?: boolean
  }
  binary: { kind: string; name?: string }
  argv: PluginCliArgvToken[]
  cwd?: { kind: string }
  env?: Record<string, string>
  outputParse?: string
  successExitCodes?: number[]
  timeoutMs?: number
}

const cliTools = (raw.cliTools as CliToolJson[]) ?? []
const toolByName = new Map(cliTools.map((tool) => [tool.name, tool]))

function literals(tool: CliToolJson): string[] {
  return tool.argv.flatMap((token) => ("literal" in token ? [token.literal] : []))
}
function flagPrefixes(tool: CliToolJson): string[] {
  return tool.argv.flatMap((token) =>
    "param" in token && token.eachPrefixedBy ? [token.eachPrefixedBy] : []
  )
}
function commandOf(tool: CliToolJson): string {
  return literals(tool)[1]!
}

/** `KNOWN_FLAGS` of the vendored CLI — the closed flag set it accepts. */
function upstreamKnownFlags(): Set<string> {
  const block = /const KNOWN_FLAGS[^=]*= new Set\(\[([\s\S]*?)\]\)/.exec(binSource)
  if (!block) throw new Error("KNOWN_FLAGS not found in vendored bin.ts")
  return new Set([...block[1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!))
}

/** Every command spelling the vendored CLI dispatches: flat aliases + top-level cases. */
function upstreamCommands(): Set<string> {
  const flat = /const FLAT_COMMANDS[^=]*=\s*\{([\s\S]*?)\};/.exec(binSource)
  if (!flat) throw new Error("FLAT_COMMANDS not found in vendored bin.ts")
  const flatNames = [...flat[1]!.matchAll(/"([a-z-]+)":/g)].map((m) => m[1]!)
  const topLevel = [...binSource.matchAll(/command === "([a-z-]+)"|case "([a-z-]+)":/g)].map(
    (m) => m[1] ?? m[2]!
  )
  return new Set([...flatNames, ...topLevel])
}

/** Commands the Cognia surface exposes — the reviewed, operator-safe set. */
const EXPOSED_COMMANDS = [
  "doctor",
  "import",
  "inspect",
  "jobs",
  "build",
  "check-run",
  "check-report",
  "render-pages",
  "render-text",
  "artifact-save",
  "materialize",
  "patch-propose",
  "patch-show",
  "patch-apply",
  "patch-revert",
  "release-prepare",
  "release-freeze",
  "release-package",
  "release-status",
  "release-list",
  "workflow-start",
  "workflow-status",
  "workflow-list",
  "workflow-resume",
  "workflow-cancel",
  "assets-inspect",
  "review-coverage",
]

/**
 * Never exposed: every command that grants, records or revokes an approval or
 * a human review (the workbench's trust boundary — the model never approves
 * its own work), host provisioning that exceeds the 600 s tool cap, and
 * commands whose output or lifetime does not fit a tool call. README.md
 * documents each; this list is the contract.
 */
const FORBIDDEN_COMMANDS = [
  "approve",
  "approvals",
  "approvals-list",
  "approvals-revoke",
  "review",
  "review-page",
  "provision-toolchain",
  "provision-renderer",
  "artifact",
  "artifact-cat",
  "events",
  "cancel",
  "export",
  "release",
  "patch",
  "check",
  "render",
  "assets",
  "workflow",
]
/** Flags that override a safety decision or impersonate the host operator. */
const FORBIDDEN_FLAGS = [
  "--takeover",
  "--watch",
  "--principal",
  "--session",
  "--workspace",
  "--idempotency-key",
  "--verdict",
  "--note",
  "--digest",
  "--action",
  "--expires-in-seconds",
]

/** Parameter names whose values are filesystem paths. */
const PATH_PARAMS = new Set([
  "stateDir",
  "path",
  "dest",
  "dir",
  "opsFile",
  "contextFile",
  "inputFile",
])

describe("cognia-pi-latex-workbench manifest", () => {
  it("localizes every CLI tool description in both manifest locales", () => {
    expect(cliTools).toHaveLength(27)
    for (const tool of cliTools) {
      expect(tool.descriptionKey).toBeTruthy()
      const key = tool.descriptionKey!
      expect(manifest.i18n?.locales.en?.[key]).toBe(tool.description)
      expect(manifest.i18n?.locales["zh-CN"]?.[key]).toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it("passes the host validator with no errors and no warnings", () => {
    const result = validatePluginManifest(manifest, { governanceMode: "warn" })
    expect(result.errors).toEqual([])
    expect((result.diagnostics ?? []).filter((d) => d.severity === "warning")).toEqual([])
    expect(result.valid).toBe(true)
  })

  it("is an installable desktop frontend plugin that spawns node, not a Node-target plugin", () => {
    expect(manifest).toMatchObject({
      id: "cognia-pi-latex-workbench",
      type: "frontend",
      version: "0.1.0",
      main: "dist/index.js",
      permissions: ["cli:execute"],
      activationEvents: ["startup"],
      runtimeCompatibility: {
        tauri: { availability: "supported", entrypoint: "dist/index.js" },
        browser: { availability: "blocked" },
        mobile: { availability: "blocked" },
        headless: { availability: "blocked" },
      },
    })
    expect([...manifest.capabilities].sort()).toEqual(
      ["cli-tools", "configuration", "pi-package", "skills"].sort()
    )
    // `engines.node` would make this a Node-target plugin, which cannot spawn.
    expect(manifest.engines).toEqual({ cognia: ">=0.1.0" })
    expect(manifest.requires?.binaries).toEqual([
      expect.objectContaining({ name: "node", minVersion: "24.0.0" }),
    ])
  })

  it("claims no license the upstream never granted", () => {
    expect(manifest.license).toBe("UNLICENSED")
    expect(existsSync(join(vendorRoot, "LICENSE"))).toBe(false)
    for (const doc of ["README.md", "README.zh-CN.md", "VENDOR.md"]) {
      expect(readFileSync(join(pluginRoot, doc), "utf8")).toMatch(/LICENSE/)
    }
  })

  it("localizes every manifest key in en and zh-CN", () => {
    const locales = manifest.i18n?.locales as Record<string, Record<string, string>>
    const keys = [
      manifest.nameKey,
      manifest.descriptionKey,
      ...(manifest.piPackages ?? []).flatMap((pkg) => [pkg.nameKey, pkg.descriptionKey]),
    ]
    for (const locale of ["en", "zh-CN"]) {
      for (const key of keys) expect(locales[locale]?.[key!]).toEqual(expect.any(String))
    }
    expect(Object.keys(locales.en!).sort()).toEqual(Object.keys(locales["zh-CN"]!).sort())
  })
})

describe("configuration", () => {
  const props = manifest.configSchema!.properties

  it("declares project, protection and stateDir with matching defaults", () => {
    expect(Object.keys(props).sort()).toEqual(["project", "protection", "stateDir"])
    expect(manifest.defaultConfig).toEqual({
      project: "",
      protection: "strict",
      stateDir: ".latexwb",
    })
    for (const [key, value] of Object.entries(manifest.defaultConfig!)) {
      expect(props[key]!.default).toEqual(value)
    }
    expect(props.protection!.enum).toEqual(["strict", "authoring"])
  })

  it("keeps the state dir inside the workspace", () => {
    const pattern = new RegExp(props.stateDir!.pattern!)
    for (const ok of [".latexwb", "build/.latexwb", "state"]) expect(pattern.test(ok)).toBe(true)
    for (const bad of ["/tmp/x", "\\x", "C:\\x", "../x", "a/../../x", "-x", ""]) {
      expect(pattern.test(bad)).toBe(false)
    }
  })

  it("accepts an empty project or a workbench id", () => {
    const pattern = new RegExp(props.project!.pattern!)
    expect(pattern.test("")).toBe(true)
    expect(pattern.test("demo-paper_2.v1")).toBe(true)
    expect(pattern.test("-x")).toBe(false)
  })
})

describe("cliTools", () => {
  it("covers exactly the reviewed command set, once each", () => {
    expect(cliTools.map(commandOf).sort()).toEqual([...EXPOSED_COMMANDS].sort())
    expect(new Set(cliTools.map((tool) => tool.name)).size).toBe(cliTools.length)
    for (const tool of cliTools) {
      expect(tool.name).toBe(`latexwb_${commandOf(tool).replace(/-/g, "_")}`)
    }
  })

  it("runs the vendored CLI entry through the required node binary in the workspace", () => {
    expect(existsSync(join(vendorRoot, "packages/cli/src/bin.ts"))).toBe(true)
    for (const tool of cliTools) {
      expect(tool.binary).toEqual({ kind: "requires", name: "node" })
      expect(tool.argv[0]).toEqual({ literal: CLI_ENTRY })
      expect(tool.cwd).toEqual({ kind: "workspace" })
      expect(tool.outputParse).toBe("json")
      expect(tool.timeoutMs).toBeGreaterThan(0)
      expect(tool.timeoutMs).toBeLessThanOrEqual(600_000)
      expect(["read", "write"]).toContain(tool.access)
      expect(tool.env).toEqual({ LATEXWB_PRINCIPAL: "cognia-agent" })
    }
  })

  it("only uses commands and flags the vendored CLI accepts", () => {
    const commands = upstreamCommands()
    const flags = upstreamKnownFlags()
    for (const tool of cliTools) {
      expect(commands).toContain(commandOf(tool))
      for (const prefix of flagPrefixes(tool)) {
        expect(prefix.startsWith("--")).toBe(true)
        expect(flags).toContain(prefix.slice(2))
      }
      expect(literals(tool).slice(2)).toEqual([])
    }
  })

  it("exposes no approval, review, provisioning or override surface", () => {
    for (const tool of cliTools) {
      expect(FORBIDDEN_COMMANDS).not.toContain(commandOf(tool))
      for (const token of [...literals(tool), ...flagPrefixes(tool)]) {
        expect(FORBIDDEN_FLAGS).not.toContain(token)
        expect(token).not.toBe("recover")
      }
      for (const name of Object.keys(tool.parameters.properties)) {
        expect(["verdict", "digest", "action", "takeover", "principal", "watch"]).not.toContain(
          name
        )
      }
    }
    // The forbidden commands are real CLI commands — the list is not vacuous.
    const commands = upstreamCommands()
    for (const command of ["approve", "review-page", "approvals-revoke", "provision-toolchain"]) {
      expect(commands).toContain(command)
    }
    const readme = readFileSync(join(pluginRoot, "README.md"), "utf8")
    for (const surface of [
      "`approve`",
      "`approvals-revoke`",
      "`review-page`",
      "`materialize --takeover`",
      "`materialize recover`",
      "`provision-toolchain`",
    ]) {
      expect(readme).toContain(surface)
    }
  })

  it("binds every tool but doctor to the state dir and a project", () => {
    for (const tool of cliTools) {
      const { properties, required = [], additionalProperties } = tool.parameters
      expect(additionalProperties).toBe(false)
      if (tool.name === "latexwb_doctor") {
        expect(properties).toEqual({})
        continue
      }
      expect(required).toContain("stateDir")
      expect(tool.argv).toContainEqual({ param: "stateDir", eachPrefixedBy: "--state" })
      expect(Object.keys(properties)).toContain("project")
      if (tool.name !== "latexwb_import") {
        expect(required).toContain("project")
        expect(tool.argv).toContainEqual({ param: "project", eachPrefixedBy: "--project" })
      }
    }
  })

  it("declares every argv param and confines every path param to the workspace", () => {
    for (const tool of cliTools) {
      const declared = Object.keys(tool.parameters.properties)
      for (const token of tool.argv) {
        if ("param" in token) expect(declared).toContain(token.param)
      }
      const paths = declared.filter((name) => PATH_PARAMS.has(name)).sort()
      expect([...(tool.confinedPathParams ?? [])].sort()).toEqual(paths)
    }
  })

  it("never lets a string value be parsed as a CLI flag", () => {
    // `latexwb` reads `--name=value` anywhere in argv; a param value starting
    // with `-` could otherwise smuggle `--principal=…` past the template.
    for (const tool of cliTools) {
      for (const [name, prop] of Object.entries(tool.parameters.properties)) {
        if (prop.type !== "string") continue
        if (prop.enum) {
          expect(prop.enum.every((value) => !value.startsWith("-"))).toBe(true)
          continue
        }
        expect({ tool: tool.name, name, pattern: prop.pattern }).toEqual(
          expect.objectContaining({ pattern: expect.any(String) })
        )
        const pattern = new RegExp(prop.pattern!)
        expect(pattern.test("--principal=host")).toBe(false)
        expect(pattern.test("-x")).toBe(false)
      }
    }
  })

  it("offers exactly the workflow definitions and enums the snapshot ships", () => {
    const definitions = readdirSync(join(vendorRoot, "resources/workflows"))
      .filter((file) => file.endsWith(".json") && file !== "operation-registry.json")
      .map((file) => file.replace(/\.json$/, ""))
      .sort()
    const start = toolByName.get("latexwb_workflow_start")!
    expect(start.parameters.properties.definitionId!.enum).toEqual(definitions)
    expect(binSource).toContain("[--ruleset release|draft|data-assets]")
    expect(binSource).toContain("[--preset screen|detail]")
    expect(binSource).toContain('p !== "draft" && p !== "review" && p !== "submission"')
  })

  it("renders argv exactly as the CLI's positional/flag grammar expects", () => {
    const argv = (name: string, params: Record<string, unknown>) =>
      buildArgv(toolByName.get(name)!.argv, params)
    expect(argv("latexwb_build", { stateDir: ".latexwb", project: "demo", clean: true })).toEqual([
      CLI_ENTRY,
      "build",
      "--project",
      "demo",
      "--clean",
      "--state",
      ".latexwb",
    ])
    expect(
      argv("latexwb_artifact_save", {
        stateDir: ".latexwb",
        project: "demo",
        artifactId: "pdf-1",
        dest: "paper/out.pdf",
      })
    ).toEqual([
      CLI_ENTRY,
      "artifact-save",
      "pdf-1",
      "paper/out.pdf",
      "--project",
      "demo",
      "--state",
      ".latexwb",
    ])
    expect(argv("latexwb_import", { stateDir: ".latexwb", path: "paper" })).toEqual([
      CLI_ENTRY,
      "import",
      "paper",
      "--state",
      ".latexwb",
    ])
    expect(
      argv("latexwb_workflow_resume", {
        stateDir: ".latexwb",
        project: "demo",
        workflowId: "wf-1",
        inputFile: ".latexwb/in.json",
      })
    ).toEqual([
      CLI_ENTRY,
      "workflow-resume",
      "wf-1",
      "--project",
      "demo",
      "--input",
      ".latexwb/in.json",
      "--state",
      ".latexwb",
    ])
  })
})

describe("skills", () => {
  const skills = manifest.skills ?? []

  it("ships the Cognia workbench skill plus four explicit command skills", () => {
    expect(skills.map((skill) => [skill.slug, skill.invocationPolicy ?? "implicit"])).toEqual([
      ["latex-workbench", "implicit"],
      ["latex-write", "explicit"],
      ["latex-revise", "explicit"],
      ["latex-tune", "explicit"],
      ["latex-check", "explicit"],
    ])
    for (const skill of skills) {
      expect(skill.id).toBe(`cognia-pi-latex-workbench:${skill.slug}`)
      expect(skill.source).toEqual({ kind: "local-bundle", path: `skills/${skill.slug}` })
      const body = readFileSync(join(pluginRoot, `skills/${skill.slug}/SKILL.md`), "utf8")
      expect(body).toMatch(new RegExp(`^---\\nname: ${skill.slug}\\ndescription: .+\\n---\\n`))
    }
  })

  it("resolves every plugin-root path the skills reference", () => {
    for (const skill of skills) {
      const body = readFileSync(join(pluginRoot, `skills/${skill.slug}/SKILL.md`), "utf8")
      for (const match of body.matchAll(/\$\{COGNIA_PLUGIN_ROOT\}\/([^\s`)]+)/g)) {
        const rel = match[1]!.replace(/[.,;:]+$/, "")
        // Placeholders (`<templateId>`, `…`) and globs name a directory family.
        const concrete = rel.split("/").findIndex((segment) => /[<*…]/.test(segment))
        const path = concrete === -1 ? rel : rel.split("/").slice(0, concrete).join("/")
        expect({ skill: skill.slug, path, exists: existsSync(join(pluginRoot, path)) }).toEqual({
          skill: skill.slug,
          path,
          exists: true,
        })
      }
    }
  })

  it("names only tools this plugin registers (plus the documented Pi mapping)", () => {
    const names = new Set(cliTools.map((tool) => tool.name))
    for (const skill of skills) {
      const body = readFileSync(join(pluginRoot, `skills/${skill.slug}/SKILL.md`), "utf8")
      for (const match of body.matchAll(/\blatexwb_[a-z_]+\b/g)) {
        const name = match[0]
        // `latexwb_patch_*`-style shorthand is not used; every mention is a real tool.
        expect({ skill: skill.slug, name, known: names.has(name) }).toEqual({
          skill: skill.slug,
          name,
          known: true,
        })
      }
    }
  })

  it("does not register the upstream Pi skills, which name tools Cognia lacks", () => {
    const sources = skills.map((skill) => (skill.source as { path: string }).path)
    expect(sources.some((path) => path.startsWith("vendor/"))).toBe(false)
  })
})

describe("piPackages", () => {
  const [pkg, ...rest] = manifest.piPackages ?? []
  const adapterPackage = JSON.parse(
    readFileSync(join(vendorRoot, "packages/adapter-pi/package.json"), "utf8")
  )

  it("declares one package rooted at the untouched vendor snapshot", () => {
    expect(rest).toEqual([])
    expect(pkg).toMatchObject({ id: "latex-workbench", path: "vendor" })
    const rootPackage = JSON.parse(
      readFileSync(join(pluginRoot, pkg!.path, "package.json"), "utf8")
    )
    const extensions = rootPackage.pi.extensions as string[]
    expect(extensions.length).toBeGreaterThan(0)
    for (const ext of extensions) expect(existsSync(join(pluginRoot, pkg!.path, ext))).toBe(true)
  })

  it("pins the Pi version the upstream adapter declares as its peer", () => {
    expect(pkg!.minPiVersion).toBe(
      adapterPackage.peerDependencies["@earendil-works/pi-coding-agent"]
    )
  })

  it("prepares dependencies without dev/peer packages or lifecycle scripts", () => {
    expect(pkg!.prepare).toEqual({
      program: "npm",
      args: ["install", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund"],
      marker: "vendor/node_modules/.package-lock.json",
      timeoutMs: 300000,
    })
    // Host packages Pi maps to its own copies are peers, so --omit=peer keeps them out.
    for (const host of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
      expect(Object.keys(adapterPackage.peerDependencies)).toContain(host)
      expect(Object.keys(adapterPackage.dependencies ?? {})).not.toContain(host)
    }
  })

  it("loads the Cognia glue entry and declares exactly the upstream tool names", () => {
    const hosted = pkg!.hostedSession!
    expect(hosted.controlsSession).toBe(true)
    expect(hosted.extensions).toEqual(["pi/cognia-workbench.ts"])
    for (const ext of hosted.extensions) expect(existsSync(join(pluginRoot, ext))).toBe(true)
    const sessionControl = readFileSync(
      join(vendorRoot, "packages/adapter-pi/src/session-control.ts"),
      "utf8"
    )
    const block = /export const LATEXWB_TOOL_NAMES = \[([\s\S]*?)\] as const/.exec(sessionControl)
    const upstream = [...block![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
    expect(upstream).toHaveLength(8)
    expect(hosted.tools).toEqual(upstream)
  })

  it("forwards only host-owned values the glue entry knows how to bind", () => {
    expect(pkg!.hostedSession!.env).toEqual([
      { name: "LATEXWB_PROJECT", from: { config: "project" } },
      { name: "LATEXWB_PROTECTION", from: { config: "protection" } },
      { name: "LATEXWB_WORKSPACE", from: { value: "local" } },
      { name: "STATE_DIR", from: { config: "stateDir" } },
      { name: "WORKSPACE_DIR", from: { workspace: true } },
    ])
    const session = readFileSync(join(vendorRoot, "packages/adapter-pi/src/session.ts"), "utf8")
    for (const name of [
      "LATEXWB_PROJECT",
      "LATEXWB_PROTECTION",
      "LATEXWB_WORKSPACE",
      "LATEXWB_STATE",
    ]) {
      expect(session).toContain(`env["${name}"]`)
    }
  })
})

describe("install bundle allowlist", () => {
  const entries = raw.bundle_include as string[]

  it("lists only existing plugin-relative files and no local-only state", () => {
    for (const entry of entries) {
      expect(existsSync(join(pluginRoot, entry))).toBe(true)
      expect(entry.split("/")).not.toContain("..")
      expect(entry.split("/")).not.toContain("node_modules")
      expect(entry.split("/")).not.toContain(".latexwb")
      expect(entry.startsWith("vendor/runtime/toolchain/")).toBe(false)
      expect(entry.startsWith("vendor/runtime/render/")).toBe(false)
      expect(/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)).toBe(false)
    }
  })

  it("ships the docs, the hosted-session glue, every skill file and the CLI entry", () => {
    for (const required of [
      "README.md",
      "README.zh-CN.md",
      "VENDOR.md",
      "vendor-lock.json",
      "pi/cognia-workbench.ts",
      "pi/env-binding.ts",
      "vendor/package.json",
      "vendor/packages/cli/src/bin.ts",
      "vendor/packages/contracts/schemas/contracts.schema.json",
      ...(manifest.skills ?? []).map((skill) => `skills/${skill.slug}/SKILL.md`),
    ]) {
      expect(entries).toContain(required)
    }
  })
})

describe("vendored snapshot integrity", () => {
  it("resolves every relative import and URL inside the snapshot", () => {
    const unresolved: string[] = []
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full)
        return full.endsWith(".ts") ? [full] : []
      })
    for (const file of walk(join(vendorRoot, "packages"))) {
      const source = readFileSync(file, "utf8")
      const specs = [
        ...[...source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)].map((m) => m[1]!),
        ...[...source.matchAll(/new URL\(\s*["'](\.[^"']+)["']\s*,\s*import\.meta\.url/g)].map(
          (m) => m[1]!
        ),
      ]
      for (const spec of specs) {
        if (!existsSync(resolve(dirname(file), spec))) unresolved.push(`${file} -> ${spec}`)
      }
    }
    expect(unresolved).toEqual([])
  })

  it("carries the runtime resources the CLI reads from its repo root", () => {
    for (const path of [
      "migrations/0001_init.sql",
      "runtime/host-policy.json",
      "runtime/toolchain-lock.json",
      "runtime/presets/local-tectonic-xelatex.json",
      "resources/templates/registry.json",
      "resources/workflows/operation-registry.json",
      "resources/profiles/resource-registry.json",
      "packages/runtime/src/render-helper/render-helper.swift",
    ]) {
      expect(existsSync(join(vendorRoot, path))).toBe(true)
    }
    // Recorded snapshot, not the disk: a provisioned toolchain or render
    // helper may legitimately sit (gitignored) in a developer's vendor/.
    const lock = JSON.parse(readFileSync(join(pluginRoot, "vendor-lock.json"), "utf8"))
    for (const path of Object.keys(lock.files as Record<string, string>)) {
      expect(path).not.toMatch(
        /^(fixtures|results|design|scripts|runtime\/toolchain|runtime\/render)\//
      )
      expect(path.split("/")).not.toContain("test")
    }
  })
})

describe("README install instructions", () => {
  const repoRoot = resolve(pluginRoot, "../..")
  const zip = `plugins/pi-latex-workbench/dist/${manifest.id}-${manifest.version}.zip`
  const readmes = {
    en: readFileSync(join(pluginRoot, "README.md"), "utf8"),
    "zh-CN": readFileSync(join(pluginRoot, "README.zh-CN.md"), "utf8"),
  }
  const toolbarLabel = (locale: string): string =>
    JSON.parse(readFileSync(join(repoRoot, `i18n/messages/${locale}/plugins/toolbar.json`), "utf8"))
      .loadUnpacked

  it("documents the Cognia CLI install of the ZIP build.mjs actually writes", () => {
    // `cognia plugin install <path> [--json]` is the CLI subcommand that reaches
    // the desktop's zip installer (cli_bridge install_inner_blocking).
    const cli = readFileSync(join(repoRoot, "crates/cognia-cli/src/cli.rs"), "utf8")
    expect(cli).toMatch(/PluginCommand::Install \{ path, json \}/)
    const build = readFileSync(join(pluginRoot, "build.mjs"), "utf8")
    expect(build).toContain("`${manifest.id}-${manifest.version}.zip`")
    for (const readme of Object.values(readmes)) {
      expect(readme).toContain("pnpm exec node plugins/pi-latex-workbench/build.mjs")
      expect(readme).toContain(`cognia plugin install ${zip} --json`)
    }
  })

  it("names the real Load unpacked toolbar action in each locale", () => {
    expect(readmes.en).toContain(`**${toolbarLabel("en")}**`)
    expect(readmes["zh-CN"]).toContain(`**${toolbarLabel("zh-CN")}**`)
  })

  it("never sends users to the Plugins panel's ZIP action or a GitHub install", () => {
    // The panel's archive action is `plugin_wasm_install_from_file`, which
    // refuses non-WASM plugins; a GitHub install lacks the uncommitted
    // dist/index.js. Both READMEs must say so rather than recommend them.
    for (const readme of Object.values(readmes)) {
      expect(readme).not.toMatch(/local `\.zip` install/i)
      expect(readme).not.toMatch(/本地 `\.zip` 安装/)
      expect(readme).not.toMatch(/cognia plugin install https?:\/\//)
    }
    expect(readmes.en).toMatch(/archive action installs WASM plugins only/)
    expect(readmes["zh-CN"]).toMatch(/只接受 WASM 插件/)
  })
})
