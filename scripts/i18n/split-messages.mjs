#!/usr/bin/env node
/**
 * One-shot migration: explode the monolithic `i18n/messages/{en,zh-CN}.json`
 * into per-namespace split sources under `i18n/messages/{locale}/`.
 *
 * Layout produced (see scripts/i18n/build-messages.mjs for the inverse):
 *   - plain namespace            → `<locale>/<ns>.json`
 *   - sub-split namespace        → `<locale>/<ns>/<objectKey>.json`
 *     (only for SUBSPLIT members) + `<locale>/<ns>/_root.json` for stray
 *     scalar/array leaves sitting directly under the namespace.
 *
 * `SUBSPLIT` is the set of namespaces that are both large (>=30KB) and
 * object-dominant — `providers`/`scheduler` are large but flat, so they stay
 * single files. Files are written with the canonical `serialize()` form so the
 * split sources are themselves key-sorted (clean diffs).
 *
 * Safety: the big files are the source of truth for this migration and are
 * NEVER written here. After writing the split sources, the script re-assembles
 * them and asserts the result deep-equals the original big file (order-
 * independent) — it throws before declaring success if any data was lost.
 *
 * This is intended to run exactly once. After it, `pnpm i18n:build` keeps the
 * big artifacts in sync from the split sources.
 *
 * Usage:  node scripts/i18n/split-messages.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { serialize } from "../sync/sort-i18n.mjs"
import { assembleLocale, LOCALES, isPlainObject } from "./build-messages.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "../..")
const MESSAGES_DIR = resolve(ROOT, "i18n/messages")

/** Large AND object-dominant namespaces get sub-split one level deeper. */
export const SUBSPLIT = new Set(["settings", "workflows", "mobile", "plugins"])

const ROOT_LEAF_FILE = "_root.json"

function writeJson(file, value) {
  writeFileSync(file, serialize(value))
}

function splitLocale(locale, messagesDir = MESSAGES_DIR) {
  const bigFile = join(messagesDir, `${locale}.json`)
  const original = JSON.parse(readFileSync(bigFile, "utf8"))
  const localeDir = join(messagesDir, locale)

  // Start from a clean split dir so no stale partials (e.g. the pre-existing
  // drifted en/a2ui.json) survive. The big file is a sibling, untouched.
  if (existsSync(localeDir)) rmSync(localeDir, { recursive: true, force: true })
  mkdirSync(localeDir, { recursive: true })

  for (const ns of Object.keys(original)) {
    const value = original[ns]

    if (SUBSPLIT.has(ns) && isPlainObject(value)) {
      const nsDir = join(localeDir, ns)
      mkdirSync(nsDir, { recursive: true })
      const rootLeaves = {}
      for (const key of Object.keys(value)) {
        const child = value[key]
        if (isPlainObject(child)) {
          writeJson(join(nsDir, `${key}.json`), child)
        } else {
          rootLeaves[key] = child
        }
      }
      if (Object.keys(rootLeaves).length > 0) {
        writeJson(join(nsDir, ROOT_LEAF_FILE), rootLeaves)
      }
      continue
    }

    writeJson(join(localeDir, `${ns}.json`), value)
  }

  // Self-verify: assembling the split sources must reproduce the original.
  const rebuilt = serialize(assembleLocale(localeDir))
  const expected = serialize(original)
  if (rebuilt !== expected) {
    throw new Error(
      `i18n split verification FAILED for "${locale}": assembled split sources ` +
        `do not match ${bigFile}. The big file was left untouched.`
    )
  }
  process.stdout.write(
    `split ${locale}: ${Object.keys(original).length} namespaces → ${localeDir} (verified)\n`
  )
}

function main() {
  for (const locale of LOCALES) splitLocale(locale)
  process.stdout.write(
    "\nSplit complete. Run `pnpm i18n:build` to (re)generate the sorted big artifacts.\n"
  )
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("split-messages.mjs")
) {
  main()
}

export { splitLocale }
