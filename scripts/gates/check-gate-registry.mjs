#!/usr/bin/env node
/**
 * Meta-gate: every verification-shaped package.json script is either
 * registered in the gate registry (scripts/gates/check-all.mjs) or explicitly
 * exempted here WITH A REASON.
 *
 * Why this exists: this repo's most recurrent defect is fully-built code that
 * was never wired in. Gates are not exempt from it. Before this file, four
 * gates ran only locally and never in CI, nine ran only in CI and never
 * locally, and two — `build:packages` and `lint:claude-md`'s underlying
 * `check-claude-md.mjs` — were written, tested, committed, and then invoked
 * by nothing at all. `check-claude-md.mjs`'s own docstring said
 * "Usage: pnpm lint:claude-md" for a script that did not exist.
 *
 * A heuristic name check cannot prove a script is a gate, so it does not try
 * to. It proves something weaker but sufficient: no verification-shaped
 * script can enter the repo without someone deciding, in writing, where it
 * runs. Adding `foo:check` and forgetting to wire it now fails the build.
 *
 * Three invariants:
 *   1. Every verification-shaped script is registered or exempted.
 *   2. Every registry entry names a script that actually exists.
 *   3. Every exemption names a script that actually exists (no stale rows).
 *
 * Usage: pnpm gates:registry
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import { GATES } from "./check-all.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * Name shapes that mark a script as "this looks like it verifies something".
 * Matched against the script NAME, segment-wise, so `lint`, `foo:lint` and
 * `lint:bar` all match but `blueprint` does not.
 */
export const VERIFICATION_PATTERNS = [
  /(^|:)check(:|$)/,
  /(^|:)test(:|$)/,
  /(^|:)lint(:|$)/,
  /(^|:)audit(:|$)/,
  /(^|:)typecheck(:|$)/,
  /(^|:)verify(:|$)/,
  /(^|:)validate(:|$)/,
]

/** @param {string} name @returns {boolean} */
export function isVerificationScript(name) {
  return VERIFICATION_PATTERNS.some((re) => re.test(name))
}

/**
 * Scripts that look like gates but deliberately are not registered.
 * The value is the reason, and it is not decorative: it is what a future
 * reader needs in order to know whether the exemption is still true.
 *
 * @type {Record<string, string>}
 */
export const EXEMPTIONS = {
  // --- the runner itself ---
  "check:all": "the gate runner; running it as a gate would recurse",

  // --- writers / fixers: they mutate, so they can never be gates ---
  "lint:fix": "writer — the gate is `lint`",
  "lint:i18n:baseline": "writer — regenerates the i18n baseline",
  "audit:colocated-tests:baseline": "writer — regenerates the co-located-test baseline",
  "audit:loading-states:baseline": "writer — regenerates the loading-state baseline",
  "audit:unreachable-components:baseline":
    "writer — regenerates the unreachable-component baseline",
  "rust:clippy:baseline": "writer — regenerates the clippy baseline",
  "i18n:sort": "writer — the check half is i18n:sort:check",

  // --- deliberately unregistered checks ---
  "test:conformance":
    "ADR-0090 conformance suite — drives the REAL sidecar + Agent SDK + claude-code subprocess (minutes per case) and needs the cognia-server binary (`conformance:prepare`). Runs as its own CI job, not inside the fast gate matrix",
  "i18n:sort:check":
    "message files are not key-sorted yet; would always fail. Run `pnpm i18n:sort` once, then register it in check-all.mjs",
  "i18n:validate": "subsumed by the i18n:build:check gate, which runs it",
  "lint:i18n:staged": "husky pre-commit hook variant of the lint:i18n gate",

  // --- test runners owned by .github/workflows/test.yml, not by this registry ---
  test: "jest suite — owned by test.yml",
  "test:changed": "jest dev helper — owned by test.yml",
  "test:watch": "interactive jest — never runs unattended",
  "test:coverage": "jest coverage — owned by test.yml",
  "test:coverage:changed": "incremental coverage — owned by test.yml",
  "test:coverage:merge":
    "shard-coverage merge tool — owned by test.yml, which runs its `--check` half as the real threshold gate",
  "test:evals": "eval suite — owned by test.yml",
  "cli:test": "jest project for cli/ — owned by test.yml",
  "test:e2e": "playwright — owned by test.yml",
  "test:e2e:build": "playwright fixture build — owned by test.yml",
  "test:e2e:changed": "playwright dev helper — owned by test.yml",
  "test:e2e:install": "playwright browser install — setup, not a gate",
  "test:e2e:static": "playwright against the static export — owned by test.yml",
  "test:e2e:report": "opens the local HTML report — interactive",
  "test:e2e:mobile": "playwright mobile project — owned by test.yml",
  "test:e2e:mobile:ios": "playwright iOS project — owned by nightly.yml",
  "test:e2e:tauri": "playwright tauri project — owned by nightly.yml",
  "test:e2e:workflows": "playwright subset helper — owned by test.yml",
  "test:e2e:workflows:editor": "playwright subset helper — owned by test.yml",
  "test:e2e:workflows:nodes": "playwright subset helper — owned by test.yml",
  "test:e2e:workflows:runs": "playwright subset helper — owned by test.yml",
  "sidecar:test": "sidecar node --test suites — owned by test.yml via sidecars:test",
  "sidecar:test:builtin": "sidecar node --test subset — owned by test.yml",
  "sidecar:test:dispatch": "sidecar node --test subset — owned by test.yml",
  "sidecar:test:lsp": "sidecar node --test subset — owned by test.yml",
  "sidecar:vscode:test": "vscode ext host suite — owned by test.yml via sidecars:test",
  "sidecar:webclone:test": "webclone suite — owned by test.yml via sidecars:test",
  "sidecars:test": "aggregate sidecar suite — owned by test.yml",

  // --- per-script self-tests, all covered by a scripts:test:* aggregate ---
  "check:all:test": "covered by scripts:test:gates",
  "audit:command-parity:test": "covered by scripts:test:gates",
  "audit:e2e-governance:test": "covered by scripts:test:gates",
  "audit:pii-boundaries:test": "covered by scripts:test:gates",
  "audit:silent-flags:test": "covered by scripts:test:gates",
  "audit:loading-states:test": "covered by scripts:test:gates",
  "audit:unreachable-components:test": "covered by scripts:test:gates",
  "lint:static-export:test": "covered by scripts:test:gates",
  "clean:cache:test": "covered by scripts:test:build",
  "clean:webpack-cache:test": "covered by scripts:test:build",
  "share:wallpapers:test": "covered by scripts:test:build",
  "skills:build:test": "covered by scripts:test:build",
  "config:sync:test": "covered by scripts:test:sync",
  "i18n:sort:test": "covered by scripts:test:sync (sort-i18n lives in scripts/sync/)",
  "version:sync:test": "covered by scripts:test:sync",
  "i18n:build:test": "covered by scripts:test:i18n",
  "i18n:validate:test": "covered by scripts:test:i18n",
  "plugin-convert:check:test": "covered by scripts:test:plugin",
  "plugin:scaffold:test": "covered by scripts:test:plugin",
  "clean:db:test": "covered by scripts:test:ci",
  "e2e:serve:test": "covered by scripts:test:ci",
  "test:coverage:changed:test": "covered by scripts:test:ci",
  "test:coverage:merge:test": "covered by scripts:test:ci",
}

