import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import assert from "node:assert/strict"

test("tests packed ESM, CJS, declarations, contents, and monorepo independence", () => {
  const script = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "test-sdk-package.mjs"),
    "utf8"
  )
  assert.match(script, /run\("node", \["esm\.mjs"\]/)
  assert.match(script, /run\("node", \["cjs\.cjs"\]/)
  assert.match(script, /node_modules\/\.bin\/tsc/)
  assert.match(script, /packed SDK must not contain host-linked source/)
})
