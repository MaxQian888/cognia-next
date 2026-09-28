import assert from "node:assert/strict"
import { test } from "node:test"

import { asRecord, errorMessage, handlerPolicyClass } from "./types.ts"

test("wire helpers retain thrown values and only inspect object properties", () => {
  assert.equal(asRecord(null), undefined)
  assert.equal(asRecord("unavailable"), undefined)
  assert.equal(errorMessage(new Error("unavailable")), "unavailable")
  assert.equal(errorMessage("unavailable"), "unavailable")
  const value = { reason: "unavailable" }
  assert.equal(errorMessage(value), value)
})

test("only an explicit managed policy opts into failure blocking", () => {
  assert.equal(handlerPolicyClass(undefined), "user")
  assert.equal(handlerPolicyClass({ policyClass: "unknown" }), "user")
  assert.equal(handlerPolicyClass({ policyClass: "managed" }), "managed")
})
