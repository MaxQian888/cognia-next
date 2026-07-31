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

test("core bash names resolve command segments against Bash rules", () => {
  const rs = { Bash: { ls: "allow", "rm *": "deny" } }
  assert.equal(resolveForToolCall(rs, "bash", { command: "ls" }), "allow")
  assert.equal(resolveForToolCall(rs, "mcp__cognia-tools__bash", { command: "ls" }), "allow")
  assert.equal(resolveForToolCall(rs, "bash", { command: "rm -rf x" }), "deny")
  assert.equal(resolveForToolCall(rs, "bash", { command: "git push" }), "ask")
})

test("core bash also honours rules keyed under its own tool name (severe wins)", () => {
  const rs = { Bash: { "git *": "allow" }, bash: { "git push*": "deny" } }
  assert.equal(resolveForToolCall(rs, "bash", { command: "git status" }), "allow")
  assert.equal(resolveForToolCall(rs, "bash", { command: "git push origin" }), "deny")
})

test("core file tools resolve file_path targets directly", () => {
  const rs = { edit: { "**/*.env": "deny" }, write: "ask" }
  assert.equal(resolveForToolCall(rs, "edit", { file_path: "a/b/.env" }), "deny")
  assert.equal(resolveForToolCall(rs, "edit", { file_path: "src/x.ts" }), "ask")
  assert.equal(resolveForToolCall(rs, "write", { file_path: "src/x.ts" }), "ask")
})

// A denied command hidden in a substitution used to produce a single segment
// that matched nothing, resolved to "ask", and so fell out of this hard gate
// into the approval round-trip — which an unattended run cannot answer.
test("resolveForToolCall surfaces a denied command inside a substitution", () => {
  const rs = { Bash: { "git push": "deny", "git push **": "deny" } }
  for (const command of [
    "echo $(git push)",
    "echo `git push`",
    "(git push)",
    "FOO=$(git push origin main) echo done",
    "echo $(echo $(git push))",
  ]) {
    assert.equal(resolveForToolCall(rs, "Bash", { command }), "deny", command)
  }
})

test("resolveForToolCall does not split inside quotes", () => {
  const rs = { Bash: { "git push": "deny", "git push **": "deny", "git commit **": "allow" } }
  // `;` inside the quoted message is not a statement separator, so this stays
  // one segment and keeps its explicit allow instead of fragmenting.
  assert.equal(resolveForToolCall(rs, "Bash", { command: `git commit -m "a; b"` }), "allow")
})

test("resolveForToolCall splits on background and pipe operators", () => {
  const rs = { Bash: { "git push": "deny", "git push **": "deny", "**": "allow" } }
  assert.equal(resolveForToolCall(rs, "Bash", { command: "sleep 1 & git push" }), "deny")
  assert.equal(resolveForToolCall(rs, "Bash", { command: "cat x | git push" }), "deny")
})
