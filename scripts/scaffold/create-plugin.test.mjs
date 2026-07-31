import { test } from "node:test"
import assert from "node:assert/strict"

import { runCanonicalCli, toCanonicalCliArgs } from "./create-plugin.mjs"

test("translates the legacy frontend flags to the canonical Rust CLI", () => {
  assert.deepEqual(
    toCanonicalCliArgs([
      "--",
      "--name",
      "weather-plugin",
      "--type",
      "frontend",
      "--dir",
      "./plugins/weather",
      "--yes",
    ]),
    ["plugin", "new", "--dir", "./plugins/weather", "--yes", "weather-plugin", "--kind", "ts"]
  )
})

test("passes canonical template kinds and author metadata through", () => {
  assert.deepEqual(
    toCanonicalCliArgs([
      "hello-plugin",
      "--kind",
      "hybrid",
      "--author",
      "Ada",
      "--author-email",
      "ada@example.com",
    ]),
    [
      "plugin",
      "new",
      "--author",
      "Ada",
      "--author-email",
      "ada@example.com",
      "hello-plugin",
      "--kind",
      "hybrid",
    ]
  )
})

test("rejects flags that would revive the legacy template implementation", () => {
  assert.throws(() => toCanonicalCliArgs(["--force"]), /not supported/)
  assert.throws(() => toCanonicalCliArgs(["--capabilities", "tools"]), /not supported/)
  assert.throws(() => toCanonicalCliArgs(["--unknown", "x"]), /unknown option/)
})

test("delegates exactly once and propagates failures", () => {
  const calls = []
  runCanonicalCli(["demo", "--type", "python"], {
    executable: "test-cognia",
    spawn: (...args) => {
      calls.push(args)
      return { status: 0 }
    },
  })
  assert.deepEqual(calls, [
    ["test-cognia", ["plugin", "new", "demo", "--kind", "python"], { stdio: "inherit" }],
  ])

  assert.throws(() => runCanonicalCli([], { spawn: () => ({ status: 2 }) }), /exited with status 2/)
})
