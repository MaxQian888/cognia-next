#!/usr/bin/env node
/**
 * Gate: CLAUDE.md hard rule 3 — every source file under the gated roots ships
 * with a co-located test.
 *
 *   components/**  hooks/**  lib/**       →  foo.ts  needs  foo.test.ts
 *   src-tauri/src/**                      →  foo.rs  needs  #[cfg(test)]
 *
 * Excluded by the rule itself: `components/ui/` (shadcn) and
 * `components/ai-elements/` (vendored).
 *
 * Until now this rule was enforced by a human-triggered sub-agent
 * (`test-gap-auditor`), which means it was enforced when someone remembered
 * to ask. This makes it deterministic.
 *
 * ## Ratchet, not a cliff
 *
 * The repo starts with a few hundred pre-existing gaps. Failing on all of
 * them would just get the gate switched off, so they are recorded in
 * `colocated-test-baseline.json` and the gate enforces the only property that
 * matters going forward: THE LIST MAY NOT GROW. A file that is new — or
 * renamed, which is the same thing to a reader — must arrive with its test.
 *
 * The baseline stores explicit paths rather than a count. A count would let a
 * new untested file hide behind an old one that gained a test.
 *
 * Usage:
 *   pnpm audit:colocated-tests                    # check
 *   pnpm audit:colocated-tests -- --write-baseline # after paying debt down
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const BASELINE_FILE = join(REPO_ROOT, "scripts", "gates", "colocated-test-baseline.json")

/**
 * Roots the rule covers, verbatim from CLAUDE.md hard rule 3, plus the same
 * three roots inside the marketing workspace (ADR-0092 §11). `web/app/` follows
 * the product `app/` precedent — tests are written, but page files are not
 * gated — and `web/content/` is data whose en/zh parity `tsc` already proves.
 */
export const TS_ROOTS = [
  "components/",
  "hooks/",
  "lib/",
  "web/components/",
  "web/hooks/",
  "web/lib/",
  // The browser extension's own three roots (ADR-0154). Its entrypoints under
  // `browser-extension/src/app/` are excluded for the same reason `web/app/`
  // is: they are the thin shells that hand the real `chrome.*` surface to code
  // that takes it as a parameter, and everything worth asserting lives on the
  // other side of that seam.
  "browser-extension/src/components/",
  "browser-extension/src/hooks/",
  "browser-extension/src/lib/",
]
/**
 * Carve-outs the rule names explicitly.
 *
 * `web/components/ui/` needs its own entry rather than riding on
 * `components/ui/`: the match is `file.startsWith(root)`, so the marketing
 * workspace's shadcn copies never match the product path. Without it every
 * generated shadcn file would demand a hand-written test, which is the same
 * bargain the product tree already declined.
 */
export const TS_EXCLUDED = ["components/ui/", "components/ai-elements/", "web/components/ui/"]
export const RUST_ROOT = "src-tauri/src/"

const TS_EXT = /\.(ts|tsx)$/
/** Tests, stories and ambient declarations are not themselves gated sources. */
const NOT_A_SOURCE = /(\.(test|spec|stories)\.[^/]+$|\.d\.ts$)/

/**
 * Is this path a TypeScript source file the rule applies to? Pure.
 * @param {string} file repo-relative, posix separators
 * @returns {boolean}
 */
export function isGatedTsSource(file) {
  if (!TS_ROOTS.some((r) => file.startsWith(r))) return false
  if (TS_EXCLUDED.some((r) => file.startsWith(r))) return false
  if (!TS_EXT.test(file)) return false
  return !NOT_A_SOURCE.test(file)
}

/** @param {string} file @returns {boolean} */
export function isGatedRustSource(file) {
  return file.startsWith(RUST_ROOT) && file.endsWith(".rs")
}

/**
 * The co-located test paths that would satisfy the rule for a source file.
 * Pure.
 * @param {string} file
 * @returns {string[]}
 */
export function expectedTestPaths(file) {
  const stem = file.replace(TS_EXT, "")
  return [`${stem}.test.ts`, `${stem}.test.tsx`, `${stem}.spec.ts`, `${stem}.spec.tsx`]
}

/** Rust files satisfy the rule with an in-file test module. Pure. */
export function rustHasInlineTests(source) {
  return source.includes("#[cfg(test)]")
}

/**
 * Compute the current violation list. Pure — I/O is injected.
 *
 * @param {string[]} files every tracked repo-relative path
 * @param {{ has: (p: string) => boolean, readRust: (p: string) => string }} io
 * @returns {string[]} sorted violating paths
 */
export function findViolations(files, io) {
  const violations = []
  for (const file of files) {
    if (isGatedTsSource(file)) {
      if (!expectedTestPaths(file).some((p) => io.has(p))) violations.push(file)
    } else if (isGatedRustSource(file)) {
      if (!rustHasInlineTests(io.readRust(file))) violations.push(file)
    }
  }
  return violations.sort()
}

