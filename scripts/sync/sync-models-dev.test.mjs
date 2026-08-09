import assert from "node:assert/strict"
import { test } from "node:test"

import { parseArgs } from "./sync-models-dev.mjs"

test("parseArgs validates local input and revision options", () => {
  assert.deepEqual(parseArgs([]), {})
  assert.deepEqual(parseArgs(["--input", "fixtures/models.json", "--revision", "2026-08-08"]), {
    input: "fixtures/models.json",
    revision: "2026-08-08",
  })
  assert.throws(() => parseArgs(["--input"]), /argument missing/i)
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})
