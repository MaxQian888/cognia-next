/**
 * Markdown exporter — turns Dexie `wikiArticles` rows into MDX files under
 * `docs/content/docs/wiki/<scope>/`.
 *
 * The exporter is fs-abstract: callers inject a `WriteFs` so the same code
 * drives the Tauri-plugin-fs path in production and an in-memory map in
 * tests. Files are written byte-for-byte stable across runs given the same
 * inputs (the only field that varies is `generatedAt`, which the exporter
 * deliberately drops from the file body — it lives in the front-matter as
 * an ISO-8601 string so the file diff stays clean across rebuilds).
 *
 * Phase 1 emits Fumadocs-friendly MDX (front-matter + body + sourceRefs
 * footer). The `docs/` Fumadocs subapp picks them up via its content
 * collection if/when the user opts to publish.
 *
 * Plan-path deviation: the plan called for `lib/wiki/exporter/{markdown,index-page}.ts`
 * but the export logic is small enough (~200 lines combined) that a single
 * file beats the subdirectory ceremony. The two responsibilities (article
 * export + index export) live as separate top-level functions here.
 */

import { listWikiArticlesByScope } from "@/lib/db/wiki-articles"
import type { WikiArticle, WikiScope, WikiSourceRef } from "@/types/wiki"

/** Inversion-of-control writer surface — keeps the exporter Tauri/Node-agnostic. */
export interface WriteFs {
  /** Recursively create a directory (no-op if it exists). */
  mkdirp(path: string): Promise<void>
  /** Write a UTF-8 file (overwrite). */
  writeFile(path: string, content: string): Promise<void>
}

export interface ExportOptions {
  scope: WikiScope
  /** Root output dir; the exporter writes under `<rootDir>/<scope>/`. */
  rootDir: string
  /** Optional override for the index page contentMd. */
  indexContentMd?: string
}

export interface ExportResult {
  scope: WikiScope
  articlesWritten: number
  indexWritten: boolean
  /** Absolute (or rootDir-relative) paths of every file the exporter touched. */
  filePaths: string[]
}

/**
 * Write every wiki article in a scope to disk plus an index page. Returns
 * the list of files touched so the caller (Settings UI) can render
 * "Exported 87 articles".
 */
export async function exportWikiToMarkdown(
  fs: WriteFs,
  opts: ExportOptions
): Promise<ExportResult> {
  const articles = await listWikiArticlesByScope(opts.scope)
  const dir = joinPath(opts.rootDir, opts.scope)
  await fs.mkdirp(dir)

  const filePaths: string[] = []
  for (const article of articles) {
    const path = joinPath(dir, `${article.slug}.mdx`)
    const body = renderArticleMdx(article)
    await fs.writeFile(path, body)
    filePaths.push(path)
  }

  let indexWritten = false
  if (articles.length > 0) {
    const indexPath = joinPath(dir, "index.mdx")
    const indexBody = renderIndexMdx(opts.scope, articles, opts.indexContentMd)
    await fs.writeFile(indexPath, indexBody)
    filePaths.push(indexPath)
    indexWritten = true
  }

  return {
    scope: opts.scope,
    articlesWritten: articles.length,
    indexWritten,
    filePaths,
  }
}

/**
 * Render one article as MDX. The body is the article's `contentMd`
 * verbatim plus a "Sources" footer that pretty-prints `sourceRefs` as a
 * Markdown list. Front-matter holds the title + slug + an ISO-8601
 * `generatedAt` so file diffs stay readable.
 */
export function renderArticleMdx(article: WikiArticle): string {
  const lines: string[] = []
  lines.push("---")
  lines.push(`title: ${escapeYaml(article.title)}`)
  lines.push(`description: ${escapeYaml(article.summary)}`)
  lines.push(`slug: ${article.slug}`)
  lines.push(`module: ${article.module}`)
  lines.push(`scope: ${article.scope}`)
  lines.push(`pageRank: ${article.pageRank.toFixed(4)}`)
  lines.push(`generatedAt: ${new Date(article.generatedAt).toISOString()}`)
  lines.push(`generatorVersion: ${article.generatorVersion}`)
  lines.push("---")
  lines.push("")
  lines.push(article.contentMd.trim())
  if (article.sourceRefs.length > 0) {
    lines.push("")
    lines.push("## Sources")
    lines.push("")
    for (const ref of dedupeRefs(article.sourceRefs)) {
      lines.push(`- \`${ref.filePath}:${ref.lineStart}-${ref.lineEnd}\``)
    }
  }
  return lines.join("\n") + "\n"
}

/**
 * Render the top-level index page for a scope. When `customMd` is
 * provided (e.g. the IndexPageAgent's output) we use it verbatim;
 * otherwise we synthesize a list of article links.
 */
export function renderIndexMdx(
  scope: WikiScope,
  articles: readonly WikiArticle[],
  customMd?: string
): string {
  const lines: string[] = []
  lines.push("---")
  lines.push(`title: Cognia ${scope} wiki`)
  lines.push(`description: Top-level index for the ${scope} wiki scope.`)
  lines.push(`scope: ${scope}`)
  lines.push(`articleCount: ${articles.length}`)
  lines.push("---")
  lines.push("")
  if (customMd && customMd.trim().length > 0) {
    lines.push(customMd.trim())
  } else {
    lines.push(`# Cognia ${scope} wiki`)
    lines.push("")
    lines.push("Top-ranked modules:")
    lines.push("")
    const sorted = [...articles].sort((a, b) => b.pageRank - a.pageRank)
    for (const article of sorted) {
      lines.push(
        `- [${article.title}](${article.slug}.mdx) — ${article.summary.replace(/\s+/g, " ").trim()}`
      )
    }
  }
  return lines.join("\n") + "\n"
}

function dedupeRefs(refs: readonly WikiSourceRef[]): WikiSourceRef[] {
  const seen = new Set<string>()
  const out: WikiSourceRef[] = []
  for (const ref of refs) {
    const key = `${ref.filePath}:${ref.lineStart}-${ref.lineEnd}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

/** Escape a YAML scalar — minimal pass for the fields we control. */
function escapeYaml(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return '""'
  if (/[:#&*?|<>=!%@`{}\[\],"\\\n]/.test(trimmed)) {
    return JSON.stringify(trimmed)
  }
  return trimmed
}

function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^[\\/]+|[\\/]+$/g, ""))
    .filter((p) => p.length > 0)
    .join("/")
}

export const __TESTING__ = { dedupeRefs, escapeYaml, joinPath }
