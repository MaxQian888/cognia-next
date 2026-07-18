/**
 * Regression coverage for scripts/gates/check-static-export.mjs.
 *
 * Pure-function tests import the scanner directly; end-to-end behavior is
 * exercised in a tmp git fixture with a minimal next.config.ts.
 *
 * Run with: node --test scripts/gates/check-static-export.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  parseNodeOnlyModules,
  buildDenySet,
  extractImports,
  scanSource,
} from "./check-static-export.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, "check-static-export.mjs")

const NEXT_CONFIG_FIXTURE = `
const NODE_ONLY_MODULES = [
  "fs",
  "node:fs",
  "child_process",
  "node:child_process",
]
export default {}
`

// --- pure function tests ---

test("parseNodeOnlyModules extracts the list and throws when absent", () => {
  assert.deepEqual(parseNodeOnlyModules(NEXT_CONFIG_FIXTURE), [
    "fs",
    "node:fs",
    "child_process",
    "node:child_process",
  ])
  assert.throws(() => parseNodeOnlyModules("export default {}"), /stale/)
})

test("buildDenySet includes builtins in both forms plus server SDKs", () => {
  const deny = buildDenySet(NEXT_CONFIG_FIXTURE)
  assert.ok(deny.has("fs"))
  assert.ok(deny.has("node:crypto"))
  assert.ok(deny.has("crypto"))
  assert.ok(deny.has("@modelcontextprotocol/sdk/server"))
})

test("extractImports covers static/export-from/require/dynamic forms", () => {
  const src = [
    `import { readFileSync } from "node:fs"`,
    `import "side-effect-pkg"`,
    `export { x } from "child_process"`,
    `const a = require("node:os")`,
    `const b = await import("node:net")`,
  ].join("\n")
  const mods = extractImports(src).map((i) => i.module)
  assert.deepEqual(mods.sort(), [
    "child_process",
    "node:fs",
    "node:net",
    "node:os",
    "side-effect-pkg",
  ])
})

test("import type and typeof import() are type-only (auto-exempt)", () => {
  const src = [
    `import type { Stats } from "node:fs"`,
    `type NetMod = typeof import("node:net")`,
    `export type { X } from "node:os"`,
  ].join("\n")
  const imports = extractImports(src)
  assert.ok(
    imports.every((i) => i.typeOnly),
    JSON.stringify(imports)
  )
})

test("value import + typeof import on one line keeps exactly one value hit", () => {
  const src = `const net = (await import("node:net")) as typeof import("node:net")`
  const imports = extractImports(src)
  const values = imports.filter((i) => !i.typeOnly)
  assert.equal(values.length, 1)
  assert.equal(values[0].module, "node:net")
})

test("lazy import regex never crosses into a later statement's string", () => {
  // Regression: `export interface ... { }` followed by unrelated strings must
  // not synthesize a bogus module from a later string literal.
  const src = [
    `import type { A } from "@/types/a"`,
    `export interface Options { target?: number }`,
    `const SEP = ",\\n  "`,
    `const joined = ["a", "b"].join(SEP)`,
  ].join("\n")
  const values = extractImports(src).filter((i) => !i.typeOnly)
  assert.deepEqual(values, [])
})

test("scanSource: deny hit without exemption is a violation; allowlist suppresses", () => {
  const deny = buildDenySet(NEXT_CONFIG_FIXTURE)
  const src = `import { readFileSync } from "node:fs"`
  const bare = scanSource("lib/x.ts", src, deny, [])
  assert.equal(bare.violations.length, 1)
  assert.equal(bare.violations[0].module, "node:fs")

  const allowed = scanSource("lib/x.ts", src, deny, [
    { file: "lib/x.ts", module: "node:fs", reason: "host-only" },
  ])
  assert.equal(allowed.violations.length, 0)
})

test("scanSource: inline exempt with reason suppresses; bare marker fails", () => {
  const deny = buildDenySet(NEXT_CONFIG_FIXTURE)
  const good = scanSource(
    "lib/x.ts",
    `// static-export-exempt: runs in sidecar only\nimport { spawn } from "node:child_process"`,
    deny,
    []
  )
  assert.equal(good.violations.length, 0)
  assert.equal(good.badExempts.length, 0)

  const bad = scanSource(
    "lib/x.ts",
    `// static-export-exempt:\nimport { spawn } from "node:child_process"`,
    deny,
    []
  )
  assert.equal(bad.violations.length, 0)
  assert.equal(bad.badExempts.length, 1)
})

test("scanSource: subpath of a denied server SDK is flagged", () => {
  const deny = buildDenySet(NEXT_CONFIG_FIXTURE)
  const { violations } = scanSource(
    "lib/x.ts",
    `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"`,
    deny,
    []
  )
  assert.equal(violations.length, 1)
})

// --- end-to-end fixture tests ---

function makeFixture({ tsFiles = [], allowlist = [] }) {
  const root = mkdtempSync(join(tmpdir(), "static-export-"))
  writeFileSync(join(root, "next.config.ts"), NEXT_CONFIG_FIXTURE, "utf8")
  for (const { path, contents } of tsFiles) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents, "utf8")
  }
  mkdirSync(join(root, "scripts", "gates"), { recursive: true })
  copyFileSync(SCRIPT, join(root, "scripts", "gates", "check-static-export.mjs"))
  writeFileSync(
    join(root, "scripts", "gates", "static-export-allowlist.json"),
    JSON.stringify(allowlist),
    "utf8"
  )
  spawnSync("git", ["init", "-q"], { cwd: root })
  spawnSync("git", ["config", "user.email", "audit@test"], { cwd: root })
  spawnSync("git", ["config", "user.name", "audit"], { cwd: root })
  spawnSync("git", ["add", "."], { cwd: root })
  spawnSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root })
  return root
}

function runScript(root) {
  return spawnSync("node", [join(root, "scripts", "gates", "check-static-export.mjs")], {
    cwd: root,
    encoding: "utf8",
  })
}

test("e2e: clean tree exits 0; violation exits 1 with file:line", () => {
  const clean = makeFixture({
    tsFiles: [{ path: "lib/ok.ts", contents: `export const x = 1` }],
  })
  const okResult = runScript(clean)
  assert.equal(okResult.status, 0, okResult.stderr + okResult.stdout)
  rmSync(clean, { recursive: true, force: true })

  const dirty = makeFixture({
    tsFiles: [{ path: "components/bad.tsx", contents: `import { readFileSync } from "node:fs"\n` }],
  })
  const badResult = runScript(dirty)
  assert.equal(badResult.status, 1)
  assert.match(badResult.stderr, /components\/bad\.tsx:1\s+imports "node:fs"/)
  rmSync(dirty, { recursive: true, force: true })
})

test("e2e: stale allowlist entry warns but does not fail", () => {
  const root = makeFixture({
    tsFiles: [{ path: "lib/ok.ts", contents: `export const x = 1` }],
    allowlist: [{ file: "lib/gone.ts", module: "node:fs", reason: "was removed" }],
  })
  const result = runScript(root)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stderr + result.stdout, /stale allowlist/)
  rmSync(root, { recursive: true, force: true })
})

test("e2e: tracked files deleted in the working tree are skipped", () => {
  const root = makeFixture({
    tsFiles: [{ path: "lib/deleted.ts", contents: `import fs from "node:fs"` }],
  })
  rmSync(join(root, "lib", "deleted.ts"))
  const result = runScript(root)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  rmSync(root, { recursive: true, force: true })
})

test("e2e: .test/.stories/.mjs files are out of scope", () => {
  const root = makeFixture({
    tsFiles: [
      { path: "lib/x.test.ts", contents: `import fs from "node:fs"` },
      { path: "components/y.stories.tsx", contents: `import fs from "node:fs"` },
      { path: "hooks/builtin/hook.mjs", contents: `import fs from "node:fs"` },
    ],
  })
  const result = runScript(root)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  rmSync(root, { recursive: true, force: true })
})
