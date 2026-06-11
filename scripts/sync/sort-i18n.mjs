#!/usr/bin/env node
/**
 * Normalise the i18n message files by recursively sorting object keys.
 *
 * `i18n/messages/en.json` and `i18n/messages/zh-CN.json` are hand-edited from
 * many places, so keys land in arbitrary order and the same logical key can
 * sit at different positions in each locale. That makes diffs noisy and makes
 * en/zh drift hard to eyeball. This script reorders keys alphabetically at
 * every depth — values are never touched, so it is ICU-safe — and writes the
 * canonical `JSON.stringify(obj, null, 2) + "\n"` form (LF, 2-space indent,
 * trailing newline), which is exactly what prettier produces.
 *
 * Modes:
 *   (default)  rewrite both files in place.
 *   --check    exit 1 if either file is not already sorted; never writes.
 *              Suitable for CI once sorted message files are adopted.
 *
 * Usage:
 *   pnpm i18n:sort
 *   pnpm i18n:sort:check
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "../..")

export const MESSAGE_FILES = [
  resolve(ROOT, "i18n/messages/en.json"),
  resolve(ROOT, "i18n/messages/zh-CN.json"),
]

/**
 * Recursively sort the keys of plain objects. Arrays and primitives are
 * returned as-is (order inside arrays is meaningful). Pure — no I/O.
 */
export function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value !== null && typeof value === "object") {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = sortDeep(value[key])
    }
    return out
  }
  return value
}

/** Canonical serialisation: prettier-compatible (LF, 2-space, trailing \n). */
export function serialize(obj) {
  return `${JSON.stringify(sortDeep(obj), null, 2)}\n`
}

function main(argv) {
  const check = argv.includes("--check")
  let unsorted = 0

  for (const file of MESSAGE_FILES) {
    const current = readFileSync(file, "utf8")
    const sorted = serialize(JSON.parse(current))
    if (current === sorted) {
      process.stdout.write(`ok   ${file}\n`)
      continue
    }
    if (check) {
      unsorted++
      process.stderr.write(`drift ${file} (run \`pnpm i18n:sort\`)\n`)
    } else {
      writeFileSync(file, sorted)
      process.stdout.write(`sort ${file}\n`)
    }
  }

  if (check && unsorted > 0) {
    process.stderr.write(`\n${unsorted} message file(s) not key-sorted.\n`)
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("sort-i18n.mjs")) {
  main(process.argv.slice(2))
}
