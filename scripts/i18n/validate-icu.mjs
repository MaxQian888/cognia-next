#!/usr/bin/env node
/**
 * Validate that every string in the assembled i18n bundles is a well-formed
 * ICU MessageFormat template.
 *
 * next-intl compiles each message with `intl-messageformat` the moment a
 * component reads it. Any string that isn't valid ICU — a literal `{{token}}`,
 * a JSON example like `{ "k": 1 }`, or a `<placeholder>` that reads as an
 * unclosed rich-text tag — throws `INVALID_MESSAGE` at compile time and shows
 * up as a console error in the running app. `{`, `}`, `<`, `#`, and `|` are ICU
 * syntax; when they should render literally they must be apostrophe-escaped
 * (`'{'`, `'<'`, …).
 *
 * `intl-messageformat` is ESM-only, so this validator is a native-ESM Node
 * script. It runs in the `i18n:build` chain (so a malformed bundle can never be
 * regenerated silently) and is exercised end-to-end by
 * `i18n/messages/icu-validity.test.ts`.
 *
 * Modes:
 *   (default)  validate the committed `i18n/messages/{en,zh-CN}.json` and exit
 *              1 if any string is malformed, printing each offender.
 *
 * Usage:
 *   pnpm i18n:validate
 */

import { readFileSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { IntlMessageFormat } from "intl-messageformat"

const __dirname = dirname(fileURLToPath(import.meta.url))
const MESSAGES_DIR = resolve(__dirname, "../../i18n/messages")

export const LOCALES = ["en", "zh-CN"]

/** Yield every string leaf as `[dottedKey, value]`. */
function* iterateStrings(node, prefix = "") {
  if (!node || typeof node !== "object") return
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === "string") yield [path, value]
    else if (value && typeof value === "object") yield* iterateStrings(value, path)
  }
}

/**
 * Return the malformed messages in one locale's message object as
 * `{ key, message, value }[]`. Strings without ICU-special characters are
 * skipped — they can never be malformed and next-intl never compiles them.
 */
export function findMalformedMessages(messages, locale) {
  const bad = []
  for (const [key, value] of iterateStrings(messages)) {
    if (!/[<{]/.test(value)) continue
    try {
      // Construction runs the ICU parser — this is exactly the compile step
      // that throws inside next-intl for a malformed template.
      new IntlMessageFormat(value, locale)
    } catch (error) {
      bad.push({ key, message: String(error.message).split("\n")[0], value })
    }
  }
  return bad
}

/** Validate both committed bundles. Returns `{ [locale]: malformed[] }`. */
export function validateBundles(messagesDir = MESSAGES_DIR) {
  const results = {}
  for (const locale of LOCALES) {
    const messages = JSON.parse(readFileSync(join(messagesDir, `${locale}.json`), "utf8"))
    results[locale] = findMalformedMessages(messages, locale)
  }
  return results
}

function main() {
  const results = validateBundles()
  let total = 0
  for (const locale of LOCALES) {
    const bad = results[locale]
    total += bad.length
    if (bad.length === 0) {
      process.stdout.write(`ok    ${locale}.json (0 malformed ICU messages)\n`)
      continue
    }
    process.stderr.write(`\n${locale}.json: ${bad.length} malformed ICU message(s):\n`)
    for (const { key, message, value } of bad) {
      process.stderr.write(`  ${key}: ${message}\n    ${JSON.stringify(value)}\n`)
    }
  }

  if (total > 0) {
    process.stderr.write(
      `\n${total} malformed ICU message(s). Wrap literal { } < # | in single quotes ` +
        `(e.g. '{'contact.name'}'), edit the split source under i18n/messages/<locale>/, ` +
        `then rerun \`pnpm i18n:build\`.\n`
    )
    process.exit(1)
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("validate-icu.mjs")
) {
  main()
}
