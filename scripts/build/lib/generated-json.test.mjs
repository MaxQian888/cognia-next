import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { loadTsExports, renderJson, writeOrCheck } from "./generated-json.mjs"

test("loads TypeScript behind the repo's path aliases", async () => {
  const loaded = await loadTsExports(
    `export { ACP_PROTOCOL } from "@cognia/agent-acp/manifest"\nexport const typed: number = 1`
  )
  assert.equal(loaded.ACP_PROTOCOL, "acp")
  assert.equal(loaded.typed, 1)
})

test("renders expanded objects and packed short arrays", async () => {
  const text = await renderJson(join(tmpdir(), "x.json"), { a: { b: ["c", "d"] } })
  assert.equal(text, '{\n  "a": {\n    "b": ["c", "d"]\n  }\n}\n')
})

test("writes, reports up-to-date, and refuses drift under --check", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-json-"))
  const file = join(dir, "f.json")
  writeFileSync(file, "old")
  const opts = { label: "t", hint: "regenerate" }
  assert.equal(writeOrCheck(file, "old", "new", { ...opts, check: true }), 1)
  assert.equal(readFileSync(file, "utf8"), "old")
  assert.equal(writeOrCheck(file, "old", "new", { ...opts, check: false }), 0)
  assert.equal(readFileSync(file, "utf8"), "new")
  assert.equal(writeOrCheck(file, "new", "new", { ...opts, check: true }), 0)
})
