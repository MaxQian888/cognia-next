import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { test } from "node:test"

import {
  assertAuthorBuildRoot,
  assertStandaloneDeclaration,
  collectDeclarations,
  driftKey,
  parseArgs,
} from "./generate-author-types.mjs"

test("parseArgs supports check mode and rejects unknown options", () => {
  assert.deepEqual(parseArgs([]), { check: false })
  assert.deepEqual(parseArgs(["--check"]), { check: true })
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})

test("collectDeclarations uses glob semantics for nested ESM declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "author-types-"))
  mkdirSync(join(root, "nested"), { recursive: true })
  writeFileSync(join(root, "root.d.ts"), "export type Root = true\n")
  writeFileSync(join(root, "nested", "child.d.ts"), "export type Child = true\n")
  writeFileSync(join(root, "nested", "ignored.d.cts"), "export type Ignored = true\n")

  assert.deepEqual(
    collectDeclarations(root).map((path) => path.slice(root.length + 1)),
    ["nested/child.d.ts", "root.d.ts"]
  )
  rmSync(root, { recursive: true, force: true })
})

test("driftKey ignores declaration and quoted-union ordering only", () => {
  const left = 'type A = "z" | "a"\ntype B = string\n'
  const right = 'type B = string\ntype A = "a" | "z"\n'
  assert.equal(driftKey(left), driftKey(right))
  assert.notEqual(driftKey(left), driftKey(`${right}type C = number\n`))
})

test("author build rejects internal externals and escaped host imports", () => {
  assert.doesNotThrow(() => assertAuthorBuildRoot({ dependencies: { react: "19" } }))
  assert.throws(
    () => assertAuthorBuildRoot({ dependencies: { "@cognia/agent": "workspace:*" } }),
    /must not externalize/
  )
  assert.throws(
    () => assertAuthorBuildRoot({ peerDependencies: { "@cognia/agent": "*" } }),
    /must not externalize/
  )
  assert.doesNotThrow(() => assertStandaloneDeclaration('import { ReactNode } from "react"'))
  for (const specifier of ["@/types/plugin", "@cognia/agent-config-types", "/private/repo/types"]) {
    assert.throws(
      () => assertStandaloneDeclaration(`import { Value } from "${specifier}"`),
      /flatten internal imports/
    )
    assert.throws(
      () => assertStandaloneDeclaration(`type Value = import("${specifier}").Value`),
      /flatten internal imports/
    )
  }
})

test("SDK author declarations resolve AgentTeam contracts and policies from canonical source", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const configPath = join(root, "packages/plugin-sdk/tsconfig.json")
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    join(root, "packages/plugin-sdk")
  )
  for (const [specifier, source] of [
    ["@cognia/agent-orchestration/records", "agent-orchestration/src/records.ts"],
    ["@cognia/agent-runtime-kit/permission-modes", "agent-runtime-kit/src/permission-modes.ts"],
    ["@cognia/sync-protocol", "sync-protocol/src/index.ts"],
  ]) {
    const resolved = ts.resolveModuleName(
      specifier,
      join(root, "types/agent/agent-team-runtime.ts"),
      parsed.options,
      ts.sys
    ).resolvedModule
    assert.equal(resolved?.resolvedFileName, join(root, "packages", source))
  }
})
