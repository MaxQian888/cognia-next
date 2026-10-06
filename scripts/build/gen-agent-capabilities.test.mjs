import assert from "node:assert/strict"
import { test } from "node:test"

import { renderCapabilities } from "./gen-agent-capabilities.mjs"

test("the committed capability manifest is what the integration packages generate", async () => {
  const { current, next } = await renderCapabilities()
  assert.equal(next, current)
})