/**
 * Ratchet comparison. Pure.
 *
 * @param {string[]} current
 * @param {string[]} baseline
 * @returns {{ added: string[], fixed: string[], stale: string[] }}
 */
export function diffAgainstBaseline(current, baseline, knownFiles) {
  const baseSet = new Set(baseline)
  const curSet = new Set(current)
  const added = current.filter((f) => !baseSet.has(f)).sort()
  const fixed = baseline.filter((f) => !curSet.has(f) && (!knownFiles || knownFiles.has(f))).sort()
  // Baseline rows whose file no longer exists at all — deleted or renamed.
  const stale = knownFiles ? baseline.filter((f) => !knownFiles.has(f)).sort() : []
  return { added, fixed, stale }
}

/**
 * Drop tracked paths that no longer exist on disk. Pure — existence is injected.
 *
 * `git ls-files` still lists a file whose deletion has not been staged yet. Such
 * a path can neither hold an in-file test module nor be matched by a co-located
 * test file, so scanning it reports a violation against a file on its way out.
 * The same filter is what makes a *deleted test* stop satisfying its source.
 *
 * @param {string[]} files
 * @param {(file: string) => boolean} exists
 * @returns {string[]}
 */
export function keepExisting(files, exists) {
  return files.filter((file) => exists(file))
}

/**
 * Every repo-relative path the gate reasons about — sources AND tests.
 *
 * `--others --exclude-standard` alongside `--cached`, for the same reason
 * `check-surface-usage.mjs` does it: a gate meant to catch NEW code that only
 * sees committed files is exactly backwards, and it is wrong in both
 * directions. A new source file without a test passed until the commit
 * introducing it had already landed; and a newly written test did not count
 * for its source until it was staged, so the gate failed on work that was
 * already done. The second one is not hypothetical — it fires whenever someone
 * migrates `foo.test.ts` to `foo.test.tsx`, because the deletion is visible
 * (git tracks it) while the replacement is not.
 *
 * @returns {string[]}
 */
function listTrackedFiles() {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64e6,
  })
    .split("\n")
    .filter(Boolean)
  // `git ls-files` still lists a tracked file whose deletion is unstaged, and
  // `--others` can list a path removed between the listing and this check.
  return keepExisting(listed, (file) => existsSync(join(REPO_ROOT, file)))
}

/** @returns {{ version: number, files: string[] }} */
export function readBaseline(file = BASELINE_FILE) {
  if (!existsSync(file)) return { version: 1, files: [] }
  return JSON.parse(readFileSync(file, "utf8"))
}

export function writeBaseline(violations, file = BASELINE_FILE) {
  const payload = {
    version: 1,
    note:
      "Pre-existing co-located-test gaps, recorded when the gate landed. " +
      "This list may only shrink: `pnpm audit:colocated-tests` fails if a new " +
      "or renamed source file appears without its test. Regenerate with " +
      "`pnpm audit:colocated-tests -- --write-baseline` after paying debt down.",
    files: [...violations].sort(),
  }
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

export function main(argv = []) {
  const files = listTrackedFiles()
  const known = new Set(files)
  const io = {
    has: (p) => known.has(p),
    readRust: (p) => {
      try {
        return readFileSync(join(REPO_ROOT, p), "utf8")
      } catch {
        return ""
      }
    },
  }

  const violations = findViolations(files, io)

  if (argv.includes("--write-baseline")) {
    const payload = writeBaseline(violations)
    console.log(`[colocated-tests] baseline written: ${payload.files.length} known gap(s)`)
    return 0
  }

  const baseline = readBaseline()
  const { added, fixed, stale } = diffAgainstBaseline(violations, baseline.files ?? [], known)

  if (fixed.length) {
    console.log(
      `[colocated-tests] ${fixed.length} baselined file(s) now have tests — ` +
        "run `pnpm audit:colocated-tests -- --write-baseline` to lock the gain in."
    )
  }
  if (stale.length) {
    console.log(
      `[colocated-tests] ${stale.length} baseline row(s) point at files that no longer exist — ` +
        "regenerate the baseline when convenient."
    )
  }

  if (added.length) {
    console.error(
      `[colocated-tests] ${added.length} source file(s) are missing a co-located test ` +
        "(CLAUDE.md hard rule 3):"
    )
    for (const f of added) {
      const hint = f.endsWith(".rs")
        ? "add an in-file `#[cfg(test)] mod tests { … }`"
        : `add ${f.replace(TS_EXT, "")}.test.${f.endsWith(".tsx") ? "tsx" : "ts"}`
      console.error(`  ${f}  →  ${hint}`)
    }
    console.error(
      "\n  These are NOT baselined: the baseline records pre-existing debt only,\n" +
        "  and it may not grow. A renamed file counts as a new file."
    )
    return 1
  }

  console.log(
    `[colocated-tests] OK: ${violations.length} known gap(s), none new ` +
      `(baseline holds ${(baseline.files ?? []).length}).`
  )
  return 0
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-colocated-tests.mjs")
) {
  process.exit(main(process.argv.slice(2)))
}
