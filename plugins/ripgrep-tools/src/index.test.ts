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

import { spawnSync } from "node:child_process"

import {
  assertConfinedPathParams,
  buildArgv,
  resolveCwd,
  CliTemplateError,
} from "@cognia/plugin-sdk"
import type { PluginCliArgvToken, PluginCliToolDef } from "@cognia/plugin-sdk"
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

  it("classifies the tool for confinement and confines `path` to the workspace", () => {
    // `access` reaches the sidecar manifest so the workspace-confinement
    // gates classify ripgrep_search with the built-in read set.
    expect((tool as { access?: string }).access).toBe("read")
    expect(tool.confinedPathParams).toEqual(["path"])
    expect(tool.cwd).toEqual({ kind: "workspace" })
  })
})

describe("ripgrep_search argv template", () => {
  it("builds the expected argv for a plain search", () => {
    expect(argvFor({ pattern: "todo", path: "src" })).toEqual([
      "--json",
      "--no-config",
      "-e",
      "todo",
      "--",
      "src",
    ])
  })

  it("always disables user ripgrep config", () => {
    // RIPGREP_CONFIG_PATH / ~/.config/ripgrep/config could silently change
    // semantics (hidden, no-ignore, smart-case) — or, on rg 13, re-arm the
    // deprecated `pre = <cmd>` preprocessor hook. `--no-config` is literal,
    // first, and unparameterized so nothing can turn it off.
    const argv = argvFor({ pattern: "x" })
    expect(argv[1]).toBe("--no-config")
    expect(argvFor({ pattern: "x", ignoreCase: true, path: "src" })[1]).toBe("--no-config")
  })

  it("emits boolean flags without a value and omits empty optionals", () => {
    // `renderValue` gives `true` flag semantics (prefix only, no "true"), and
    // `omitWhenEmpty` drops false/absent values entirely.
    expect(argvFor({ pattern: "x", ignoreCase: true })).toEqual([
      "--json",
      "--no-config",
      "-i",
      "-e",
      "x",
      "--",
    ])
    expect(argvFor({ pattern: "x", ignoreCase: false })).toEqual([
      "--json",
      "--no-config",
      "-e",
      "x",
      "--",
    ])
  })

  it("expands array params one flag per value", () => {
    expect(argvFor({ pattern: "x", globs: ["*.ts", "*.tsx"], types: ["rust"] })).toEqual([
      "--json",
      "--no-config",
      "-t",
      "rust",
      "--glob",
      "*.ts",
      "--glob",
      "*.tsx",
      "-e",
      "x",
      "--",
    ])
  })

  it("renders the extended search surface as discrete flags", () => {
    expect(
      argvFor({
        pattern: "x",
        fixedStrings: true,
        wordRegexp: true,
        contextLines: 2,
        maxDepth: 3,
        maxFilesize: "1M",
        hidden: true,
        noIgnore: true,
        multiline: true,
        onlyMatching: true,
      })
    ).toEqual([
      "--json",
      "--no-config",
      "-F",
      "-w",
      "-o",
      "-C",
      "2",
      "--max-depth",
      "3",
      "--max-filesize",
      "1M",
      "--hidden",
      "--no-ignore",
      "-U",
      "--multiline-dotall",
      "-e",
      "x",
      "--",
    ])
  })

  it("passes maxCount as a discrete flag/value pair", () => {
    expect(argvFor({ pattern: "x", maxCount: 5 })).toEqual([
      "--json",
      "--no-config",
      "--max-count",
      "5",
      "-e",
      "x",
      "--",
    ])
  })

  it("declares integer bounds on the numeric params", () => {
    const props = (
      tool.parameters as { properties: Record<string, { type?: string; minimum?: number }> }
    ).properties
    expect(props.maxCount).toMatchObject({ type: "integer", minimum: 1 })
    expect(props.contextLines).toMatchObject({ type: "integer", minimum: 0 })
    expect(props.maxDepth).toMatchObject({ type: "integer", minimum: 1 })
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
    expect(argv).toEqual(["--json", "--no-config", "-e", "--pre=/bin/sh", "--", "src"])
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

describe("ripgrep_search path confinement", () => {
  const names = tool.confinedPathParams

  it("accepts relative and inside-workspace absolute paths", () => {
    expect(() => assertConfinedPathParams({ path: "src/lib" }, names, "/ws")).not.toThrow()
    expect(() => assertConfinedPathParams({ path: "/ws/src" }, names, "/ws")).not.toThrow()
    // The workspace root itself and an omitted path are both fine.
    expect(() => assertConfinedPathParams({ path: "/ws" }, names, "/ws")).not.toThrow()
    expect(() => assertConfinedPathParams({}, names, "/ws")).not.toThrow()
  })

  it("rejects absolute escapes and `..` traversal", () => {
    for (const path of ["/etc", "../sibling", "a/../../b", "C:/Windows"]) {
      expect(() => assertConfinedPathParams({ path }, names, "/ws")).toThrow(CliTemplateError)
    }
  })

  it("rejects credential paths even inside the workspace", () => {
    // Parity with the built-in file tools' deny list: a checked-in `.ssh`
    // fixture dir is still unreadable through this tool.
    for (const path of [".ssh", "sub/.aws/credentials", "id_rsa", "x/.git-credentials"]) {
      expect(() => assertConfinedPathParams({ path }, names, "/ws")).toThrow(CliTemplateError)
    }
  })

  it("fails closed when there is no base to confine against", () => {
    expect(() => assertConfinedPathParams({ path: "src" }, names, undefined)).toThrow(
      CliTemplateError
    )
  })
})

// End-to-end against a real `rg` when the host has one — the only coverage
// that proves the rendered argv is actually ACCEPTED by ripgrep (flag
// spellings, `--no-config` support, [0,1] exit semantics, JSONL shape).
const rgPath = spawnSync("rg", ["--version"], { encoding: "utf8" })
const hasRg = rgPath.status === 0
const describeRg = hasRg ? describe : describe.skip

describeRg("ripgrep_search real rg", () => {
  it("runs the manifest argv verbatim", () => {
    // Scoped to this plugin's dir — searching the repo root overflows
    // spawnSync's default maxBuffer (ENOBUFS kills the child, status null).
    const argv = argvFor({ pattern: "ripgrep", ignoreCase: true, path: "plugins/ripgrep-tools" })
    const proc = spawnSync("rg", argv, {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, RIPGREP_CONFIG_PATH: "/nonexistent/should-be-ignored" },
    })
    // 0 = matches or clean run; 1 = no matches. Both are success here.
    expect([0, 1]).toContain(proc.status)
    if (proc.stdout.length > 0) {
      for (const line of proc.stdout.trim().split("\n")) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    }
  })
})
