#!/usr/bin/env node
/**
 * Gate: the docs site has no dangling internal links and no unreachable pages.
 *
 * Three classes of breakage, all of which have actually happened here:
 *
 *   1. **Dead internal link** — `[x](/en/docs/typo)`. A static export answers
 *      with the generic 404; nothing in the build fails.
 *   2. **Dangling meta.json entry** — a `pages` row naming a file that isn't
 *      there. fumadocs silently drops it.
 *   3. **Orphan page** — a page NOT named in its folder's `meta.json`. This is
 *      the quiet one: the file builds, gets a URL, lands in the sitemap, and
 *      is completely absent from the sidebar, `llms.txt` and prev/next. 15
 *      English ADRs were invisible this way.
 *
 * Also reports EN/ZH parity, which is informational rather than fatal: some
 * pages are intentionally English-only and reachable from the Chinese sidebar
 * through explicit `[title](/en/docs/...)` link rows.
 *
 * Usage:
 *   pnpm audit:docs-links
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const CONTENT_ROOT = join(REPO_ROOT, "docs", "content", "docs")

/** Locales that get a URL prefix, mirroring `docs/lib/i18n.ts`. */
export const LOCALES = ["en", "zh"]

const PAGE_EXT = /\.mdx?$/

// ---------------------------------------------------------------- pure logic

/**
 * URL(s) a content file answers on.
 *
 * A path with no leading locale segment is shared across locales, so it
 * answers on every prefix — that's how `content/docs/plugin-dev/**` works.
 */
export function urlsForContentPath(contentPath, locales = LOCALES) {
  const withoutExt = contentPath.replace(PAGE_EXT, "")
  const segments = withoutExt.split("/")
  const isIndex = segments.at(-1) === "index"
  const trimmed = isIndex ? segments.slice(0, -1) : segments

  const [head, ...rest] = trimmed
  if (locales.includes(head)) {
    return [`/${head}/docs${rest.length ? `/${rest.join("/")}` : ""}`]
  }

  return locales.map((locale) => `/${locale}/docs${trimmed.length ? `/${trimmed.join("/")}` : ""}`)
}

/** Strip the fragment and query so `/a/b#c` checks against `/a/b`. */
export function normalizeLink(href) {
  return href.split("#")[0].split("?")[0].replace(/\/+$/, "") || "/"
}

/** Internal doc links worth checking — site-absolute paths only. */
export function extractInternalLinks(source) {
  const links = new Set()

  // Markdown links/images, then JSX/HTML href attributes.
  for (const [, href] of source.matchAll(/\]\((\/[^)\s]*)\)/g)) links.add(href)
  for (const [, href] of source.matchAll(/href=["'](\/[^"']*)["']/g)) links.add(href)

  return [...links].filter((href) => !href.startsWith("//"))
}

/** meta.json `pages` rows that name a sibling file, ignoring separators/links/rest. */
export function metaPageRefs(pages) {
  return (pages ?? []).filter(
    (row) =>
      typeof row === "string" &&
      !row.startsWith("---") &&
      !row.startsWith("[") &&
      !row.startsWith("external:") &&
      row !== "..." &&
      row !== "z...a" &&
      !row.startsWith("!") &&
      !row.startsWith("...")
  )
}

// ------------------------------------------------------------------- walking

function walk(dir, onFile) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, onFile)
    else onFile(full)
  }
}

function collect(contentRoot) {
  const pages = []
  const metas = []

  walk(contentRoot, (full) => {
    const rel = relative(contentRoot, full).split("\\").join("/")
    if (PAGE_EXT.test(rel)) pages.push(rel)
    else if (rel.endsWith("meta.json")) metas.push(rel)
  })

  return { pages, metas }
}

// -------------------------------------------------------------------- checks

function main() {
  const { pages, metas } = collect(CONTENT_ROOT)

  const knownUrls = new Set()
  for (const page of pages) {
    for (const url of urlsForContentPath(page)) knownUrls.add(url)
  }

  const problems = []

  // 1. dead internal links
  for (const page of pages) {
    const source = readFileSync(join(CONTENT_ROOT, page), "utf8")
    for (const href of extractInternalLinks(source)) {
      const target = normalizeLink(href)
      // Only judge links into the docs tree; assets and other routes are not ours.
      if (!/^\/(en|zh)\/docs(\/|$)/.test(target)) continue
      if (!knownUrls.has(target)) {
        problems.push(`dead link   ${page} -> ${href}`)
      }
    }
  }

  // 2. dangling meta.json entries + 3. orphan pages
  const pageSet = new Set(pages)
  const listed = new Set()

  for (const meta of metas) {
    const dir = dirname(meta)
    const parsed = JSON.parse(readFileSync(join(CONTENT_ROOT, meta), "utf8"))

    for (const ref of metaPageRefs(parsed.pages)) {
      const base = dir === "." ? ref : `${dir}/${ref}`
      const candidates = [`${base}.mdx`, `${base}.md`, `${base}/index.mdx`, `${base}/index.md`]
      const hit = candidates.find((candidate) => pageSet.has(candidate))

      if (hit) listed.add(hit)
      else if (!pages.some((page) => page.startsWith(`${base}/`))) {
        problems.push(`dangling    ${meta} -> "${ref}"`)
      }
    }
  }

  const orphans = pages.filter((page) => {
    const dir = dirname(page)
    // Only folders that declare a `pages` array can orphan a file; a folder
    // with no meta.json lists everything implicitly.
    const meta = dir === "." ? "meta.json" : `${dir}/meta.json`
    if (!metas.includes(meta)) return false
    if (/(^|\/)index\.mdx?$/.test(page)) return false
    return !listed.has(page)
  })

  for (const orphan of orphans) {
    problems.push(`orphan      ${orphan} (not listed in its meta.json)`)
  }

  // Informational: locale parity.
  const slugsFor = (locale) =>
    new Set(
      pages
        .filter((page) => page.startsWith(`${locale}/`))
        .map((page) => page.slice(locale.length + 1).replace(PAGE_EXT, ""))
    )
  const en = slugsFor("en")
  const zh = slugsFor("zh")
  const enOnly = [...en].filter((slug) => !zh.has(slug))
  const zhOnly = [...zh].filter((slug) => !en.has(slug))

  console.log(
    `[docs-links] ${pages.length} pages, ${metas.length} meta.json, ${knownUrls.size} URLs`
  )
  console.log(`[docs-links] parity: ${enOnly.length} en-only, ${zhOnly.length} zh-only`)

  if (problems.length > 0) {
    console.error(`\n[docs-links] ${problems.length} problem(s):\n`)
    for (const problem of problems.sort()) console.error(`  ${problem}`)
    process.exit(1)
  }

  console.log("[docs-links] OK: no dead links, dangling entries, or orphan pages.")
}

// Only run when invoked directly, so the test can import the pure helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
