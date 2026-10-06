import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

import {
  EVAL_UI_BOUNDARIES,
  extractModuleReferences,
  findEvalUiBoundaryViolations,
  findPackageBoundaryViolations,
} from "./check-package-boundaries.mjs"

function fixture(t, source) {
  const root = mkdtempSync(join(tmpdir(), "package-boundaries-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  function write(file, content) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        moduleResolution: "bundler",
        paths: {
          "@/*": ["./*"],
          "@host/*": ["./lib/*"],
          "@cognia/other": ["./packages/other/src/index.ts"],
        },
      },
    })
  )
  write("packages/example/src/index.ts", source)
  write("packages/example/src/local.ts", "export const local = 1")
  write("packages/other/src/index.ts", "export const other = 2")
  write("lib/host.ts", "export const host = 3")
  return { root, write }
}

test("reads value, type, re-export, import-type, require and lazy module references", () => {
  const refs = extractModuleReferences(
    [
      'import { a } from "value"',
      'import type { B } from "types"',
      'export type { C } from "exported-type"',
      'export * from "exported-value"',
      'type D = import("import-type").D',
      'const lazy = import("lazy")',
      'const cjs = require("cjs")',
      'import legacy = require("legacy")',
      "const template = import(`template`)",
      '// import fake from "comment"',
      "const text = \"require('text')\"",
    ].join("\n")
  )
  assert.deepEqual(refs, [
    { specifier: "value", line: 1 },
    { specifier: "types", line: 2 },
    { specifier: "exported-type", line: 3 },
    { specifier: "exported-value", line: 4 },
    { specifier: "import-type", line: 5 },
    { specifier: "lazy", line: 6 },
    { specifier: "cjs", line: 7 },
    { specifier: "legacy", line: 8 },
    { specifier: "template", line: 9 },
  ])
})

test("rejects host imports through root aliases, custom aliases and relative paths", (t) => {
  const { root } = fixture(
    t,
    [
      'import { host } from "@/lib/host"',
      'export { host } from "../../../lib/host"',
      'type Host = import("@host/host").Host',
      'const host = import("../../../lib/host")',
    ].join("\n")
  )
  const violations = findPackageBoundaryViolations(root, ["example"])
  assert.deepEqual(
    violations.map(({ specifier, line, target }) => ({ specifier, line, target })),
    [
      { specifier: "@/lib/host", line: 1, target: "lib/host.ts" },
      { specifier: "../../../lib/host", line: 2, target: "lib/host.ts" },
      { specifier: "@host/host", line: 3, target: "lib/host.ts" },
      { specifier: "../../../lib/host", line: 4, target: "lib/host.ts" },
    ]
  )
})

test("permits local modules, other packages and external dependencies", (t) => {
  const { root, write } = fixture(
    t,
    [
      'import { local } from "./local"',
      'import { other } from "@cognia/other"',
      'import { external } from "external"',
    ].join("\n")
  )
  write("node_modules/external/package.json", '{"name":"external","types":"index.d.ts"}')
  write("node_modules/external/index.d.ts", "export declare const external: number")
  // This gate governs library source. Host integration tests have their own
  // owner and may need to exercise the application that supplies the adapter.
  write("packages/example/src/index.test.ts", 'import { host } from "@/lib/host"')
  assert.deepEqual(findPackageBoundaryViolations(root, ["example"]), [])
})

test("deleted direct host targets and similar directory prefixes cannot bypass the boundary", (t) => {
  const { root, write } = fixture(
    t,
    [
      'export * from "@/lib/deleted"',
      'export * from "../../../lib/missing"',
      'export * from "../../../packages-private/helper"',
    ].join("\n")
  )
  write("packages-private/helper.ts", "export const hidden = true")
  assert.deepEqual(
    findPackageBoundaryViolations(root, ["example"]).map((v) => v.target),
    ["lib/deleted", "lib/missing", "packages-private/helper.ts"]
  )
})

test("library source does not depend on the application tree", () => {
  assert.deepEqual(findPackageBoundaryViolations(), [])
})

test("eval UI rejects persistence/store paths through aliases, types and relative lazy imports", (t) => {
  const { root, write } = fixture(t, "")
  write(
    "components/eval/panel.tsx",
    [
      'import type { Row } from "@/lib/db/rows"',
      'const store = import("../../stores/account")',
      'export { host } from "@host/host"',
      'import { domain } from "@cognia/other"',
      'import { Card } from "@/components/ui/card"',
    ].join("\n")
  )
  const rules = [{ file: "components/eval/panel.tsx", forbidden: ["lib", "stores"] }]
  assert.deepEqual(
    findEvalUiBoundaryViolations(root, rules).map(({ target }) => target),
    ["lib/db/rows", "stores/account", "lib/host.ts"]
  )
})

test("selected eval views consume domain data and application use cases", () => {
  assert.deepEqual(findEvalUiBoundaryViolations(), [])
})

test("an eval UI store exception does not permit foreign or similarly named stores", (t) => {
  const { root, write } = fixture(t, "")
  write(
    "components/eval/panel.tsx",
    [
      'import { own } from "@/stores/eval/run"',
      'import { foreign } from "@/stores/settings/store"',
      'import { other } from "@/stores/eval-private/run"',
    ].join("\n")
  )
  const rules = [
    { file: "components/eval/panel.tsx", forbidden: ["stores"], allowed: ["stores/eval"] },
  ]
  assert.deepEqual(
    findEvalUiBoundaryViolations(root, rules).map(({ target }) => target),
    ["stores/settings/store", "stores/eval-private/run"]
  )
})

test("execution and review views cannot bypass their application service", (t) => {
  const { root, write } = fixture(t, "")
  write("lib/ai/eval/orchestrator.ts", "export const engine = 1")
  write("lib/ai/eval/review-service.ts", "export type Service = unknown")
  write("lib/ai/eval/finalization.ts", "export const finalize = 1")
  write(
    "components/eval/eval-lab-workspace.tsx",
    'const engine = import("../../lib/ai/eval/orchestrator")'
  )
  write(
    "components/eval/blind-review-panel.tsx",
    [
      'import type { Service } from "@/lib/ai/eval/review-service"',
      'import { finalize } from "@/lib/ai/eval/finalization"',
    ].join("\n")
  )
  const rules = EVAL_UI_BOUNDARIES.filter(({ file }) =>
    /(?:eval-lab-workspace|blind-review-panel)\.tsx$/.test(file)
  )
  assert.deepEqual(
    findEvalUiBoundaryViolations(root, rules)
      .map(({ target }) => target)
      .sort(),
    ["lib/ai/eval/finalization.ts", "lib/ai/eval/orchestrator.ts"]
  )
})
