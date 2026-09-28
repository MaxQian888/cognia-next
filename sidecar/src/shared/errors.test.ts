import test from "node:test"
import assert from "node:assert/strict"
import { errorMessage, errorStack } from "./errors.ts"

test("preserves thrown values and cross-realm error details", () => {
  assert.equal(errorMessage(new Error("failed")), "failed")
  assert.equal(errorMessage({ message: "remote" }), "remote")
  assert.equal(errorMessage(null), "null")
  assert.equal(errorMessage("plain"), "plain")
  assert.equal(errorStack({ message: "failed", stack: "trace" }), "trace")
  assert.equal(errorStack({ message: "failed" }), "failed")
})
