// @ts-nocheck — typed in the follow-up commit (ADR-0197 rename/typing pair).
// Sweep: no built-in tool may report a failure without saying what kind it is.
//
// The whole value of the taxonomy is that it is exhaustive. One tool that
// still hands the model a bare `isError: true` is one tool the model keeps
// retrying on a full disk — and it would be invisible, because a bare error
// looks exactly like a classified one from the outside.
//
// A waiver is allowed, but it has to be written down here with a reason.

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

// Every built-in tool lives under `src/tools/` (ADR-0197). Waiver paths are
// relative to the sidecar root.
const SIDECAR = path.resolve(import.meta.dirname, "../..")
const ROOTS = [path.join(SIDECAR, "src", "tools")]

/**
 * Files allowed to write `isError: true` without a classification, and why.
 * Anything not on this list must go through `toolError` or pass `failure`.
 */
const WAIVERS = new Map([
  [
    "src/tools/kernel/result.ts",
    "the result constructor itself: toolText sets `isError` for its callers, and toolError, which every failure goes through, attaches the classification.",
  ],
  [
    "src/tools/builtin/core-files/bash.ts",
    "a non-zero exit is not a tool failure: the command ran and its output IS the answer. Classifying it would tell the model the tool broke when the truth is the command returned 1, which is often the useful result (grep, test runners, diff).",
  ],
])

/** Every tool source file (.mjs / .ts), excluding tests and node_modules. */
function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      sourceFiles(full, out)
      continue
    }
    if (!/\.(mjs|ts)$/.test(entry.name)) continue
    if (/\.test\.(mjs|ts)$/.test(entry.name)) continue
    out.push(full)
  }
  return out
}

test("every isError site is classified or explicitly waived", () => {
  const files = ROOTS.flatMap((root) => sourceFiles(root))
  // Guard the guard: an empty walk would pass this test while proving nothing.
  assert.ok(files.length > 40, `expected to scan the tool tree, saw ${files.length} files`)

  const offenders = []
  let sitesSeen = 0
  for (const file of files) {
    const relative = path.relative(SIDECAR, file).split(path.sep).join("/")
    const text = fs.readFileSync(file, "utf8")
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      if (!/isError:\s*true/.test(lines[i])) continue
      // Prose about `isError` is not a site — only code is.
      if (/^\s*(\/\/|\*|\/\*)/.test(lines[i])) continue
      sitesSeen++
      if (WAIVERS.has(relative)) continue
      // Classified when `failure:` rides along in the same call — look at a
      // small window, since the option object is often multi-line.
      const window = lines.slice(Math.max(0, i - 6), i + 7).join("\n")
      if (/failure:\s*\{/.test(window)) continue
      offenders.push(`${relative}:${i + 1}`)
    }
  }
  assert.ok(sitesSeen > 0, "expected to find at least one isError site")
  assert.deepEqual(
    offenders,
    [],
    `unclassified tool failures — route them through toolError, or add a waiver with a reason:\n  ${offenders.join("\n  ")}`
  )
})

test("every waiver names a file that still exists", () => {
  for (const relative of WAIVERS.keys()) {
    const full = path.join(SIDECAR, relative)
    assert.ok(fs.existsSync(full), `stale waiver: ${relative} no longer exists`)
  }
})
