import test from "node:test"
import assert from "node:assert/strict"

import {
  findOnPathSync,
  resolveShellDescriptor,
  bashToolDescription,
  activeShellDescriptor,
  applyNonInteractiveEnv,
  NON_INTERACTIVE_ENV,
  __resetShellDetectCache,
} from "./shell-detect.mjs"

// --- findOnPathSync -------------------------------------------------------

test("findOnPathSync honors PATHEXT for an extensionless name on Windows", () => {
  const seen = []
  const exists = (p) => {
    seen.push(p)
    return p.toLowerCase().endsWith("pwsh.exe")
  }
  const hit = findOnPathSync("pwsh", {
    platform: "win32",
    pathVar: "C:\\a;C:\\b",
    pathext: ".EXE;.CMD",
    exists,
  })
  // Leaf comes back with the PATHEXT casing (.EXE); compared case-insensitively
  // since the descriptor uses a fixed canonical bin name regardless.
  assert.equal(hit.toLowerCase(), "pwsh.exe")
  assert.ok(seen.some((p) => p.toLowerCase().endsWith("pwsh.exe")))
})

test("findOnPathSync respects an explicit extension and skips PATHEXT", () => {
  const hit = findOnPathSync("powershell.exe", {
    platform: "win32",
    pathVar: "C:\\win",
    exists: (p) => p.toLowerCase().endsWith("powershell.exe"),
  })
  assert.equal(hit, "powershell.exe")
})

test("findOnPathSync uses ':' separator and no PATHEXT off Windows", () => {
  const hit = findOnPathSync("sh", {
    platform: "linux",
    pathVar: "/usr/bin:/bin",
    exists: (p) => p === "/bin/sh",
  })
  assert.equal(hit, "sh")
})

test("findOnPathSync returns null when nothing matches or PATH is empty", () => {
  assert.equal(findOnPathSync("pwsh", { platform: "win32", pathVar: "", exists: () => true }), null)
  assert.equal(
    findOnPathSync("pwsh", { platform: "win32", pathVar: "C:\\a", exists: () => false }),
    null
  )
})

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

// --- bashToolDescription --------------------------------------------------

test("bashToolDescription embeds the PowerShell syntax hint", () => {
  const d = resolveShellDescriptor({
    platform: "win32",
    lookup: (n) => (n.startsWith("pwsh") ? n : null),
  })
  const desc = bashToolDescription(d)
  assert.match(desc, /\$env:VAR/)
  assert.match(desc, /run_in_background/)
})

test("bashToolDescription falls back to a 'Runs <label>' note for sh", () => {
  const d = resolveShellDescriptor({ platform: "linux" })
  const desc = bashToolDescription(d)
  assert.match(desc, /Runs POSIX sh/)
})

test("bashToolDescription steers interactive programs to terminal_repl_*", () => {
  const desc = bashToolDescription(resolveShellDescriptor({ platform: "linux" }))
  assert.match(desc, /Interactive programs.*terminal_repl/)
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
