import test from "node:test"
import assert from "node:assert/strict"

import { findOnPathSync } from "./which.ts"

test("findOnPathSync honors PATHEXT for an extensionless name on Windows", () => {
  const seen: string[] = []
  const exists = (p: string) => {
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
  assert.equal(hit?.toLowerCase(), "pwsh.exe")
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
