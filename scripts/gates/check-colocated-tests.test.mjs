/**
 * Coverage for scripts/gates/check-colocated-tests.mjs — CLAUDE.md hard
 * rule 3 as a ratchet gate.
 *
 * Scanning and I/O are separated, so every classification branch is tested
 * against injected inputs. A final live test asserts the real repo satisfies
 * its own baseline, because a ratchet that has drifted from reality silently
 * stops ratcheting.
 *
 * Run with: node --test scripts/gates/check-colocated-tests.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  diffAgainstBaseline,
  expectedTestPaths,
  findViolations,
  isGatedRustSource,
  isGatedTsSource,
  main,
  readBaseline,
  rustHasInlineTests,
} from "./check-colocated-tests.mjs"

test("isGatedTsSource covers the documented roots", () => {
  for (const f of ["components/chat/composer.tsx", "hooks/use-thing.ts", "lib/goal/engine.ts"]) {
    assert.ok(isGatedTsSource(f), `${f} should be gated`)
  }
})

test("isGatedTsSource honours the rule's carve-outs and non-source shapes", () => {
  for (const f of [
    "components/ui/button.tsx", // shadcn — excluded by the rule
    "components/ai-elements/message.tsx", // vendored — excluded by the rule
    "app/page.tsx", // outside the gated roots
    "stores/chat/store.ts", // outside the gated roots
    "lib/goal/engine.test.ts", // a test, not a source
    "lib/goal/engine.spec.ts",
    "components/chat/composer.stories.tsx",
    "lib/types/global.d.ts", // ambient declarations
    "lib/goal/readme.md", // not TypeScript
  ]) {
    assert.ok(!isGatedTsSource(f), `${f} should NOT be gated`)
  }
})

test("isGatedRustSource only matches src-tauri sources", () => {
  assert.ok(isGatedRustSource("src-tauri/src/lib.rs"))
  assert.ok(isGatedRustSource("src-tauri/src/ocr/engine.rs"))
  assert.ok(!isGatedRustSource("crates/cognia-cli/src/main.rs"))
  assert.ok(!isGatedRustSource("src-tauri/build.rs"))
  assert.ok(!isGatedRustSource("src-tauri/src/notes.md"))
})

test("expectedTestPaths offers every accepted co-located name", () => {
  assert.deepEqual(expectedTestPaths("lib/goal/engine.ts"), [
    "lib/goal/engine.test.ts",
    "lib/goal/engine.test.tsx",
    "lib/goal/engine.spec.ts",
    "lib/goal/engine.spec.tsx",
  ])
})

test("rustHasInlineTests detects the in-file test module", () => {
  assert.ok(rustHasInlineTests("fn a() {}\n#[cfg(test)]\nmod tests { }"))
  assert.ok(!rustHasInlineTests("fn a() {}"))
})

test("findViolations reports sources whose co-located test is absent", () => {
  const files = [
    "lib/covered.ts",
    "lib/covered.test.ts",
    "components/bare.tsx",
    "components/ui/button.tsx", // excluded
    "src-tauri/src/tested.rs",
    "src-tauri/src/untested.rs",
  ]
  const rust = {
    "src-tauri/src/tested.rs": "#[cfg(test)] mod tests {}",
    "src-tauri/src/untested.rs": "fn main() {}",
  }
  const violations = findViolations(files, {
    has: (p) => files.includes(p),
    readRust: (p) => rust[p] ?? "",
  })
  assert.deepEqual(violations, ["components/bare.tsx", "src-tauri/src/untested.rs"])
})

test("findViolations accepts any of the four co-located test names", () => {
  for (const testFile of ["lib/a.test.ts", "lib/a.test.tsx", "lib/a.spec.ts", "lib/a.spec.tsx"]) {
    const files = ["lib/a.ts", testFile]
    const violations = findViolations(files, { has: (p) => files.includes(p), readRust: () => "" })
    assert.deepEqual(violations, [], `${testFile} should satisfy the rule`)
  }
})

test("diffAgainstBaseline: a new untested file is an addition — the gate's whole job", () => {
  const known = new Set(["lib/old.ts", "lib/new.ts"])
  const { added, fixed, stale } = diffAgainstBaseline(
    ["lib/new.ts", "lib/old.ts"],
    ["lib/old.ts"],
    known
  )
  assert.deepEqual(added, ["lib/new.ts"])
  assert.deepEqual(fixed, [])
  assert.deepEqual(stale, [])
})

test("diffAgainstBaseline: a renamed file reads as new, so it must arrive with a test", () => {
  const known = new Set(["lib/renamed.ts"])
  const { added, stale } = diffAgainstBaseline(["lib/renamed.ts"], ["lib/original.ts"], known)
  assert.deepEqual(added, ["lib/renamed.ts"])
  assert.deepEqual(stale, ["lib/original.ts"])
})

test("diffAgainstBaseline: paying debt down surfaces as `fixed`, never as a failure", () => {
  const known = new Set(["lib/a.ts", "lib/b.ts"])
  const { added, fixed } = diffAgainstBaseline(["lib/a.ts"], ["lib/a.ts", "lib/b.ts"], known)
  assert.deepEqual(added, [])
  assert.deepEqual(fixed, ["lib/b.ts"])
})

test("diffAgainstBaseline: a deleted file is stale, not fixed", () => {
  const known = new Set(["lib/a.ts"])
  const { fixed, stale } = diffAgainstBaseline(["lib/a.ts"], ["lib/a.ts", "lib/gone.ts"], known)
  assert.deepEqual(fixed, [])
  assert.deepEqual(stale, ["lib/gone.ts"])
})

test("the committed baseline is a sorted, de-duplicated path list", () => {
  const baseline = readBaseline()
  assert.equal(baseline.version, 1)
  assert.ok(Array.isArray(baseline.files))
  assert.ok(baseline.files.length > 0, "baseline should record the pre-existing debt")
  assert.deepEqual(baseline.files, [...baseline.files].sort())
  assert.equal(new Set(baseline.files).size, baseline.files.length)
})

test("live: the real repo matches its baseline", () => {
  assert.equal(main(), 0)
})
