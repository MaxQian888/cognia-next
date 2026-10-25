import { test } from "node:test"
import assert from "node:assert/strict"

import {
  commandHasGhWrite,
  ghInvocationKind,
  ghInvocationKinds,
  GH_LOCAL_COMMANDS,
  GH_READ_COMMANDS,
  shellCommandOf,
} from "./gh-writes.ts"

const kind = (line: string) => ghInvocationKind(line.split(/\s+/).filter(Boolean))

test("reads, writes and local changes", () => {
  for (const line of [
    "",
    "pr view 3",
    "pr",
    "repo deploy-key list",
    "api repos/o/r",
    "pr create --help",
  ]) {
    assert.equal(kind(line), "read", line)
  }
  for (const line of [
    "pr create --fill",
    "pr -R o/r create",
    "issue comment 3 -b x",
    "api -X POST repos/o/r/issues",
    "api repos/o/r/issues -f title=x",
    "api -X GET search/issues -f q=x",
    "repo create o/n -h https://x.dev",
    "copilot suggest x",
  ]) {
    assert.equal(kind(line), "write", line)
  }
  for (const line of ["auth login", "extension install o/x"])
    assert.equal(kind(line), "local", line)
  for (const command of GH_LOCAL_COMMANDS) assert.equal(GH_READ_COMMANDS.has(command), false)
})

test("finds gh in every segment, behind wrappers and inside substitutions", () => {
  assert.deepEqual(
    ghInvocationKinds("git status && sudo gh pr view 1 | cat; echo $(gh pr merge 2)"),
    ["read", "write"]
  )
  assert.equal(commandHasGhWrite("GH_REPO=o/r env A=1 /usr/local/bin/gh pr create"), true)
  assert.equal(commandHasGhWrite("gh pr view 3 && echo 'gh pr create'"), false)
  assert.equal(commandHasGhWrite("   "), false)
})

test("reads the command each shell tool runs", () => {
  assert.equal(shellCommandOf("bash", { command: "gh pr create" }), "gh pr create")
  assert.equal(shellCommandOf("sandbox_bash", { command: " " }), null)
  assert.equal(
    shellCommandOf("shell_execute_advanced", { command: "gh", args: ["pr", 3, "merge"] }),
    "gh pr merge"
  )
  assert.equal(
    shellCommandOf("start_process", { program: "gh", args: ["run", "rerun"] }),
    "gh run rerun"
  )
  assert.equal(shellCommandOf("write", { command: "gh pr create" }), null)
  assert.equal(shellCommandOf("bash", ["gh"]), null)
})
