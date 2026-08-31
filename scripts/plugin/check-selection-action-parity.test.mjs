import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  checkSelectionActionParity,
  evaluateSelectionActionParity,
} from "./check-selection-action-parity.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

test("the repository keeps selection contracts wired across every author/host surface", () => {
  assert.deepEqual(checkSelectionActionParity(root), [])
})

test("a missing host boundary fails the parity check", () => {
  const issues = evaluateSelectionActionParity(() => "")
  assert.ok(issues.some((issue) => issue.includes("host execution boundary")))
})
