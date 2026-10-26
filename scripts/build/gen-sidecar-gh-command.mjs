#!/usr/bin/env node

// Generate the sidecar's copy of the `gh` (GitHub CLI) classifier from the
// host's source (ADR-0239 phase 2).
//
// The host decides which `gh` invocations write to GitHub, and where, in
// `packages/plugin-contract/src/lib/claude/permissions/gh-command.ts`. The
// sidecar needs the same verdict for its always-ask on shell `gh` writes, and
// it cannot import host packages (it runs unbuilt under Node, ADR-0197). A
// hand-kept copy drifted in step with the host's bugs, so the copy is now
// generated from the one source, verbatim, under a header.
//
//   Write:  node scripts/build/gen-sidecar-gh-command.mjs
//   Verify: node scripts/build/gen-sidecar-gh-command.mjs --check   (exit 1 on drift)
//
// `lib/policy/action-review/gh-targets.sidecar-parity.test.ts` runs the check.

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

export const GH_COMMAND_SOURCE = "packages/plugin-contract/src/lib/claude/permissions/gh-command.ts"
export const GH_COMMAND_SIDECAR_COPY = "sidecar/src/policy/shell/gh-command.generated.ts"

const HEADER = `// GENERATED from ${GH_COMMAND_SOURCE} by
// scripts/build/gen-sidecar-gh-command.mjs. Do not edit: change the source and
// run the script. The sidecar cannot import host packages (ADR-0197).

`

/** The sidecar copy for a given host source. */
export function sidecarGhCommand(source) {
  return HEADER + source
}

function main() {
  const source = readFileSync(join(repoRoot, GH_COMMAND_SOURCE), "utf8")
  const expected = sidecarGhCommand(source)
  const target = join(repoRoot, GH_COMMAND_SIDECAR_COPY)
  if (process.argv.includes("--check")) {
    let current = ""
    try {
      current = readFileSync(target, "utf8")
    } catch {
      // Missing reads as drift.
    }
    if (current !== expected) {
      console.error(
        `${GH_COMMAND_SIDECAR_COPY} is stale — run: node scripts/build/gen-sidecar-gh-command.mjs`
      )
      process.exit(1)
    }
    return
  }
  writeFileSync(target, expected)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
