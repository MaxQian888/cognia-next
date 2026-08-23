import test from "node:test"
import assert from "node:assert/strict"

import { applyEmbeddedClaudeExecutable } from "./claude-executable.mjs"

test("injects the extracted Claude executable into SDK-owned options", () => {
  const options = { cwd: "/workspace" }
  assert.deepEqual(
    applyEmbeddedClaudeExecutable(options, () => "/tmp/claude/claude"),
    {
      cwd: "/workspace",
      pathToClaudeCodeExecutable: "/tmp/claude/claude",
    }
  )
  assert.deepEqual(options, { cwd: "/workspace" })
})

test("leaves source-runtime options unchanged when no embedded executable exists", () => {
  const options = { cwd: "/workspace" }
  assert.equal(
    applyEmbeddedClaudeExecutable(options, () => undefined),
    options
  )
})
