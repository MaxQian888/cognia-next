import assert from "node:assert/strict"
import { test } from "node:test"

import { parseArgs } from "./build-vscode-ext-host-sidecar.mjs"

test("parseArgs supports install-only mode and rejects unknown options", () => {
  assert.deepEqual(parseArgs([]), { installOnly: false })
  assert.deepEqual(parseArgs(["--install-only"]), { installOnly: true })
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})
