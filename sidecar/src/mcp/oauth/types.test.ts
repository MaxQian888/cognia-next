import assert from "node:assert/strict"
import { test } from "node:test"

import { msg } from "./types.ts"

test("structured flow errors retain messages for Error and non-Error failures", () => {
  assert.equal(msg(new Error("network unavailable")), "network unavailable")
  assert.equal(msg("denied"), "denied")
  assert.equal(msg(null), "null")
})
