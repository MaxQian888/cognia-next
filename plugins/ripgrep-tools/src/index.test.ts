/**
 * ripgrep-tools is the ONLY first-party consumer of the `cli-tools`
 * capability, and it ships zero imperative code — its entire behavior is the
 * `cliTools[0]` argv template in `plugin.json`. Nothing else in the repo
 * executes that template against real inputs: `plugins/first-party-manifests.test.ts`
 * only validates manifest shape, and `plugins/**` is not in jest's
 * `collectCoverageFrom`. So the template was unexercised, which is exactly how
 * an argv hazard shipped.
 *
 * These tests feed the real manifest through the real `buildArgv` / `resolveCwd`
 * helpers, with adversarial values.
 */

import { buildArgv, resolveCwd, CliTemplateError } from "@/lib/plugin/cli-tools/template"
import type { PluginCliArgvToken, PluginCliToolDef } from "@/types/plugin"

import definition from "./index"
import manifest from "../plugin.json"

const tool = manifest.cliTools[0] as unknown as PluginCliToolDef
const argvTokens = tool.argv as unknown as PluginCliArgvToken[]

function argvFor(params: Record<string, unknown>): string[] {
  return buildArgv(argvTokens, params)
}

describe("ripgrep-tools manifest", () => {
  it("exposes the module manifest straight from plugin.json", () => {
    // Guards the `builtinManifest` module-over-JSON merge trap: a hand-written
    // TS subset would silently win over these keys.
    expect(definition.manifest.id).toBe("ripgrep-tools")
    expect(definition.manifest.permissions).toEqual(["cli:execute"])
    expect(definition.manifest.cliTools).toHaveLength(1)
  })

  it("declares an activation event so activate() is reachable", () => {
    expect(manifest.activationEvents).toContain("startup")
  })
})

describe("ripgrep_search argv template", () => {
  it("builds the expected argv for a plain search", () => {
    expect(argvFor({ pattern: "todo", path: "src" })).toEqual(["--json", "-e", "todo", "--", "src"])
  })

  it("emits boolean flags without a value and omits empty optionals", () => {
    // `renderValue` gives `true` flag semantics (prefix only, no "true"), and
    // `omitWhenEmpty` drops false/absent values entirely.
    expect(argvFor({ pattern: "x", ignoreCase: true })).toEqual(["--json", "-i", "-e", "x", "--"])
    expect(argvFor({ pattern: "x", ignoreCase: false })).toEqual(["--json", "-e", "x", "--"])
  })

  it("expands array globs one flag per value", () => {
    expect(argvFor({ pattern: "x", globs: ["*.ts", "*.tsx"] })).toEqual([
      "--json",
      "--glob",
      "*.ts",
      "--glob",
      "*.tsx",
      "-e",
      "x",
      "--",
    ])
  })

  it("passes maxCount as a discrete flag/value pair", () => {
    expect(argvFor({ pattern: "x", maxCount: 5 })).toEqual([
      "--json",
      "--max-count",
      "5",
      "-e",
      "x",
      "--",
    ])
  })

  it("requires a pattern", () => {
    expect(() => argvFor({ path: "src" })).toThrow(CliTemplateError)
  })

  // ─── injection hazards ────────────────────────────────────────────────────
  // `buildArgv` already guarantees one-value-one-argv-element, so a shell
  // metacharacter can never escape. The residual hazard is different: a value
  // that lands POSITIONALLY is still parsed in ripgrep's OWN flag namespace.
  // `-e` pins the pattern to an option's value slot and `--` terminates option
  // parsing, so neither param can be reinterpreted as a flag.

  it("cannot smuggle a ripgrep flag through `pattern`", () => {
    // `--pre=<CMD>` makes ripgrep execute CMD once per candidate file. As a
    // bare positional this would be honored; after `-e` it is a search string.
    const argv = argvFor({ pattern: "--pre=/bin/sh", path: "src" })
    expect(argv).toEqual(["--json", "-e", "--pre=/bin/sh", "--", "src"])
    expect(argv[argv.indexOf("--pre=/bin/sh") - 1]).toBe("-e")
  })

  it("cannot smuggle a ripgrep flag through `path`", () => {
    const argv = argvFor({ pattern: "x", path: "--pre=/bin/sh" })
    // Everything after `--` is a path operand, never an option.
    expect(argv.indexOf("--")).toBeLessThan(argv.indexOf("--pre=/bin/sh"))
  })

  it("keeps shell metacharacters as literal single argv elements", () => {
    const argv = argvFor({ pattern: "; rm -rf /", path: "a b; c" })
    expect(argv).toContain("; rm -rf /")
    expect(argv).toContain("a b; c")
  })
})

describe("ripgrep_search cwd policy", () => {
  const cwd = tool.cwd as unknown as Parameters<typeof resolveCwd>[0]

  it("anchors at the workspace root", () => {
    expect(resolveCwd(cwd, {}, { workspaceRoot: "/ws", pluginPath: "/p" })).toBe("/ws")
  })

  it("fails closed when no workspace is open", () => {
    // `workspaceRoot` is `string | undefined` — declared, but absent at runtime
    // whenever no folder is open. The policy must throw rather than silently
    // spawn ripgrep in the process cwd.
    expect(() => resolveCwd(cwd, {}, { pluginPath: "/p", workspaceRoot: undefined })).toThrow(
      CliTemplateError
    )
  })
})
