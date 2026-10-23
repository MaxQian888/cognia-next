// `node --test scripts/plugin/check-sdk-standalone.test.mjs`

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  SDK_STANDALONE_BASELINE,
  checkSdkStandalone,
  countHostReferences,
  findHostReferences,
  reachablePackages,
  writeSdkStandaloneBaseline,
} from "./check-sdk-standalone.mjs"

function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-standalone-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  fs.mkdirSync(path.join(root, "scripts/plugin"), { recursive: true })
  return root
}

const PKG = '{"name":"x"}'

test("host references are @/ specifiers and relative paths leaving the package", () => {
  const root = "/r/packages/plugin-sdk"
  const file = `${root}/src/api/x.ts`
  const source = `
    import type { A } from "@/types/plugin"
    export { b } from "@/lib/plugin/b"
    type C = import("@/lib/plugin/api/c").C
    jest.mock("@/stores/settings")
    import { d } from "../define/d"
    import catalog from "../../contract/catalog.json"
    import { e } from "../../../../scripts/e"
    import { f } from "@cognia/provider-types"
    // import { g } from "@/lib/commented-out"
  `
  assert.deepEqual(findHostReferences(source, file, root), [
    "@/types/plugin",
    "@/lib/plugin/b",
    "@/lib/plugin/api/c",
    "@/stores/settings",
    "../../../../scripts/e",
  ])
})

test("follows @cognia packages the roots reach, transitively", (t) => {
  const root = repo(t, {
    "packages/plugin-sdk/package.json": PKG,
    "packages/plugin-sdk/src/index.ts": 'export * from "@cognia/plugin-contract/types"',
    "packages/plugin-contract/package.json": PKG,
    "packages/plugin-contract/src/types.ts": 'import type { P } from "@cognia/provider-types"',
    "packages/provider-types/package.json": PKG,
    "packages/provider-types/src/index.ts": "export type P = 1",
    "packages/unrelated/package.json": PKG,
    "packages/unrelated/src/index.ts": 'import "@/lib/anything"',
  })
  assert.deepEqual(reachablePackages(root), [
    "packages/plugin-contract",
    "packages/plugin-sdk",
    "packages/provider-types",
  ])
  assert.deepEqual(countHostReferences(root), {})
})

test("a reachable package with host references is counted", (t) => {
  const root = repo(t, {
    "packages/plugin-sdk/package.json": PKG,
    "packages/plugin-sdk/src/index.ts":
      'import type { A } from "@cognia/agent-config-types"\nimport type { B } from "@/types/b"',
    "packages/agent-config-types/package.json": PKG,
    "packages/agent-config-types/src/index.ts":
      'type M = import("@/types/memory").M\ntype N = import("@/types/n").N',
  })
  assert.deepEqual(countHostReferences(root), {
    "packages/agent-config-types/src/index.ts": 2,
    "packages/plugin-sdk/src/index.ts": 1,
  })
})

test("the baseline may only shrink, and a shrunk file must be recorded", (t) => {
  const root = repo(t, {
    "packages/plugin-sdk/package.json": PKG,
    "packages/plugin-sdk/src/a.ts": 'import "@/lib/a"\nimport "@/lib/b"',
    "packages/plugin-sdk/src/b.ts": 'import "@/lib/c"',
  })
  writeSdkStandaloneBaseline(root)
  assert.deepEqual(checkSdkStandalone(root), { regressed: [], stale: [], total: 3, files: 2 })

  fs.writeFileSync(path.join(root, "packages/plugin-sdk/src/c.ts"), 'import "@/lib/new"')
  assert.deepEqual(checkSdkStandalone(root).regressed, [
    "packages/plugin-sdk/src/c.ts: 1 host reference(s), baseline 0",
  ])
  fs.rmSync(path.join(root, "packages/plugin-sdk/src/c.ts"))

  fs.writeFileSync(path.join(root, "packages/plugin-sdk/src/a.ts"), 'import "@/lib/a"')
  assert.deepEqual(checkSdkStandalone(root).stale, [
    "packages/plugin-sdk/src/a.ts: 1 host reference(s), baseline 2",
  ])
  writeSdkStandaloneBaseline(root)
  const recorded = JSON.parse(fs.readFileSync(path.join(root, SDK_STANDALONE_BASELINE), "utf8"))
  assert.deepEqual(recorded.files, {
    "packages/plugin-sdk/src/a.ts": 1,
    "packages/plugin-sdk/src/b.ts": 1,
  })
})

test("dist and node_modules are not scanned", (t) => {
  const root = repo(t, {
    "packages/plugin-sdk/package.json": PKG,
    "packages/plugin-sdk/src/index.ts": "export const ok = 1",
    "packages/plugin-sdk/src/node_modules/x/index.js": 'require("@/lib/x")',
    "packages/plugin-sdk/dist/index.js": 'require("@/lib/x")',
  })
  assert.deepEqual(countHostReferences(root), {})
})
