import { test } from "node:test"
import assert from "node:assert/strict"

import { assertRepo, trimTail } from "./run.mjs"

test("assertRepo rejects empty cwd", async () => {
  await assert.rejects(() => assertRepo(""), /cwd/)
})

test("trimTail leaves short strings alone and truncates long ones", () => {
  const short = "x".repeat(10)
  assert.deepEqual(trimTail(short, 100), { text: short, truncated: false })
  const long = "y".repeat(500)
  const t = trimTail(long, 50)
  assert.equal(t.truncated, true)
  assert.match(t.text, /truncated/)
})
