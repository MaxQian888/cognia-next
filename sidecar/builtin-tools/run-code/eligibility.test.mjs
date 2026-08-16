import { test } from "node:test"
import assert from "node:assert/strict"

import metadata from "../../../lib/settings/builtin-tools-data.json" with { type: "json" }
import {
  checkToolEligibility,
  isProgrammaticReadOnly,
  programmaticReadOnlyToolNames,
} from "./eligibility.mjs"

const ALL_TOOLS = metadata.categories.flatMap((c) => c.tools)

test("the allowlist is non-empty and reads from the shared metadata", () => {
  const names = programmaticReadOnlyToolNames()
  assert.ok(names.length > 0)
  for (const name of names) {
    const meta = ALL_TOOLS.find((t) => t.name === name)
    assert.ok(meta, `${name} must exist in the metadata`)
    assert.equal(meta.programmaticReadOnly, true)
  }
})

test("every eligible tool is also non-approval-requiring", () => {
  // Eligibility is stricter than the approval flag, never looser: a tool that
  // needed a per-call prompt could not be called in a loop from generated code.
  for (const name of programmaticReadOnlyToolNames()) {
    const meta = ALL_TOOLS.find((t) => t.name === name)
    assert.equal(meta.requiresApproval, false, `${name} must not require approval`)
  }
})

test("eligibility is NOT the same as requiresApproval === false", () => {
  const approvalFree = ALL_TOOLS.filter((t) => t.requiresApproval === false).map((t) => t.name)
  const eligible = new Set(programmaticReadOnlyToolNames())
  const divergence = approvalFree.filter((name) => !eligible.has(name))
  // If this is ever empty, someone has redefined eligibility as "skips the
  // prompt" — which would hand generated code TodoWrite and TaskCreate.
  assert.ok(divergence.length > 0, "the two concepts must not have collapsed")
})

test("state-mutating tools that skip the prompt are excluded", () => {
  for (const name of ["TodoWrite", "TaskCreate", "TaskUpdate", "monitor_cancel"]) {
    assert.equal(isProgrammaticReadOnly(name), false, `${name} must not be programmatic`)
  }
})

test("environment readers are excluded so secrets cannot be enumerated", () => {
  for (const name of ["list_env", "get_env"]) {
    assert.equal(isProgrammaticReadOnly(name), false)
  }
})

test("no mutating tool is ever eligible", () => {
  const mutating = ["write", "edit", "bash", "git_commit", "git_push", "delete_file"]
  for (const name of mutating) {
    assert.equal(isProgrammaticReadOnly(name), false)
  }
})

test("the read/search surface is eligible", () => {
  for (const name of ["read", "grep", "glob", "ls", "file_hash", "ast_grep_search"]) {
    assert.equal(isProgrammaticReadOnly(name), true, `${name} should be programmatic`)
  }
})

test("distinguishes an ineligible tool from one that does not exist", () => {
  assert.deepEqual(checkToolEligibility("read"), { allowed: true })
  assert.deepEqual(checkToolEligibility("TodoWrite"), {
    allowed: false,
    reason: "not-programmatic-read-only",
  })
  assert.deepEqual(checkToolEligibility("definitely_not_a_tool"), {
    allowed: false,
    reason: "unknown-tool",
  })
})

test("trims whitespace but does not otherwise normalise", () => {
  assert.deepEqual(checkToolEligibility("  read  "), { allowed: true })
  assert.equal(checkToolEligibility("READ").allowed, false)
})

test("rejects non-string input rather than coercing it", () => {
  assert.equal(checkToolEligibility(undefined).allowed, false)
  assert.equal(checkToolEligibility(null).allowed, false)
  assert.equal(checkToolEligibility({}).allowed, false)
})
