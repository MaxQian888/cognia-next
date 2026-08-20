#!/usr/bin/env node
/**
 * Generate the companion extension's `package.nls*.json` from the app's own
 * message catalog.
 *
 * VS Code localizes a `package.json` by substituting `%key%` placeholders from
 * `package.nls.json` (default) and `package.nls.<locale>.json`. Those files are
 * read by the workbench BEFORE the extension activates, so the strings cannot
 * be pushed over the bridge like the panel's runtime text — they have to exist
 * on disk.
 *
 * Which leaves two options: hand-maintain a second vocabulary, or derive it.
 * Derived, because the extension is not a separate product: a zh-CN user
 * already gets a fully Chinese VS Code (the language pack is installed for
 * them), and an English "Cognia" submenu sitting inside it was the single most
 * visible seam in the Pro IDE. One source, `i18n/messages/<locale>/proIde.json`,
 * now feeds both the extension manifest and the app.
 *
 * Runs as part of `pnpm i18n:build`; `--check` reports drift without writing,
 * which is what the gate uses.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const MESSAGES_DIR = join(ROOT, "i18n", "messages")
const EXT_DIR = join(ROOT, "sidecar", "codeserver-agent-ext")

/**
 * App locale → nls file suffix. VS Code's own tag for Simplified Chinese is
 * `zh-cn` (lowercase), not the app's `zh-CN`; getting this wrong produces a
 * file the workbench silently never reads.
 */
const LOCALE_FILES = [
  ["en", "package.nls.json"],
  ["zh-CN", "package.nls.zh-cn.json"],
]

/**
 * Flatten to the dotted keys `%…%` placeholders use.
 *
 * The `panel.*` subtree is included on purpose: those strings are pushed to the
 * extension at runtime rather than substituted by the workbench, but keeping
 * them in the same source file is what stops the manifest vocabulary and the
 * runtime vocabulary drifting into two dialects.
 */
function flatten(value, prefix = "", out = {}) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === "object" && !Array.isArray(child)) flatten(child, path, out)
    else out[path] = String(child)
  }
  return out
}

export function buildNlsContent(locale, messagesDir = MESSAGES_DIR) {
  const source = join(messagesDir, locale, "proIde.json")
  if (!existsSync(source)) throw new Error(`missing ${source}`)
  const flat = flatten(JSON.parse(readFileSync(source, "utf8")))
  const sorted = Object.fromEntries(Object.entries(flat).sort(([a], [b]) => (a < b ? -1 : 1)))
  return `${JSON.stringify(sorted, null, 2)}\n`
}

function main(argv) {
  const check = argv.includes("--check")
  let drift = 0
  for (const [locale, filename] of LOCALE_FILES) {
    const target = join(EXT_DIR, filename)
    const next = buildNlsContent(locale)
    if (check) {
      const current = existsSync(target) ? readFileSync(target, "utf8") : ""
      if (current === next) process.stdout.write(`ok    ${target}\n`)
      else {
        drift++
        process.stderr.write(`drift ${target} (run \`pnpm i18n:build\`)\n`)
      }
      continue
    }
    writeFileSync(target, next)
    process.stdout.write(`build ${target}\n`)
  }
  if (check && drift > 0) {
    process.stderr.write(`\n${drift} extension nls artifact(s) out of sync with proIde.json.\n`)
    process.exit(1)
  }
}

if (process.argv[1]?.endsWith("build-vscode-nls.mjs")) main(process.argv.slice(2))
