import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

import {
  ALLOWED_COMMANDS,
  BLOCKED_COMMANDS,
  DANGEROUS_PATTERNS,
  findDangerousShellFragment,
  assertPathInside,
  normaliseAbsolutePath,
  toolError,
  toolText,
  validateShellCommand,
} from "../safety.mjs"

function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cognia-safety-${prefix}-`))
  return dir
}

test("assertPathInside accepts a child path", () => {
  const root = mkTmp("inside")
  const target = path.join(root, "child.txt")
  fs.writeFileSync(target, "x")
  const ok = assertPathInside(root, target)
  assert.equal(ok, fs.realpathSync.native(target))
  fs.rmSync(root, { recursive: true, force: true })
})

test("assertPathInside accepts a relative path resolved against root", () => {
  const root = mkTmp("rel")
  fs.writeFileSync(path.join(root, "child.txt"), "x")
  const ok = assertPathInside(root, "child.txt")
  assert.ok(ok.endsWith("child.txt"))
  fs.rmSync(root, { recursive: true, force: true })
})

test("assertPathInside accepts the root itself", () => {
  const root = mkTmp("root")
  const ok = assertPathInside(root, root)
  assert.equal(ok, fs.realpathSync.native(root))
  fs.rmSync(root, { recursive: true, force: true })
})

test("assertPathInside rejects ../ traversal", () => {
  const root = mkTmp("traversal")
  // Build a sibling file outside root.
  const outside = path.join(path.dirname(root), `outside-${Date.now()}.txt`)
  fs.writeFileSync(outside, "x")
  assert.throws(
    () => assertPathInside(root, path.join(root, "..", path.basename(outside))),
    /escapes root/
  )
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { force: true })
})

test("assertPathInside rejects unrelated absolute paths", () => {
  const root = mkTmp("abs")
  const elsewhere = mkTmp("elsewhere")
  assert.throws(() => assertPathInside(root, path.join(elsewhere, "x")), /escapes root/)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(elsewhere, { recursive: true, force: true })
})

test("assertPathInside requires non-empty inputs", () => {
  assert.throws(() => assertPathInside("", "/x"), /rootCwd/)
  assert.throws(() => assertPathInside("/x", ""), /target/)
})

test("assertPathInside doesn't confuse '/aa' with '/a' as a prefix", () => {
  const a = mkTmp("dir-a")
  const aa = a + "a"
  fs.mkdirSync(aa, { recursive: true })
  assert.throws(() => assertPathInside(a, aa), /escapes root/)
  fs.rmSync(a, { recursive: true, force: true })
  fs.rmSync(aa, { recursive: true, force: true })
})

test("assertPathInside tolerates non-existent targets (write paths)", () => {
  const root = mkTmp("write")
  const target = path.join(root, "subdir", "newfile.txt")
  // Doesn't exist yet — should still be inside root.
  const ok = assertPathInside(root, target)
  assert.ok(ok.startsWith(fs.realpathSync.native(root)))
  fs.rmSync(root, { recursive: true, force: true })
})

test("normaliseAbsolutePath returns a resolved absolute path", () => {
  const got = normaliseAbsolutePath("./foo")
  assert.ok(path.isAbsolute(got))
})

test("normaliseAbsolutePath rejects empty input", () => {
  assert.throws(() => normaliseAbsolutePath(""))
})

test("validateShellCommand allows git status", () => {
  const r = validateShellCommand("git", ["status"])
  assert.equal(r.safe, true)
})

test("validateShellCommand rejects rm -rf /", () => {
  const r = validateShellCommand("rm", ["-rf", "/"])
  assert.equal(r.safe, false)
  if (!r.safe) assert.match(r.reason, /blocked/i)
})

test("validateShellCommand rejects unknown commands", () => {
  const r = validateShellCommand("definitely-not-a-real-tool", [])
  assert.equal(r.safe, false)
  if (!r.safe) assert.match(r.reason, /not in the allowed/i)
})

test("validateShellCommand rejects shell-injection in args", () => {
  const cases = [
    ["git", ["status; rm -rf /"]],
    ["ls", ["foo | rm -rf bar"]],
    ["ls", ["x && rm -rf /tmp"]],
    ["echo", ["`rm -rf /`"]],
    ["echo", ["$(rm -rf /)"]],
  ]
  for (const [cmd, args] of cases) {
    const r = validateShellCommand(cmd, args)
    assert.equal(r.safe, false, `${cmd} ${JSON.stringify(args)} should be unsafe`)
    if (!r.safe) assert.match(r.reason, /Dangerous|blocked/i)
  }
})

test("validateShellCommand rejects redirects to /dev/", () => {
  const r = validateShellCommand("cat", [">", "/dev/sda"])
  assert.equal(r.safe, false)
})

test("validateShellCommand strips .exe before lookup (Windows-friendly)", () => {
  const r = validateShellCommand("git.exe", ["status"])
  assert.equal(r.safe, true)
})

test("validateShellCommand rejects empty command", () => {
  const r = validateShellCommand("", [])
  assert.equal(r.safe, false)
})

test("validateShellCommand rejects non-string args", () => {
  // @ts-ignore — intentionally passing a number to verify the guard.
  const r = validateShellCommand("git", [42])
  assert.equal(r.safe, false)
})

test("ALLOWED and BLOCKED command sets are mutually exclusive", () => {
  for (const cmd of ALLOWED_COMMANDS) {
    assert.equal(BLOCKED_COMMANDS.has(cmd), false, `${cmd} appears on both lists`)
  }
})

test("DANGEROUS_PATTERNS catches representative strings", () => {
  assert.ok(DANGEROUS_PATTERNS.some((p) => p.test("; rm -rf /")))
  assert.ok(DANGEROUS_PATTERNS.some((p) => p.test("> /dev/sda")))
})

test("DANGEROUS_PATTERNS does not misclassify a malformed find expression", () => {
  const command =
    'find /Users/bytedance/Project/cognia-next -maxdepth 1 -type f -name "*.ts\\" -o -name \\"*.tsx" -o -name "*.json\\" -o -name \\"*.md" | sort'
  assert.equal(
    DANGEROUS_PATTERNS.some((pattern) => pattern.test(command)),
    false
  )
})

test("findDangerousShellFragment uses shell structure instead of matching quoted text", () => {
  assert.equal(findDangerousShellFragment("printf ok >/dev/null"), null)
  assert.equal(findDangerousShellFragment("echo '>/dev/sda && rm -rf /'"), null)
  assert.match(findDangerousShellFragment("printf bad >/dev/sda")?.fragment ?? "", />\/dev\/sda/)
  assert.match(findDangerousShellFragment("echo $(rm -rf /)")?.fragment ?? "", /rm/)
})

test("toolText wraps a string in MCP content shape", () => {
  const r = toolText("hello")
  assert.deepEqual(r, { content: [{ type: "text", text: "hello" }] })
})

test("toolText JSON-serialises non-string payloads", () => {
  const r = toolText({ a: 1 })
  assert.match(r.content[0].text, /"a":\s*1/)
})

test("toolText sets isError when requested", () => {
  const r = toolText("oops", { isError: true })
  assert.equal(r.isError, true)
})

test("toolError formats Error instances", () => {
  const r = toolError(new Error("boom"), "ctx")
  assert.equal(r.isError, true)
  assert.equal(r.content[0].text, "ctx: boom")
})

test("toolError formats plain strings", () => {
  const r = toolError("nope")
  assert.equal(r.isError, true)
  assert.equal(r.content[0].text, "nope")
})

test("toolError handles unknown error shapes", () => {
  const r = toolError(42)
  assert.equal(r.isError, true)
  assert.equal(r.content[0].text, "42")
})
