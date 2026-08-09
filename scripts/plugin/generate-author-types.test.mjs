import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { collectDeclarations, driftKey, parseArgs } from "./generate-author-types.mjs"

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