/**
 * Audit a set of script names against the registry + exemptions. Pure.
 *
 * @param {string[]} scriptNames
 * @param {{ gates?: typeof GATES, exemptions?: Record<string, string> }} [deps]
 * @returns {{ unregistered: string[], staleExemptions: string[], missingScripts: string[], emptyReasons: string[] }}
 */
export function auditRegistry(scriptNames, deps = {}) {
  const gates = deps.gates ?? GATES
  const exemptions = deps.exemptions ?? EXEMPTIONS

  const names = new Set(scriptNames)
  const registered = new Set(gates.map((g) => g.script))

  const unregistered = scriptNames
    .filter(isVerificationScript)
    .filter((n) => !registered.has(n) && !(n in exemptions))
    .sort()

  const missingScripts = gates
    .map((g) => g.script)
    .filter((s) => !names.has(s))
    .sort()

  const staleExemptions = Object.keys(exemptions)
    .filter((s) => !names.has(s))
    .sort()

  const emptyReasons = Object.entries(exemptions)
    .filter(([, reason]) => !reason || !reason.trim())
    .map(([s]) => s)
    .sort()

  return { unregistered, staleExemptions, missingScripts, emptyReasons }
}

export function main() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"))
  const scriptNames = Object.keys(pkg.scripts ?? {})
  const { unregistered, staleExemptions, missingScripts, emptyReasons } = auditRegistry(scriptNames)

  let failed = false

  if (unregistered.length) {
    failed = true
    console.error(
      `[gate-registry] ${unregistered.length} verification script(s) are wired to nothing:`
    )
    for (const s of unregistered) console.error(`  ${s}`)
    console.error(
      "\n  Fix: add it to REGISTRY in scripts/gates/check-all.mjs (so it runs\n" +
        "  locally AND in CI), or add it to EXEMPTIONS in this file with a reason."
    )
  }

  if (missingScripts.length) {
    failed = true
    console.error(
      `\n[gate-registry] ${missingScripts.length} registry entr(ies) name a script that does not exist:`
    )
    for (const s of missingScripts) console.error(`  ${s}`)
  }

  if (staleExemptions.length) {
    failed = true
    console.error(
      `\n[gate-registry] ${staleExemptions.length} stale exemption(s) — the script is gone:`
    )
    for (const s of staleExemptions) console.error(`  ${s}`)
  }

  if (emptyReasons.length) {
    failed = true
    console.error(`\n[gate-registry] ${emptyReasons.length} exemption(s) have an empty reason:`)
    for (const s of emptyReasons) console.error(`  ${s}`)
  }

  if (failed) return 1

  const verificationCount = scriptNames.filter(isVerificationScript).length
  console.log(
    `[gate-registry] OK: ${GATES.length} registered gate(s), ` +
      `${Object.keys(EXEMPTIONS).length} exemption(s), ` +
      `${verificationCount} verification-shaped script(s) all accounted for.`
  )
  return 0
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-gate-registry.mjs")
) {
  process.exit(main())
}
