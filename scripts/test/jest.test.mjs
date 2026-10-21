import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

import { forwardedJestArgs } from "./jest.mjs"

test("lanes preserve forwarded flags and keep their project selector separate from paths", () => {
  for (const [lane, projects] of Object.entries({
    unit: ["node", "jsdom"],
    heavy: ["heavy", "build", "pty"],
    build: ["build"],
    pty: ["pty"],
  })) {
    const args = forwardedJestArgs([`--lane=${lane}`, "--", "--listTests", "--json"])
    assert.deepEqual(args.slice(0, projects.length + 1), ["--selectProjects", ...projects])
    assert.equal(args[projects.length + 1], "--config")
    assert.deepEqual(args.slice(-2), ["--listTests", "--json"])
    assert.equal(args.includes("--"), false)
    assert.equal(args.includes("--maxWorkers=1"), lane !== "unit")
  }
  assert.throws(() => forwardedJestArgs(["--lane=unknown"]), /Unknown Jest lane/)
  assert.throws(() => forwardedJestArgs(["--lane=constructor"]), /Unknown Jest lane/)
  for (const args of [["--runInBand"], ["-i"], ["--maxWorkers=2"], ["-w", "2"]]) {
    assert.equal(
      forwardedJestArgs(["--lane=heavy", "--", ...args]).includes("--maxWorkers=1"),
      false
    )
  }
})

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
