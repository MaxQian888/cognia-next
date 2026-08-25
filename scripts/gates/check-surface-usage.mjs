#!/usr/bin/env node
/**
 * Gate: ADR-0148 — panel surfaces go through `<Surface>`, and radius/elevation
 * go through the token scale.
 *
 * Two things this repo kept regrowing, both reported by users as "the app looks
 * disjointed" and "the wallpaper barely shows":
 *
 *  1. **Bare panel containers.** A `div` carrying a radius, a border AND a
 *     background is a panel. Written by hand it picks its own corner, its own
 *     tone and its own padding, and — because it is invisible to the
 *     layer-semantic system — stays fully opaque over a wallpaper while the
 *     shadcn primitive beside it goes translucent. There were 1,060 of these
 *     when the gate landed.
 *
 *  2. **Radius and shadow values no setting can reach.** `rounded-2xl`,
 *     `rounded-3xl` and arbitrary `rounded-[…]` resolve from Tailwind's static
 *     scale, not from `--radius`; `shadow-*` bypasses the `[data-elevation]`
 *     ramp. Both survive a style pack untouched, which is exactly what made
 *     "no rounded corners" impossible to actually deliver.
 *
 * ## Ratchet, not a cliff
 *
 * The existing population is recorded in `surface-baseline.json` and the gate
 * enforces the only property that matters going forward: THE LIST MAY NOT GROW.
 * Paths are stored with a per-file count, so paying one down in a file does not
 * buy room for a new one elsewhere.
 *
 * Usage:
 *   pnpm audit:surfaces                     # check
 *   pnpm audit:surfaces -- --write-baseline # after paying debt down
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const BASELINE_FILE = join(REPO_ROOT, "scripts", "gates", "surface-baseline.json")

/** Roots that render product chrome. */
const ROOTS = ["components", "app", "plugins"]

/**
 * `components/ui/` is shadcn's own copy and `components/ai-elements/` is
 * vendored — both are re-installed from upstream, so gating their source would
 * fail on code this repo does not author. They reach the tier system through
 * `Surface` where it matters (Card, Alert) and through the wallpaper-aware
 * `data-slot` rules otherwise.
 */
const EXCLUDED_DIRS = ["components/ui/", "components/ai-elements/"]

const EXCLUDED_FILE = /\.(test|stories)\.(ts|tsx)$/

/** Radius steps that do not track `--radius`, and the elevation bypass. */
const UNTRACKED_RADIUS = /\brounded-(?:2xl|3xl|4xl)\b|\brounded-\[[^\]]+\]/g
const RAW_SHADOW = /\bshadow-(xs|sm|md|lg|xl|2xl|inner)\b/g

/**
 * A class string that carries a radius, a border and a background is a panel.
 * Order-independent, because the three can appear in any sequence.
 */
function isBarePanel(cls) {
  const hasRadius = /\brounded-[a-z0-9[\]-]+/.test(cls)
  const hasBorder = /\bborder(\b|-[a-z])/.test(cls)
  const hasBg = /\bbg-[a-z]/.test(cls)
  return hasRadius && hasBorder && hasBg
}

function listFiles() {
  const out = execFileSync("git", ["ls-files", ...ROOTS.map((r) => `${r}/**/*.tsx`)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
  return out
    .split("\n")
    .filter(Boolean)
    .filter((p) => !EXCLUDED_DIRS.some((d) => p.startsWith(d)))
    .filter((p) => !EXCLUDED_FILE.test(p))
}

/** Count violations per file. Exported for the test beside this script. */
export function scanSource(src) {
  let barePanels = 0
  for (const m of src.matchAll(/"([^"\n]{0,600})"/g)) {
    if (isBarePanel(m[1])) barePanels += 1
  }
  const untrackedRadius = (src.match(UNTRACKED_RADIUS) ?? []).length
  const rawShadow = (src.match(RAW_SHADOW) ?? []).length
  return barePanels + untrackedRadius + rawShadow
}

export function scanRepo(files = listFiles()) {
  /** @type {Record<string, number>} */
  const found = {}
  for (const file of files) {
    const abs = join(REPO_ROOT, file)
    if (!existsSync(abs)) continue
    const n = scanSource(readFileSync(abs, "utf8"))
    if (n > 0) found[file] = n
  }
  return found
}

export function compare(found, baseline) {
  /** @type {string[]} */ const regressions = []
  /** @type {string[]} */ const improvements = []
  for (const [file, count] of Object.entries(found)) {
    const allowed = baseline[file] ?? 0
    if (count > allowed) {
      regressions.push(
        allowed === 0
          ? `${file}: ${count} bare panel / untracked radius / raw shadow (new file)`
          : `${file}: ${count} (baseline allows ${allowed})`
      )
    } else if (count < allowed) {
      improvements.push(`${file}: ${count} (was ${allowed})`)
    }
  }
  for (const file of Object.keys(baseline)) {
    if (!(file in found)) improvements.push(`${file}: 0 (was ${baseline[file]})`)
  }
  return { regressions, improvements }
}

function main() {
  const write = process.argv.includes("--write-baseline")
  const found = scanRepo()

  if (write) {
    const sorted = Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(BASELINE_FILE, JSON.stringify(sorted, null, 2) + "\n")
    const total = Object.values(sorted).reduce((a, b) => a + b, 0)
    console.log(`wrote baseline: ${Object.keys(sorted).length} files, ${total} occurrences`)
    return
  }

  if (!existsSync(BASELINE_FILE)) {
    console.error(`missing ${relative(REPO_ROOT, BASELINE_FILE)} — run with --write-baseline`)
    process.exit(1)
  }
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"))
  const { regressions, improvements } = compare(found, baseline)

  if (improvements.length > 0) {
    console.log(`surface debt paid down in ${improvements.length} file(s) — run:`)
    console.log("  pnpm audit:surfaces -- --write-baseline")
  }
  if (regressions.length === 0) {
    const total = Object.values(found).reduce((a, b) => a + b, 0)
    console.log(`OK — ${total} known occurrences, none new`)
    return
  }
  console.error(
    `\n${regressions.length} new bare panel(s) / untracked radius / raw shadow (ADR-0148):\n`
  )
  for (const line of regressions) console.error(`  ${line}`)
  console.error(
    "\nUse <Surface layer=… radius=…> from components/surface/surface.tsx for panel\n" +
      "containers, the named radius scale (rounded-control|panel|stage|pill) for\n" +
      "corners, and elevation={0..3} for depth — a style pack cannot reach\n" +
      "rounded-2xl / rounded-[…] / shadow-*.\n"
  )
  process.exit(1)
}

if (process.argv[1] && process.argv[1].endsWith("check-surface-usage.mjs")) main()
