#!/usr/bin/env node
/**
 * Loading-state gate — keeps hand-rolled loading indicators from creeping back.
 *
 * Two shapes are flagged, both of which look harmless and both of which break
 * behaviour the shared primitives guarantee:
 *
 *   1. A bare spinner: `<Loader2 className="… animate-spin …" />` (or
 *      `LoaderIcon` / `Loader2Icon`). These bypass `components/ui/spinner.tsx`,
 *      so they carry no accessibility contract at all — the author picks a size
 *      and a colour, and nothing decides whether the glyph should announce
 *      itself or stay decorative. 156 files did this before the primitive
 *      existed.
 *
 *   2. A hand-rolled skeleton: a `bg-muted` / `bg-accent` block carrying
 *      `animate-pulse`. This one is not cosmetic. The reduce-motion tier in
 *      `app/globals.css` keys its exemption off `data-slot="skeleton"`, which
 *      only `components/ui/skeleton.tsx` emits. A hand-rolled block is
 *      therefore caught by the blunt guard and freezes into an inert grey
 *      rectangle for every user who asked for reduced motion.
 *
 * Baseline, not a wall. `components/settings/**` (116 files) and the ~100
 * button-only spinner sites were deliberately left unmigrated — they inherit
 * the fixes through the shared CSS and primitives without needing an edit, and
 * touching them would have meant dragging 200+ files through the 90%
 * changed-file coverage gate for a cosmetic win. The baseline records exactly
 * those, and may only shrink: new or renamed files must use the primitives.
 *
 * Modes:
 *   (default)    fail if any offender is absent from the baseline.
 *   --baseline   rewrite the baseline from the current tree.
 *
 * Usage:
 *   pnpm audit:loading-states
 *   pnpm audit:loading-states:baseline
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readdirSync, statSync } from "node:fs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "../..")
const BASELINE_FILE = join(__dirname, "loading-states-baseline.json")

/** Directories worth scanning — everything that renders product UI. */
const SCAN_ROOTS = ["components", "app", "hooks"]

/**
 * Exempt by design:
 *  - `components/ui/` + `web/components/ui/` are where the primitives live, so
 *    they are the one place allowed to write the raw markup.
 *  - `components/ai-elements/` is vendored.
 *  - Tests and stories assert on the very classes this gate forbids.
 */
const EXEMPT = [
  /^components\/ui\//,
  /^components\/ai-elements\//,
  /^web\/components\/ui\//,
  /\.test\.tsx?$/,
  /\.stories\.tsx?$/,
]

/** A lucide loader glyph spun by hand instead of via `<Spinner>`. */
const BARE_SPINNER = /<(Loader2Icon|Loader2|LoaderIcon|LoaderCircle)\b[^>]*\banimate-spin\b/

/**
 * A placeholder block pulsing by hand instead of via `<Skeleton>`. Requires a
 * muted/accent background so it cannot match a pulsing status dot or icon,
 * which are legitimately not skeletons and must NOT be rewritten.
 */
const HAND_ROLLED_SKELETON = /\banimate-pulse\b/

function isExempt(rel) {
  return EXEMPT.some((re) => re.test(rel))
}

/** @returns {string[]} every .tsx/.ts file under the scan roots */
export function listSourceFiles(root = ROOT) {
  /** @type {string[]} */
  const out = []
  for (const scanRoot of SCAN_ROOTS) {
    const abs = join(root, scanRoot)
    if (!existsSync(abs)) continue
    walk(abs, out, root)
  }
  return out.sort()
}

function walk(dir, out, root) {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out, root)
      continue
    }
    if (!/\.tsx?$/.test(entry)) continue
    out.push(relative(root, full))
  }
}

/**
 * Classify one file's offences. Pure — exported for the unit tests.
 *
 * @param {string} source file contents
 * @returns {{ spinner: boolean, skeleton: boolean }}
 */
export function findOffences(source) {
  const spinner = BARE_SPINNER.test(source)
  // Only count a pulse that is dressing a placeholder surface. A pulsing dot
  // (`rounded-full bg-emerald-400 animate-pulse`) is a running-state indicator,
  // not a skeleton, and rewriting it as one would be a bug.
  const skeleton = source
    .split("\n")
    .some(
      (line) =>
        HAND_ROLLED_SKELETON.test(line) &&
        /\bbg-(muted|accent)\b/.test(line) &&
        /\bh-\d|\bheight|\binset-0|\bflex-1/.test(line)
    )
  return { spinner, skeleton }
}

/** @returns {string[]} repo-relative paths that currently offend */
export function collectOffenders(root = ROOT) {
  const offenders = []
  for (const rel of listSourceFiles(root)) {
    if (isExempt(rel)) continue
    const { spinner, skeleton } = findOffences(readFileSync(join(root, rel), "utf8"))
    if (spinner || skeleton) offenders.push(rel)
  }
  return offenders
}

function readBaseline() {
  if (!existsSync(BASELINE_FILE)) return []
  return JSON.parse(readFileSync(BASELINE_FILE, "utf8")).files ?? []
}

export function main(argv = []) {
  const offenders = collectOffenders()

  if (argv.includes("--baseline")) {
    writeFileSync(BASELINE_FILE, `${JSON.stringify({ files: offenders }, null, 2)}\n`)
    console.log(`[loading-states] baseline rewritten — ${offenders.length} file(s) recorded`)
    return 0
  }

  const baseline = new Set(readBaseline())
  const added = offenders.filter((f) => !baseline.has(f))
  const fixed = [...baseline].filter((f) => !offenders.includes(f))

  if (added.length > 0) {
    console.error(
      `[loading-states] ${added.length} file(s) hand-roll a loading indicator instead of using` +
        ` the shared primitives:\n` +
        added.map((f) => `  ${f}`).join("\n") +
        `\n\nUse <Spinner> (components/ui/spinner.tsx) or <Skeleton>` +
        ` (components/ui/skeleton.tsx). A hand-rolled pulse cannot receive the` +
        ` reduce-motion exemption in globals.css and will freeze for users who` +
        ` ask for reduced motion — see ADR-0096.`
    )
    return 1
  }

  console.log(
    `[loading-states] OK — ${offenders.length} baselined file(s)` +
      (fixed.length > 0 ? `, ${fixed.length} newly fixed (run --baseline to lock it in)` : "")
  )
  return 0
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-loading-states.mjs")
) {
  process.exit(main(process.argv.slice(2)))
}
