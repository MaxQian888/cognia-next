#!/usr/bin/env node
/** Keep the bilingual ADR catalog complete, reachable, and historically honest. */

import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const ADR_ROOT = join(REPO_ROOT, "docs", "content", "docs")
export const ADR_LOCALES = ["en", "zh"]
export const DUPLICATE_ID_ALLOWLIST = new Map([
  ["0013", ["0013-command-manifest", "0013-wasm-plugins"]],
  ["0025", ["0025-a2ui-im-bridge", "0025-unified-subscription-module"]],
  ["0026", ["0026-builtin-skills-and-lark-cli-bridge", "0026-plugin-extension-point-expansion"]],
])

const ADR_FILE = /^(\d{4})-[a-z0-9][a-z0-9-]*\.mdx?$/

export function explicitStatus(source) {
  const heading = source.match(/^#{1,2} (?:Status|状态)\s*\n+([^\n#][^\n]*)/m)
  if (heading?.[1]?.trim()) return heading[1].trim()
  const table = source.match(/^\|\s*(?:Status|状态)\s*\|\s*([^|\n]+)\|/m)
  if (table?.[1]?.trim() && !/^-+$/.test(table[1].trim())) return table[1].trim()
  const inline = source.match(
    /^(?:>\s*|-\s*)?\*\*(?:Status|状态)(?::|：)?\*\*\s*(?::|：)?\s*([^\n]+)/m
  )
  if (inline?.[1]?.trim()) return inline[1].trim()
  const plain = source.match(/^(?:>\s*)?(?:Status|状态)\s*(?::|：)\s*([^\n]+)/m)
  return plain?.[1]?.trim() || null
}

export function auditAdrCatalog({ filesByLocale, pagesByLocale, sourcesByLocale }) {
  const problems = []
  const baseline = filesByLocale[ADR_LOCALES[0]] ?? []

  for (const locale of ADR_LOCALES) {
    const files = filesByLocale[locale] ?? []
    const pages = pagesByLocale[locale] ?? []
    const fileSlugs = files.map((file) => file.replace(/\.mdx?$/, ""))
    const fileSet = new Set(fileSlugs)
    const pageSet = new Set(pages)

    for (const file of files) {
      if (!ADR_FILE.test(file)) problems.push(`${locale}: invalid ADR slug ${file}`)
      if (!explicitStatus(sourcesByLocale[locale]?.[file] ?? "")) {
        problems.push(`${locale}: ${file} has no explicit ## Status value`)
      }
    }
    for (const slug of fileSlugs) {
      if (!pageSet.has(slug)) problems.push(`${locale}: ${slug} is missing from adr/meta.json`)
    }
    for (const slug of pages) {
      if (slug !== "index" && !fileSet.has(slug)) {
        problems.push(`${locale}: adr/meta.json references missing ${slug}`)
      }
    }

    const byId = new Map()
    for (const slug of fileSlugs) {
      const id = slug.slice(0, 4)
      byId.set(id, [...(byId.get(id) ?? []), slug])
    }
    for (const [id, slugs] of byId) {
      if (slugs.length < 2) continue
      const allowed = DUPLICATE_ID_ALLOWLIST.get(id) ?? []
      if ([...slugs].sort().join("\n") !== [...allowed].sort().join("\n")) {
        problems.push(`${locale}: duplicate ADR-${id} is not allowlisted: ${slugs.join(", ")}`)
      }
    }
  }

  const baselineSet = new Set(baseline)
  for (const locale of ADR_LOCALES.slice(1)) {
    const localeSet = new Set(filesByLocale[locale] ?? [])
    for (const file of baselineSet) {
      if (!localeSet.has(file)) problems.push(`${locale}: missing locale peer for ${file}`)
    }
    for (const file of localeSet) {
      if (!baselineSet.has(file)) problems.push(`en: missing locale peer for ${file}`)
    }
  }

  return problems
}

function readCatalog(locale) {
  const dir = join(ADR_ROOT, locale, "adr")
  const files = readdirSync(dir).filter((file) => /\.mdx?$/.test(file) && file !== "index.mdx")
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))
  return {
    files: files.sort(),
    pages: (meta.pages ?? []).filter((page) => typeof page === "string"),
    sources: Object.fromEntries(files.map((file) => [file, readFileSync(join(dir, file), "utf8")])),
  }
}

function main() {
  const catalogs = Object.fromEntries(ADR_LOCALES.map((locale) => [locale, readCatalog(locale)]))
  const problems = auditAdrCatalog({
    filesByLocale: Object.fromEntries(
      ADR_LOCALES.map((locale) => [locale, catalogs[locale].files])
    ),
    pagesByLocale: Object.fromEntries(
      ADR_LOCALES.map((locale) => [locale, catalogs[locale].pages])
    ),
    sourcesByLocale: Object.fromEntries(
      ADR_LOCALES.map((locale) => [locale, catalogs[locale].sources])
    ),
  })
  if (problems.length) {
    console.error(`[adr-catalog] ${problems.length} problem(s):`)
    for (const problem of problems.sort()) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log(
    `[adr-catalog] OK: ${catalogs.en.files.length} bilingual ADR slugs, explicit statuses, aligned sidebars.`
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
