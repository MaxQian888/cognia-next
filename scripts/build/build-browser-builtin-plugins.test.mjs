import assert from "node:assert/strict"
import { test } from "node:test"

import { BROWSER_BUILTIN_PLUGIN_IDS } from "./build-browser-builtin-plugins.mjs"

test("keeps the first migration batch explicit and deterministic", () => {
  assert.deepEqual(BROWSER_BUILTIN_PLUGIN_IDS, [
    "cognia-office",
    "cognia-pdf",
    "cognia-documents",
    "cognia-presentations",
    "cognia-visualize",
  ])
})
