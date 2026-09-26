import test from "node:test"
import assert from "node:assert/strict"

import {
  resolveShellDescriptor,
  activeShellDescriptor,
  applyNonInteractiveEnv,
  NON_INTERACTIVE_ENV,
  __resetShellDetectCache,
} from "./shell.ts"

// --- resolveShellDescriptor ----------------------------------------------

test("resolveShellDescriptor → POSIX sh off Windows", () => {
  const d = resolveShellDescriptor({ platform: "linux" })
  assert.equal(d.kind, "sh")
  assert.equal(d.bin, "/bin/sh")
  assert.equal(d.isWin, false)
  assert.deepEqual(d.buildArgs("echo hi"), ["-c", "echo hi"])
  assert.equal(d.syntaxHint, "")
})

test("resolveShellDescriptor → pwsh wins when present on Windows", () => {
  const d = resolveShellDescriptor({
    platform: "win32",
    lookup: (name) => (name.startsWith("pwsh") ? name : null),
  })
  assert.equal(d.kind, "pwsh")
  assert.equal(d.bin, "pwsh.exe")
  assert.equal(d.isWin, true)
  assert.deepEqual(d.buildArgs("Get-ChildItem"), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-ChildItem",
  ])
  assert.match(d.syntaxHint, /PowerShell/)
})

test("resolveShellDescriptor → powershell fallback when only it is present", () => {
  const d = resolveShellDescriptor({
    platform: "win32",
    lookup: (name) => (name.startsWith("powershell") ? name : null),
  })
  assert.equal(d.kind, "powershell")
  assert.equal(d.bin, "powershell.exe")
  assert.deepEqual(d.buildArgs("echo hi").slice(0, 3), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ])
})

test("resolveShellDescriptor → cmd.exe when no PowerShell on PATH", () => {
  const d = resolveShellDescriptor({
    platform: "win32",
    lookup: () => null,
    comspec: "C:\\Windows\\System32\\cmd.exe",
  })
  assert.equal(d.kind, "cmd")
  assert.equal(d.bin, "C:\\Windows\\System32\\cmd.exe")
  assert.deepEqual(d.buildArgs("dir"), ["/d", "/s", "/c", "dir"])
  assert.match(d.syntaxHint, /cmd\.exe/)
})

// --- env scrubbing --------------------------------------------------------

test("PowerShell sanitizeEnv drops PSModulePath / PSExecutionPolicyPreference", () => {
  const d = resolveShellDescriptor({
    platform: "win32",
    lookup: (n) => (n.startsWith("pwsh") ? n : null),
  })
  const cleaned = d.sanitizeEnv({
    PATH: "C:\\Windows",
    PSModulePath: "D:\\evil\\workspace",
    psexecutionpolicypreference: "Bypass",
    HOME: "C:\\Users\\u",
  })
  assert.equal(cleaned.PATH, "C:\\Windows")
  assert.equal(cleaned.HOME, "C:\\Users\\u")
  assert.ok(!("PSModulePath" in cleaned))
  assert.ok(!("psexecutionpolicypreference" in cleaned))
})

test("sh/cmd sanitizeEnv is identity (same ref, unscrubbed)", () => {
  const sh = resolveShellDescriptor({ platform: "linux" })
  const env = { PATH: "/bin", PSModulePath: "/whatever" }
  assert.equal(sh.sanitizeEnv(env), env)
  const cmd = resolveShellDescriptor({ platform: "win32", lookup: () => null })
  assert.equal(cmd.sanitizeEnv(env), env)
})

test("PowerShell sanitizeEnv returns the same ref when nothing to strip", () => {
  const d = resolveShellDescriptor({
    platform: "win32",
    lookup: (n) => (n.startsWith("pwsh") ? n : null),
  })
  const env = { PATH: "C:\\Windows", HOME: "C:\\Users\\u" }
  assert.equal(d.sanitizeEnv(env), env)
})

// --- caching --------------------------------------------------------------

test("activeShellDescriptor caches and __reset clears it", () => {
  __resetShellDetectCache()
  const a = activeShellDescriptor()
  const b = activeShellDescriptor()
  assert.equal(a, b) // same cached ref
  __resetShellDetectCache()
  const c = activeShellDescriptor()
  assert.notEqual(a, c) // fresh object after reset
})

// --- non-interactive env hardening ---------------------------------------

test("applyNonInteractiveEnv pins pager/editor/prompt vars over the inherited env", () => {
  const out = applyNonInteractiveEnv({ PAGER: "less", FOO: "bar" }, { isWin: false })
  // Ambient PAGER=less would re-hang `git log` — hardening must win.
  assert.equal(out.PAGER, "cat")
  assert.equal(out.GIT_PAGER, "cat")
  assert.equal(out.GIT_TERMINAL_PROMPT, "0")
  assert.equal(out.GIT_EDITOR, "true")
  assert.equal(out.GCM_INTERACTIVE, "never")
  assert.equal(out.FOO, "bar") // unrelated vars are preserved
})

test("applyNonInteractiveEnv forces TERM=dumb on POSIX only", () => {
  const posix = applyNonInteractiveEnv({ TERM: "xterm-256color" }, { isWin: false })
  assert.equal(posix.TERM, "dumb")
  const win = applyNonInteractiveEnv({ TERM: "xterm-256color" }, { isWin: true })
  assert.equal(win.TERM, "xterm-256color") // untouched on Windows
})

test("applyNonInteractiveEnv does not mutate its input", () => {
  const input = { PAGER: "less" }
  const out = applyNonInteractiveEnv(input, { isWin: false })
  assert.equal(input.PAGER, "less") // original untouched
  assert.notEqual(out, input)
  assert.equal(out.PAGER, "cat")
})

test("NON_INTERACTIVE_ENV is frozen and covers the hang-causing vars", () => {
  assert.throws(() => {
    // @ts-expect-error -- the frozen object is readonly; the write must throw at runtime too.
    NON_INTERACTIVE_ENV.PAGER = "less"
  })
  for (const key of [
    "GIT_PAGER",
    "PAGER",
    "GIT_TERMINAL_PROMPT",
    "GIT_EDITOR",
    "GCM_INTERACTIVE",
  ]) {
    assert.ok(key in NON_INTERACTIVE_ENV)
  }
})
