import assert from "node:assert/strict"
import { test } from "node:test"

import { renderCatalog } from "./gen-external-agent-runtimes.mjs"

test("the committed runtime catalog is what the integration manifests generate", async () => {
  const { current, next } = await renderCatalog()
  assert.equal(next, current)
})
