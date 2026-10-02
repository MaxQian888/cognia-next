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
 * The `panel.*` strings the extension shows itself (before the app has pushed
 * a snapshot, or while disconnected) also need a runtime localization, which
 * VS Code reads from `l10n/bundle.l10n.<locale>.json` keyed by the English
 * text. Those bundles are generated from the same source; the extension looks
 * up `vscode.l10n.t(<English text from package.nls.json>)`.
 *
 * Runs as part of `pnpm i18n:build`; `--check` reports drift without writing,
 * which is what the gate uses.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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

function readFlat(locale, messagesDir) {
  const source = join(messagesDir, locale, "proIde.json")
  if (!existsSync(source)) throw new Error(`missing ${source}`)
  return flatten(JSON.parse(readFileSync(source, "utf8")))
}

const sortedJson = (record) =>
  `${JSON.stringify(
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1))),
    null,
    2
  )}\n`

export function buildNlsContent(locale, messagesDir = MESSAGES_DIR) {
  return sortedJson(readFlat(locale, messagesDir))
}

/**
 * Runtime l10n bundle for `locale`: English `panel.*` text → that locale's
 * text. Keyed by the English string because that is what `vscode.l10n.t`
 * receives. Two English strings that collide would make one translation
 * unreachable, so a collision is an error, not a silent overwrite.
 */
export function buildL10nBundleContent(locale, messagesDir = MESSAGES_DIR) {
  const english = readFlat("en", messagesDir)
  const localized = readFlat(locale, messagesDir)
  const bundle = {}
  for (const [key, source] of Object.entries(english)) {
    if (!key.startsWith("panel.")) continue
    const translated = localized[key]
    if (typeof translated !== "string") throw new Error(`${locale} is missing ${key}`)
    if (Object.hasOwn(bundle, source) && bundle[source] !== translated) {
      throw new Error(`two panel strings share the English text ${JSON.stringify(source)}`)
    }
    bundle[source] = translated
  }
  return sortedJson(bundle)
}

/** Runtime l10n bundles: VS Code locale tag → app locale. English needs none. */
const L10N_BUNDLES = [["zh-CN", join("l10n", "bundle.l10n.zh-cn.json")]]

function main(argv) {
  const check = argv.includes("--check")
  let drift = 0
  const artifacts = [
    ...LOCALE_FILES.map(([locale, filename]) => [filename, () => buildNlsContent(locale)]),
    ...L10N_BUNDLES.map(([locale, filename]) => [filename, () => buildL10nBundleContent(locale)]),
  ]
  for (const [filename, build] of artifacts) {
    const target = join(EXT_DIR, filename)
    const next = build()
    if (check) {
      const current = existsSync(target) ? readFileSync(target, "utf8") : ""
      if (current === next) process.stdout.write(`ok    ${target}\n`)
      else {
        drift++
        process.stderr.write(`drift ${target} (run \`pnpm i18n:build\`)\n`)
      }
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, next)
    process.stdout.write(`build ${target}\n`)
  }
  if (check && drift > 0) {
    process.stderr.write(`\n${drift} extension nls artifact(s) out of sync with proIde.json.\n`)
    process.exit(1)
  }
}

if (process.argv[1]?.endsWith("build-vscode-nls.mjs")) main(process.argv.slice(2))
