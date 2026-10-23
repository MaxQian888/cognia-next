import test from "node:test"
import assert from "node:assert/strict"

import {
  applyEmbeddedClaudeExecutable,
  resolveStandaloneClaudeExecutable,
  ensureClaudeRuntimePolicyCompatibility,
  supportsClaudeRuntimePolicies,
} from "./executable.ts"
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("runtime version diagnostics never expose executable stdout or stderr", async () => {
  const root = mkdtempSync(join(tmpdir(), "cognia-claude-version-private-"))
  const executable = join(root, "claude")
  try {
    for (const source of [
      "#!/bin/sh\necho 'private-version-output' >&2\nexit 1\n",
      "#!/bin/sh\necho '2.1.304 private-version-output'\n",
      "#!/bin/sh\necho 'private-version-output'\n",
    ]) {
      writeFileSync(executable, source)
      chmodSync(executable, 0o700)
      await assert.rejects(
        ensureClaudeRuntimePolicyCompatibility(
          { pathToClaudeCodeExecutable: executable, env: {} },
          new AbortController().signal
        ),
        (error: Error) => {
          assert.doesNotMatch(error.message, /private-version-output/)
          assert.match(error.message, /Claude Code runtime version|Claude Code >=2.1.305/)
          return true
        }
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("runtime policy compatibility refuses older, prerelease and unproven CLI versions", async () => {
  for (const version of ["2.1.304", "2.0.999", "unknown", "2.1.305-beta.1"])
    assert.equal(supportsClaudeRuntimePolicies(version), false)
  for (const version of ["2.1.305", "2.1.305 (Claude Code)", "2.1.306", "3.0.0"])
    assert.equal(supportsClaudeRuntimePolicies(version), true)
  const root = mkdtempSync(join(tmpdir(), "cognia-claude-version-"))
  const executable = join(root, "claude")
  try {
    writeFileSync(executable, "#!/bin/sh\necho '2.1.304 (Claude Code)'\n")
    chmodSync(executable, 0o700)
    await assert.rejects(
      ensureClaudeRuntimePolicyCompatibility(
        { pathToClaudeCodeExecutable: executable, env: {} },
        new AbortController().signal
      ),
      />=2.1.305.*2.1.304/
    )
    writeFileSync(executable, "#!/bin/sh\necho '2.1.305 (Claude Code)'\n")
    await ensureClaudeRuntimePolicyCompatibility(
      { pathToClaudeCodeExecutable: executable, env: {} },
      new AbortController().signal
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("resolves standalone Claude by environment, then adjacent, then PATH precedence", () => {
  const existing = new Set(["/dist/claude", "/configured/claude", "/usr/local/bin/claude"])
  const options = {
    execPath: "/dist/cognia-agent",
    env: {
      COGNIA_CLAUDE_EXECUTABLE: "/configured/claude",
      PATH: "/usr/local/bin:/usr/bin",
    },
    platform: "darwin" as const,
    isExecutable: (candidate: string) => existing.has(candidate),
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
      isExecutable: (candidate: string) => candidate === "/dist/claude",
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
      isExecutable: (candidate: string) => candidate === "C:\\Tools\\claude.EXE",
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
