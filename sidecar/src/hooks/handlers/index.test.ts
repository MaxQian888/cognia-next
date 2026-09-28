import assert from "node:assert/strict"
import { test } from "node:test"

import { applyFailurePolicy, runHandler } from "./index.ts"

test("unknown handlers have no opinion while malformed handlers report a warning", async () => {
  assert.deepEqual(await runHandler({ type: "future" }, "{}", undefined, undefined), {})
  assert.deepEqual(await runHandler(null, "{}", undefined, undefined), {
    warning: "invalid hook handler configuration",
  })
})

test("managed failure policy never replaces an explicit handler block", () => {
  const outcome = { block: "Policy denied", warning: "Transport warning" }
  assert.equal(applyFailurePolicy({ policyClass: "managed" }, outcome), outcome)
  assert.deepEqual(
    applyFailurePolicy({ policyClass: "managed" }, { warning: "Transport warning" }),
    {
      warning: "Transport warning",
      block: "Managed hook failed closed: Transport warning",
    }
  )
})
