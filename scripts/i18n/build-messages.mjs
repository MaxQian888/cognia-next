#!/usr/bin/env node
/**
 * Assemble the per-namespace i18n source files back into the canonical
 * monolithic `i18n/messages/{en,zh-CN}.json` artifacts.
 *
 * Humans edit the split sources under `i18n/messages/{locale}/` (one file per
 * top-level namespace; the largest, object-dominant namespaces are sub-split
 * one level deeper into a `<namespace>/` directory with an optional
 * `_root.json` holding the stray scalar leaves). Every *consumer* — the client
 * bundle, every `*.test.tsx` that imports `@/i18n/messages/en.json`,
 * `jest.setup.ts`, `scripts/gates/lint-i18n.ts`, and `scripts/sync/sort-i18n.mjs`
 * — keeps reading the big files, which this script regenerates from the split
 * sources. A freshness check (`--check`) guarantees `big === assemble(split)`.
 *
 * Output is produced via `serialize()` from `sort-i18n.mjs`, so the generated
 * files are byte-identical to what `pnpm i18n:sort` would write (LF, 2-space
 * indent, trailing newline, keys sorted at every depth) — `i18n:sort:check`
 * stays green on the generated artifacts.
 *
 * Modes:
 *   (default)  rewrite both big files from the split sources.
 *   --check    assemble in memory and exit 1 if either committed big file
 *              differs (i.e. someone edited a split file without rebuilding,
 *              or hand-edited the generated artifact).
 *
 * Usage:
 *   pnpm i18n:build
 *   pnpm i18n:build:check
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { serialize } from "../sync/sort-i18n.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "../..")
const MESSAGES_DIR = resolve(ROOT, "i18n/messages")

export const LOCALES = ["en", "zh-CN"]

const ROOT_LEAF_FILE = "_root.json"

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

/**
 * Assemble one locale's full message object from its split-source directory.
 *
 * For each entry directly under `localeDir`:
 *   - `<ns>.json`         → result[ns] = <parsed file>
 *   - `<ns>/`  directory  → result[ns] = { ...(_root.json), [k]: <ns>/<k>.json }
 *
 * A namespace may not exist as both a file and a directory. Non-`.json` files
 * and nested directories deeper than one level are ignored. Pure read — no
 * writes. Exported for the split self-verification and unit tests.
 */
export function assembleLocale(localeDir) {
  const result = {}
  const seen = new Set()

  for (const entry of readdirSync(localeDir).sort()) {
    const full = join(localeDir, entry)
    const isDir = statSync(full).isDirectory()

    if (isDir) {
      const ns = entry
      if (seen.has(ns))
        throw new Error(`i18n: namespace "${ns}" exists as both file and directory in ${localeDir}`)
      seen.add(ns)

      const composed = {}
      const rootFile = join(full, ROOT_LEAF_FILE)
      if (existsSync(rootFile)) Object.assign(composed, readJson(rootFile))

      for (const sub of readdirSync(full).sort()) {
        if (sub === ROOT_LEAF_FILE || !sub.endsWith(".json")) continue
        const key = sub.slice(0, -".json".length)
        composed[key] = readJson(join(full, sub))
      }
      result[ns] = composed
      continue
    }

    if (!entry.endsWith(".json")) continue
    const ns = entry.slice(0, -".json".length)
    if (seen.has(ns))
      throw new Error(`i18n: namespace "${ns}" exists as both file and directory in ${localeDir}`)
    seen.add(ns)
    result[ns] = readJson(full)
  }

  return result
}

/** Assemble + serialize one locale into the canonical big-file string form. */
export function buildLocaleContent(locale, messagesDir = MESSAGES_DIR) {
  return serialize(assembleLocale(join(messagesDir, locale)))
}

function main(argv) {
  const check = argv.includes("--check")
  let drift = 0

  for (const locale of LOCALES) {
    const target = join(MESSAGES_DIR, `${locale}.json`)
    const next = buildLocaleContent(locale)

    if (check) {
      const current = existsSync(target) ? readFileSync(target, "utf8") : ""
      if (current === next) {
        process.stdout.write(`ok    ${target}\n`)
      } else {
        drift++
        process.stderr.write(`drift ${target} (run \`pnpm i18n:build\`)\n`)
      }
      continue
    }

    writeFileSync(target, next)
    process.stdout.write(`build ${target}\n`)
  }

  if (check && drift > 0) {
    process.stderr.write(`\n${drift} message artifact(s) out of sync with split sources.\n`)
    process.exit(1)
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("build-messages.mjs")
) {
  main(process.argv.slice(2))
}

export { isPlainObject }
