/**
 * Regression coverage for scripts/test/coverage-changed.mjs — the scoped
 * changed-files coverage runner behind `pnpm test:coverage:changed`.
 *
 * Run with: node --test scripts/test/coverage-changed.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  parseArgs,
  filterCoverageTargets,
  buildJestArgs,
  listChangedFiles,
} from "./coverage-changed.mjs"

test("parseArgs defaults, overrides, and rejects unknown flags", () => {
  // origin/dev, not master: master is ~1500 commits behind this repo's real
  // trunk, so defaulting to it made "changed files" mean "most of the repo".
  assert.deepEqual(parseArgs([]), { base: "origin/dev", strict: false })
  assert.deepEqual(parseArgs(["--base", "dev", "--strict"]), { base: "dev", strict: true })
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/)
  assert.throws(() => parseArgs(["--base"]), /--base requires a ref/)
})

test("filterCoverageTargets keeps collected sources only", () => {
  const files = [
    "lib/goal/engine.ts", // collected
    "components/goal/goal-card.tsx", // collected
    "components/ui/button.tsx", // excluded dir
    "components/ai-elements/message.tsx", // excluded dir
    "lib/goal/engine.test.ts", // test file
    "components/goal/goal-card.stories.tsx", // storybook
    "stores/pet/pet-store.ts", // collected
    "cli/src/tui/app.ts", // collected
    "packages/rag/src/chunker.ts", // collected
    "packages/rag/scripts/gen.ts", // not under src/
    "src-tauri/src/lib.rs", // not a TS root
    "docs/app/page.tsx", // not collected root
    "i18n/messages/en.json", // not source ext
    "hooks/use-ocr.ts", // collected
  ]
  assert.deepEqual(filterCoverageTargets(files), [
    "lib/goal/engine.ts",
    "components/goal/goal-card.tsx",
    "stores/pet/pet-store.ts",
    "cli/src/tui/app.ts",
    "packages/rag/src/chunker.ts",
    "hooks/use-ocr.ts",
  ])
})

test("buildJestArgs narrows coverage and disables config thresholds by default", () => {
  const args = buildJestArgs(["lib/a.ts", "lib/b.tsx"])
  assert.deepEqual(args, [
    "--coverage",
    "--collectCoverageFrom={lib/a.ts,lib/b.tsx}",
    "--coverageThreshold={}",
    "--findRelatedTests",
    "lib/a.ts",
    "lib/b.tsx",
  ])
})

test("buildJestArgs passes a single file verbatim (no one-entry brace group)", () => {
  const args = buildJestArgs(["lib/a.ts"])
  assert.equal(args[1], "--collectCoverageFrom=lib/a.ts")
})

test("buildJestArgs --strict applies the 90% bar to the changed set", () => {
  const args = buildJestArgs(["lib/a.ts"], { strict: true })
  const thresholdArg = args.find((a) => a.startsWith("--coverageThreshold="))
  assert.deepEqual(JSON.parse(thresholdArg.split("=").slice(1).join("=")), {
    global: { branches: 90, functions: 90, lines: 90, statements: 90 },
  })
})

test("listChangedFiles merges diff + untracked, dedupes, drops blanks", () => {
  const calls = []
  const fakeExec = (cmd, cmdArgs) => {
    calls.push([cmd, ...cmdArgs])
    if (cmdArgs[0] === "merge-base") return "abc123\n"
    if (cmdArgs[0] === "diff") return "lib/a.ts\nlib/b.ts\n\n"
    if (cmdArgs[0] === "ls-files") return "lib/b.ts\nlib/new.ts\n"
    throw new Error(`unexpected git call: ${cmdArgs.join(" ")}`)
  }
  const files = listChangedFiles("master", fakeExec)
  assert.deepEqual(files, ["lib/a.ts", "lib/b.ts", "lib/new.ts"])
  assert.deepEqual(calls[0], ["git", "merge-base", "HEAD", "master"])
  assert.deepEqual(calls[1], ["git", "diff", "--name-only", "--diff-filter=d", "abc123"])
})
