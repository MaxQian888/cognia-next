import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

import { forwardedJestArgs } from "./jest.mjs"

test("drops the separator pnpm leaves in front of forwarded arguments", () => {
  assert.deepEqual(forwardedJestArgs(["--", "lib/a.test.ts", "-t", "name", "--maxWorkers=1"]), [
    "lib/a.test.ts",
    "-t",
    "name",
    "--maxWorkers=1",
  ])
})

test("leaves arguments without a leading separator alone", () => {
  assert.deepEqual(forwardedJestArgs(["lib/a.test.ts", "--runInBand"]), [
    "lib/a.test.ts",
    "--runInBand",
  ])
  assert.deepEqual(forwardedJestArgs([]), [])
})

test("keeps a separator the caller wrote after other arguments", () => {
  assert.deepEqual(forwardedJestArgs(["--runInBand", "--", "x"]), ["--runInBand", "--", "x"])
})

// End to end through the real Jest binary: a flag after `--` must act as a
// flag. `--version` prints and exits without building the config or the Haste
// map, so this stays cheap; before the fix Jest took it as a path pattern and
// went looking for test files instead.
test("a flag forwarded after `--` reaches Jest as a flag", () => {
  const result = spawnSync(process.execPath, ["scripts/test/jest.mjs", "--", "--version"], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/)
})
