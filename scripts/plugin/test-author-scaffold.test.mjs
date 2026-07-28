import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

test("scaffold acceptance covers generation, install, typecheck, test, build, lint, and package", () => {
  const source = readFileSync(new URL("./test-author-scaffold.mjs", import.meta.url), "utf8")
  for (const expected of [
    '"plugin:create"',
    "COGNIA_PLUGIN_CLI",
    '"install", "--no-frozen-lockfile", "--prefer-offline"',
    '"types/cognia-plugin-sdk.d.ts"',
    '"types/provider-types/index.d.ts"',
    '"types/provider-core/core/client.d.ts"',
    '"tsc", "--noEmit"',
    '"jest", "--runInBand"',
    '"plugin", "lint"',
    '"plugin", "build"',
  ]) {
    assert.match(source, new RegExp(expected))
  }
})
