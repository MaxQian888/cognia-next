import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveToolVerdict, resolveForToolCall, matchGlob } from "./permission-resolver.mjs"

test("matchGlob handles * and basename fallback", () => {
  assert.equal(matchGlob("git push*", "git push origin"), true)
  assert.equal(matchGlob("*.env", "/proj/.env"), true)
  assert.equal(matchGlob("rm*", "ls"), false)
})

test("resolveToolVerdict returns null when nothing matches", () => {
  assert.equal(resolveToolVerdict({ Bash: { "git push*": "ask" } }, "Bash", "ls"), null)
})

test("resolveToolVerdict matches an explicit rule", () => {
  assert.equal(resolveToolVerdict({ Bash: { "git push*": "deny" } }, "Bash", "git push x"), "deny")
})

test("resolveToolVerdict: more specific tool key wins over wildcard", () => {
  const rs = { "*": { "*": "deny" }, Bash: { "ls*": "allow" } }
  assert.equal(resolveToolVerdict(rs, "Bash", "ls -la"), "allow")
})

test("resolveForToolCall allows only when every segment is explicitly allowed", () => {
  const rs = { Bash: { "ls*": "allow", "cat*": "allow" } }
  assert.equal(resolveForToolCall(rs, "Bash", { command: "ls && cat x" }), "allow")
})

test("resolveForToolCall asks when a segment is unruled", () => {
  const rs = { Bash: { "ls*": "allow" } }
  assert.equal(resolveForToolCall(rs, "Bash", { command: "ls && git push" }), "ask")
})

test("resolveForToolCall denies when any segment is denied", () => {
  const rs = { Bash: { "ls*": "allow", "rm*": "deny" } }
  assert.equal(resolveForToolCall(rs, "Bash", { command: "ls && rm -rf x" }), "deny")
})

test("resolveForToolCall: no ruleset / no match falls through to ask", () => {
  assert.equal(resolveForToolCall(null, "Bash", { command: "ls" }), "ask")
  assert.equal(resolveForToolCall({}, "Bash", { command: "ls" }), "ask")
})

test("resolveForToolCall reads shell_execute_advanced command+args", () => {
  const rs = { Bash: { "git status*": "allow" } }
  assert.equal(
    resolveForToolCall(rs, "shell_execute_advanced", { command: "git", args: ["status", "-s"] }),
    "allow"
  )
})

test("resolveForToolCall resolves a non-shell tool target directly", () => {
  const rs = { Read: { "**/*.env": "deny" } }
  assert.equal(resolveForToolCall(rs, "Read", { file_path: "/proj/.env" }), "deny")
  assert.equal(resolveForToolCall(rs, "Read", { file_path: "/proj/index.ts" }), "ask")
})
