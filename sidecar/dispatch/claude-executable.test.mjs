import test from "node:test"
import assert from "node:assert/strict"

import {
  applyEmbeddedClaudeExecutable,
  resolveStandaloneClaudeExecutable,
} from "./claude-executable.mjs"

test("resolves standalone Claude by environment, then adjacent, then PATH precedence", () => {
  const existing = new Set(["/dist/claude", "/configured/claude", "/usr/local/bin/claude"])
  const options = {
    execPath: "/dist/cognia-agent",
    env: {
      COGNIA_CLAUDE_EXECUTABLE: "/configured/claude",
      PATH: "/usr/local/bin:/usr/bin",
    },
    platform: "darwin",
    isExecutable: (candidate) => existing.has(candidate),
  }

  // The explicit pin outranks the bundled runtime. Checking the adjacent binary
  // first made `COGNIA_CLAUDE_EXECUTABLE` unreachable on the full distribution,
  // which always ships one — the override the error message advertises could
  // never take effect.
  assert.equal(resolveStandaloneClaudeExecutable(options), "/configured/claude")
  existing.delete("/configured/claude")
  assert.equal(resolveStandaloneClaudeExecutable(options), "/dist/claude")
  existing.delete("/dist/claude")
  assert.equal(resolveStandaloneClaudeExecutable(options), "/usr/local/bin/claude")
})

test("an unresolvable COGNIA_CLAUDE_EXECUTABLE falls back to the adjacent runtime", () => {
  assert.equal(
    resolveStandaloneClaudeExecutable({
      execPath: "/dist/cognia-agent",
      env: { COGNIA_CLAUDE_EXECUTABLE: "/gone/claude", PATH: "/empty" },
      platform: "linux",
      isExecutable: (candidate) => candidate === "/dist/claude",
    }),
    "/dist/claude"
  )
})

test("uses claude.exe and PATHEXT when resolving a Windows standalone", () => {
  assert.equal(
    resolveStandaloneClaudeExecutable({
      execPath: "C:\\Cognia\\cognia-agent.exe",
      env: { PATH: "C:\\Tools", PATHEXT: ".COM;.EXE;.BAT" },
      platform: "win32",
      isExecutable: (candidate) => candidate === "C:\\Tools\\claude.EXE",
    }),
    "C:\\Tools\\claude.EXE"
  )
})

test("fails with an actionable error when a standalone has no Claude runtime", () => {
  assert.throws(
    () =>
      resolveStandaloneClaudeExecutable({
        execPath: "/dist/cognia-agent",
        env: { PATH: "/empty" },
        platform: "linux",
        isExecutable: () => false,
      }),
    /(?=.*COGNIA_CLAUDE_EXECUTABLE)(?=.*full)(?=.*PATH)/s
  )
})

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
