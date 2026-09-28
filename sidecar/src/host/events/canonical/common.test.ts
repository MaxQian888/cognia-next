import test from "node:test"
import assert from "node:assert/strict"
import { compact, record, asNumber } from "./common.ts"

test("wire normalization preserves falsy values and excludes malformed records/numbers", () => {
  assert.deepEqual(compact({ zero: 0, flag: false, absent: undefined }), { zero: 0, flag: false })
  assert.deepEqual(record(null), {})
  assert.deepEqual(record("text"), {})
  assert.equal(asNumber(Number.NaN), undefined)
  assert.equal(asNumber(0), 0)
})
