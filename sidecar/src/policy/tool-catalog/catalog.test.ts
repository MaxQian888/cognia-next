import { test } from "node:test"
import assert from "node:assert/strict"

import {
  BUILTIN_SERVER_NAME,
  BUILTIN_SERVER_VERSION,
  READ_ONLY_TOOL_NAMES,
  TOOL_NAMES_BY_CATEGORY,
} from "./catalog.ts"

test("the built-in server identity comes from the metadata JSON", () => {
  assert.equal(BUILTIN_SERVER_NAME, "cognia-tools")
  assert.match(BUILTIN_SERVER_VERSION, /^\d+\.\d+\.\d+$/)
})

test("read-only tools are a subset of the catalogued tools", () => {
  const all = new Set(Object.values(TOOL_NAMES_BY_CATEGORY).flat())
  assert.ok(READ_ONLY_TOOL_NAMES.size > 0)
  for (const name of READ_ONLY_TOOL_NAMES) assert.ok(all.has(name), name)
})

test("the catalog is frozen", () => {
  assert.ok(Object.isFrozen(TOOL_NAMES_BY_CATEGORY))
  assert.ok(Object.isFrozen(READ_ONLY_TOOL_NAMES))
})
