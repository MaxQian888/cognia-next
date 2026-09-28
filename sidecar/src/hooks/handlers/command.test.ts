import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runCommandHandler } from "../agent-hooks.ts"
import { nodeCmd } from "../../../test-support/hook-command.ts"

test("runCommandHandler: exit 2 blocks with stderr reason", async () => {
  const out = await runCommandHandler(
    nodeCmd("process.stderr.write('denied by policy');process.exit(2)"),
    undefined,
    "{}"
  )
  assert.equal(out.block, "denied by policy")
})

test("runCommandHandler: exit 2 with no output falls back", async () => {
  const out = await runCommandHandler(nodeCmd("process.exit(2)"), undefined, "{}")
  assert.equal(out.block, "hook denied (no message)")
})

test("runCommandHandler: exit 0 JSON decision honoured", async () => {
  const out = await runCommandHandler(
    nodeCmd(
      "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'ls -la'}}}))"
    ),
    undefined,
    "{}"
  )
  assert.deepEqual(out.updatedInput, { command: "ls -la" })
  assert.equal(out.permissionDecision, "allow")
})

test("runCommandHandler: exit 0 plain stdout becomes context", async () => {
  const out = await runCommandHandler(
    nodeCmd("process.stdout.write('hello world')"),
    undefined,
    "{}"
  )
  assert.equal(out.additionalContext, "hello world")
})

test("runCommandHandler: payload is piped to stdin", async () => {
  // Use a temp helper script + shell-quoted path — inline `node -e` quoting is
  // unreliable across cmd.exe / sh for a stdin-reading snippet.
  const helper = join(tmpdir(), "cognia-agent-hooks-echo-stdin.mjs")
  // Prefix so the echoed payload is NOT valid JSON — otherwise it'd be parsed
  // as a decision object instead of landing as additionalContext.
  writeFileSync(
    helper,
    'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write("stdin:"+d));'
  )
  const out = await runCommandHandler(
    `node ${JSON.stringify(helper)}`,
    undefined,
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" })
  )
  // The echoed payload is plain text (not a decision), so it lands as context.
  assert.match(out.additionalContext!, /PreToolUse/)
})

test("runCommandHandler: non-zero/non-2 exit is a soft warning", async () => {
  const out = await runCommandHandler(nodeCmd("process.exit(1)"), undefined, "{}")
  assert.match(out.warning!, /code 1/)
})

test("runCommandHandler: timeout kills and soft-allows", async () => {
  const out = await runCommandHandler(nodeCmd("setTimeout(()=>{},10000)"), 1, "{}")
  assert.match(out.warning!, /timed out/)
})

test("runCommandHandler: pre-aborted signal warns", async () => {
  const ac = new AbortController()
  ac.abort()
  const out = await runCommandHandler(nodeCmd("setTimeout(()=>{},10000)"), 5, "{}", ac.signal)
  assert.match(out.warning!, /aborted/)
})

test("runCommandHandler: runs the hook in the session cwd when provided", async () => {
  const os = await import("node:os")
  const cwd = os.tmpdir()
  const out = await runCommandHandler(
    nodeCmd("console.log(JSON.stringify({additionalContext: process.cwd()}))"),
    undefined,
    "{}",
    undefined,
    cwd
  )
  const fs = await import("node:fs")
  assert.equal(fs.realpathSync(out.additionalContext!), fs.realpathSync(cwd))
})

test("runCommandHandler: a hook that exits without reading stdin does not crash (EPIPE)", async () => {
  // Large payload forces the write past the pipe buffer while the child has
  // already exited — the async EPIPE on child.stdin must be swallowed, not
  // become an uncaughtException.
  const payload = JSON.stringify({ pad: "x".repeat(1024 * 1024) })
  const out = await runCommandHandler(nodeCmd("process.exit(0)"), undefined, payload)
  assert.deepEqual(out, {})
})
