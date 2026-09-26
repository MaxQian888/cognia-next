import { test } from "node:test"
import assert from "node:assert/strict"

import { validateShellCommand } from "./validate.ts"

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
