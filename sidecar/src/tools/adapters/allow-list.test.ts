import { test } from "node:test"
import assert from "node:assert/strict"

import { CLAUDE_TOOL_NAME_BY_COGNIA_BARE, passesAllowList } from "./allow-list.ts"

test("an absent or empty whitelist admits every tool", () => {
  assert.equal(passesAllowList(null, ["read"]), true)
  assert.equal(passesAllowList(undefined, ["read"]), true)
  assert.equal(passesAllowList(new Set(), ["read"]), true)
})

test("a whitelist admits a tool when any candidate name matches", () => {
  const allow = new Set(["Read", "mcp__cognia-tools__grep"])
  assert.equal(passesAllowList(allow, ["read", "mcp__cognia-tools__read", "Read"]), true)
  assert.equal(passesAllowList(allow, ["grep", "mcp__cognia-tools__grep"]), true)
  assert.equal(passesAllowList(allow, ["bash", "mcp__cognia-tools__bash", "Bash"]), false)
})

test("core file tools map to their Claude Code names; the table is frozen", () => {
  assert.equal(CLAUDE_TOOL_NAME_BY_COGNIA_BARE.read, "Read")
  assert.equal(CLAUDE_TOOL_NAME_BY_COGNIA_BARE.multi_edit, "MultiEdit")
  assert.equal(CLAUDE_TOOL_NAME_BY_COGNIA_BARE.git_status, undefined)
  assert.ok(Object.isFrozen(CLAUDE_TOOL_NAME_BY_COGNIA_BARE))
})
