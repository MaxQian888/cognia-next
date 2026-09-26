import { test } from "node:test"
import assert from "node:assert/strict"

import { stableStringify } from "./stable-stringify.ts"

test("stableStringify sorts keys recursively and handles arrays/primitives", () => {
  assert.equal(stableStringify({ b: [{ d: 1, c: 2 }], a: null }), '{"a":null,"b":[{"c":2,"d":1}]}')
  assert.equal(stableStringify("s"), '"s"')
  assert.equal(stableStringify(3), "3")
})
