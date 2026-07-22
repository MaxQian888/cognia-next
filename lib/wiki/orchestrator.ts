/**
 * Wiki orchestrator — drives the end-to-end indexing pipeline.
 *
 * Phase 1 MVP scope (per the plan):
 *   1. Walk source files via the injected `FileSystem`
 *   2. Filter through `file-walker.shouldIncludeFile`
 *   3. Build a Merkle map → diff against persisted `wikiManifest`
 *   4. For changed/added files, slice into `CodeChunk[]` via the Twin
 *      ingest chunker (pure function, no Dexie writes)
 *   5. Run `RepoMapAgent` to compute pageRank for every module
 *   6. For each affected module, run `ModuleArticleAgent` (LLM call)
 *   7. Apply `CrossRefAgent` to insert [[slug]] links across articles
 *   8. Run `IndexPageAgent` once to produce the top-level index
 *   9. Persist articles + sections + manifest to Dexie
 *
 * The orchestrator never throws on partial failure: per-module errors
 * are collected into the result so the caller (Settings UI) can surface
 * "5 modules updated, 1 failed" rather than dropping the whole rebuild.
 *
 * Dependencies are injected so the same code drives:
 *   • Tests with an in-memory `FileSystem` + mock `LlmClient`
 *   • Tauri runtime with `plugin-fs` + the configured Anthropic client
 *   • The standalone bundle with `node:fs` + the Anthropic client
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { prepareChunks } from "@/lib/twin/ingest/chunk"
import { runIndexPageAgent, type ArticleSummary } from "./agents/index-page-agent"
import { assembleArticle } from "./agents/module-article-agent"
import { applyCrossRefs, buildSlugIndex } from "./agents/cross-ref-agent"
import { buildModuleStats, chunksWithinBudget } from "./agents/repo-map-agent"
import { buildImportGraph } from "./agents/import-graph"
import { bucketByModule, filterIncludedPaths } from "./file-walker"
import { buildMerkleMap, hashContent } from "./merkle"
import { moduleArticlePrompt, WIKI_SYSTEM_VOICE } from "./prompts"
import type { CodeChunk, IndexPageDraft, ModuleArticleDraft, ModuleStat } from "./types"
import {
  bulkCreateWikiArticles,
  deleteAllWikiArticlesForScope,
  deleteStaleWikiArticles,
} from "@/lib/db/wiki-articles"
import { bulkCreateWikiSections } from "@/lib/db/wiki-sections"
import { diffManifest, getWikiManifest, upsertWikiManifest } from "@/lib/db/wiki-manifest"
import type { WikiArticle, WikiScope, WikiSourceRef } from "@/types/wiki"
import { estimateFallbackTokens } from "@/lib/ai/tokens/fallback-estimator"

/** Inversion-of-control surface for the host filesystem. */
export interface FileSystem {
  /** Return every path under `rootDir` (recursive); paths are relative to `rootDir`. */
  walk(rootDir: string): Promise<string[]>
  /** Read a UTF-8 source file given a path relative to `rootDir`. */
  readFile(relPath: string): Promise<string>
}

/** Embeds article text. Returns a stub zero-vector when not configured. */
export type EmbedFn = (text: string) => Promise<number[]>

export const ZERO_EMBEDDING: number[] = Object.freeze(
  [] as number[]
) as readonly number[] as number[]

const DEFAULT_MODULE_TOKEN_BUDGET = 6000
const DEFAULT_FILE_TOKEN_BUDGET_PER_CHUNK = 800

export interface WikiOrchestratorDeps {
  fs: FileSystem
  llm: LlmClient
  embed?: EmbedFn
}

export interface RebuildOptions {
  scope: WikiScope
  rootDir: string
  generatorVersion: string
  /** When true, ignore the existing manifest and re-process every file. */
  force?: boolean
  /** Override the default per-module token budget for `ModuleArticleAgent`. */
  moduleTokenBudget?: number
}

export interface RebuildResult {
  added: number
  changed: number
  removed: number
  unchanged: number
  /** Articles freshly written (or rewritten) on this run. */
  articles: WikiArticle[]
  /** Top-level index page, when at least one article was written. */
  indexPage?: IndexPageDraft
  /** Per-module errors that didn't abort the run. */
  errors: { module: string; message: string }[]
  durationMs: number
}

/**
 * Run a full or incremental wiki rebuild for a scope.
 *
 * Incremental rebuild (default): only files whose SHA-256 changed since the
 * persisted manifest are re-processed. Removed files trigger article deletes.
 *
 * Full rebuild (`force: true`): every article in the scope is dropped and
 * re-created. Use when the generator version bumps in a way that invalidates
 * older articles (e.g. prompt template changes).
 */
export async function rebuildWiki(
  deps: WikiOrchestratorDeps,
  opts: RebuildOptions
): Promise<RebuildResult> {
  const startedAt = Date.now()
  const errors: { module: string; message: string }[] = []
  const embed: EmbedFn = deps.embed ?? (async () => [...ZERO_EMBEDDING])

  // 1. Walk + filter.
  const allPaths = await deps.fs.walk(opts.rootDir)
  const includedPaths = filterIncludedPaths(allPaths)

  // 2. Read every included file once and build the current Merkle map.
  const fileContents = new Map<string, string>()
  for (const path of includedPaths) {
    const content = await deps.fs.readFile(path)
    fileContents.set(path, content)
  }
  const currentHashes = await buildMerkleMap(
    Array.from(fileContents, ([path, content]) => ({ path, content }))
  )

  // 3. Diff against the persisted manifest.
  const previousManifest = opts.force ? undefined : await getWikiManifest(opts.scope)
  const diff = diffManifest(previousManifest, currentHashes)

  // Force-rebuild semantics: drop every existing article in this scope so
  // we don't end up with a mix of old + new generator versions.
  if (opts.force) {
    await deleteAllWikiArticlesForScope(opts.scope)
  } else {
    await deleteStaleWikiArticles(opts.scope, opts.generatorVersion)
  }

  // Determine the set of modules that need (re)processing. On force we hit
  // every module; otherwise only modules touched by added/changed/removed
  // files are considered (unchanged modules keep their existing article).
  const touchedFiles = opts.force ? includedPaths : [...diff.added, ...diff.changed]
  const modulesToProcess = new Set<string>()
  for (const [modulePath] of bucketByModule(touchedFiles)) {
    modulesToProcess.add(modulePath)
  }

  // For removed files, we don't currently delete the parent module's
  // article (the module may still exist with other files). The orchestrator
  // simply re-processes any module that lost a file so the article reflects
  // the new file set; if the module is now empty it'll fall out of the
  // bucket map naturally and the article stays as a tombstone until force.
  for (const [modulePath] of bucketByModule(diff.removed)) {
    modulesToProcess.add(modulePath)
  }

  // 4. Build chunks for every included file (covers both incremental and
  //    force runs — `chunksByModule` is the input to RepoMapAgent).
  const chunksByModule = new Map<string, CodeChunk[]>()
  for (const [path, content] of fileContents) {
    const moduleChunks = sliceFileToChunks(path, content, currentHashes[path] ?? "")
    for (const chunk of moduleChunks) {
      const list = chunksByModule.get(chunk.module)
      if (list) list.push(chunk)
      else chunksByModule.set(chunk.module, [chunk])
    }
  }
  const allChunks: CodeChunk[] = []
  for (const list of chunksByModule.values()) allChunks.push(...list)

  // 5. RepoMapAgent — compute module pageRank scores. Build the module import
  //    graph from the chunk contents (already in memory) so ranking reflects
  //    real dependency centrality (Aider-style PageRank), falling back to the
  //    size heuristic if graph construction fails for any reason.
  let importGraph: Map<string, Set<string>> | undefined
  try {
    importGraph = buildImportGraph(allChunks)
  } catch {
    importGraph = undefined
  }
  const stats = buildModuleStats(allChunks, { importGraph })
  const statByModule = new Map(stats.map((s) => [s.module, s]))

  // 6. ModuleArticleAgent — one LLM call per module that needs work.
  const drafts: ModuleArticleDraft[] = []
  const tokenBudget = opts.moduleTokenBudget ?? DEFAULT_MODULE_TOKEN_BUDGET
  for (const modulePath of modulesToProcess) {
    const stat = statByModule.get(modulePath)
    if (!stat) continue // module had only removed files — nothing to write
    const moduleChunks = chunksByModule.get(modulePath) ?? []
    if (moduleChunks.length === 0) continue
    const inBudget = chunksWithinBudget(moduleChunks, tokenBudget)
    try {
      const llmResponse = await deps.llm.complete(
        moduleArticlePrompt({ module: modulePath, stat, chunks: inBudget }),
        { system: WIKI_SYSTEM_VOICE, temperature: 0, maxTokens: 2048 }
      )
      const fileHashes = pickFileHashes(stat.filePaths, currentHashes)
      const draft = assembleArticle(stat, inBudget, fileHashes, llmResponse)
      drafts.push(draft)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ module: modulePath, message })
    }
  }

  // 7. CrossRefAgent — insert [[slug]] links across all drafts (including
  //    the unchanged modules' slugs so links can point at them).
  const allArticleStubs = await collectExistingArticleStubsForScope(opts.scope)
  const slugIndex = buildSlugIndex([
    ...allArticleStubs.map((a) => ({ module: a.module, slug: a.slug })),
    ...drafts.map((d) => ({ module: d.module, slug: d.slug })),
  ])
  for (const draft of drafts) {
    const linked = applyCrossRefs(draft.contentMd, slugIndex)
    draft.contentMd = linked.body
    for (const section of draft.sections) {
      section.bodyMd = applyCrossRefs(section.bodyMd, slugIndex).body
    }
  }

  // 8. Persist articles + sections.
  const persisted = await persistDrafts(drafts, opts.scope, opts.generatorVersion, embed, stats)

  // 9. IndexPageAgent — re-generate top-level index over the full article set.
  let indexPage: IndexPageDraft | undefined
  if (drafts.length > 0) {
    const summaries: ArticleSummary[] = [
      ...allArticleStubs.map((a) => ({
        slug: a.slug,
        module: a.module,
        summary: a.summary,
        pageRank: a.pageRank,
      })),
      ...persisted.map((a) => ({
        slug: a.slug,
        module: a.module,
        summary: a.summary,
        pageRank: a.pageRank,
      })),
    ]
    try {
      indexPage = await runIndexPageAgent({ llm: deps.llm }, summaries)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ module: "<index>", message })
    }
  }

  // 10. Persist the manifest with the fresh Merkle map.
  const articleCount = allArticleStubs.length - persisted.length + persisted.length
  await upsertWikiManifest({
    scope: opts.scope,
    fileHashes: currentHashes,
    lastBuildAt: Date.now(),
    articleCount,
    generatorVersion: opts.generatorVersion,
  })

  return {
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
    unchanged: diff.unchanged.length,
    articles: persisted,
    indexPage,
    errors,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Slice a single file's text into `CodeChunk[]` via the Twin chunker. The
 * Twin pipeline's `code` strategy is content-aware (function/class
 * boundaries) but here we just need the offsets — we don't write into
 * `twinChunks`, so the per-chunk metadata matters only locally.
 *
 * Fallback: when the chunker returns an empty list (tiny file with no
 * recognizable code structure), we synthesize a single chunk covering the
 * whole file so `RepoMapAgent` still sees the module exists.
 */
function sliceFileToChunks(filePath: string, content: string, fileHash: string): CodeChunk[] {
  const modulePath = parentDir(filePath)
  const prepared = prepareChunks({
    redactedText: content,
    originalText: content,
    format: "code",
  })
  const out: CodeChunk[] = prepared.map((p, idx) => {
    const lineStart = lineNumberAt(content, p.charStart)
    const lineEnd = lineNumberAt(content, p.charEnd)
    return {
      id: `${filePath}:${idx}`,
      filePath,
      module: modulePath,
      lineStart,
      lineEnd,
      tokenCount: p.tokenCount,
      content: p.content,
      fileHash,
    }
  })
  if (out.length === 0 && content.trim().length > 0) {
    const totalLines = content.split(/\r?\n/).length
    out.push({
      id: `${filePath}:0`,
      filePath,
      module: modulePath,
      lineStart: 1,
      lineEnd: totalLines,
      tokenCount: Math.max(1, estimateFallbackTokens(content)),
      content,
      fileHash,
    })
  }
  return out
}

function parentDir(path: string): string {
  const norm = path.replace(/\\/g, "/")
  const segments = norm.split("/").filter(Boolean)
  if (segments.length <= 1) return ""
  return segments.slice(0, -1).join("/")
}

function lineNumberAt(text: string, charOffset: number): number {
  if (charOffset <= 0) return 1
  let line = 1
  for (let i = 0; i < charOffset && i < text.length; i++) {
    if (text[i] === "\n") line++
  }
  return line
}

function pickFileHashes(
  filePaths: readonly string[],
  allHashes: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const path of filePaths) {
    if (allHashes[path] !== undefined) out[path] = allHashes[path]
  }
  return out
}

async function collectExistingArticleStubsForScope(
  scope: WikiScope
): Promise<{ slug: string; module: string; summary: string; pageRank: number }[]> {
  // Lazy import to avoid a circular dep with the schema/test reset paths.
  const { listWikiArticlesByScope } = await import("@/lib/db/wiki-articles")
  const rows = await listWikiArticlesByScope(scope)
  return rows.map((r) => ({
    slug: r.slug,
    module: r.module,
    summary: r.summary,
    pageRank: r.pageRank,
  }))
}

async function persistDrafts(
  drafts: readonly ModuleArticleDraft[],
  scope: WikiScope,
  generatorVersion: string,
  embed: EmbedFn,
  stats: readonly ModuleStat[]
): Promise<WikiArticle[]> {
  if (drafts.length === 0) return []
  const statByModule = new Map(stats.map((s) => [s.module, s]))

  // Remove any existing article for the slugs we're about to write — the
  // `wikiArticles.&slug` unique index would otherwise reject the bulkAdd.
  // The cascade-delete also clears each article's sections so we don't
  // strand orphan rows.
  const { deleteWikiArticle, getWikiArticleBySlug } = await import("@/lib/db/wiki-articles")
  for (const draft of drafts) {
    const existing = await getWikiArticleBySlug(draft.slug)
    if (existing) await deleteWikiArticle(existing.id)
  }
  const articleDrafts: Parameters<typeof bulkCreateWikiArticles>[0] = []
  const sectionDraftsByArticleSlug = new Map<string, ModuleArticleDraft>()

  for (const draft of drafts) {
    const stat = statByModule.get(draft.module)
    const pageRank = stat?.pageRank ?? 0
    const embedding = await embed(draft.summary)
    articleDrafts.push({
      slug: draft.slug,
      title: draft.title,
      module: draft.module,
      scope,
      pageRank,
      summary: draft.summary,
      sectionIds: [],
      sourceRefs: dedupeSourceRefs(draft.sourceRefs),
      contentMd: draft.contentMd,
      embedding,
      generatorVersion,
      fileHashes: draft.fileHashes,
    })
    sectionDraftsByArticleSlug.set(draft.slug, draft)
  }

  const persistedArticles = await bulkCreateWikiArticles(articleDrafts)

  // Section persistence runs after articles so each section row has a real
  // articleId. We then patch each article's `sectionIds` field via a second
  // pass — costs 1 extra round-trip but keeps the schema strict.
  const sectionsToPersist: Parameters<typeof bulkCreateWikiSections>[0] = []
  for (const article of persistedArticles) {
    const draft = sectionDraftsByArticleSlug.get(article.slug)
    if (!draft) continue
    for (const section of draft.sections) {
      sectionsToPersist.push({
        articleId: article.id,
        sectionIndex: section.sectionIndex,
        headingPath: section.headingPath,
        bodyMd: section.bodyMd,
        sourceRefs: section.sourceRefs,
      })
    }
  }
  const persistedSections = await bulkCreateWikiSections(sectionsToPersist)

  // Patch the articles with their section ids in render order.
  const sectionsByArticle = new Map<string, string[]>()
  for (const section of persistedSections) {
    const list = sectionsByArticle.get(section.articleId)
    if (list) list.push(section.id)
    else sectionsByArticle.set(section.articleId, [section.id])
  }
  const { updateWikiArticle } = await import("@/lib/db/wiki-articles")
  const final: WikiArticle[] = []
  for (const article of persistedArticles) {
    const sectionIds = sectionsByArticle.get(article.id) ?? []
    const updated = await updateWikiArticle(article.id, { sectionIds })
    final.push(updated ?? { ...article, sectionIds })
  }
  return final
}

function dedupeSourceRefs(refs: readonly WikiSourceRef[]): WikiSourceRef[] {
  const seen = new Set<string>()
  const out: WikiSourceRef[] = []
  for (const r of refs) {
    const key = `${r.filePath}:${r.lineStart}-${r.lineEnd}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

export const __TESTING__ = {
  sliceFileToChunks,
  parentDir,
  lineNumberAt,
  pickFileHashes,
  dedupeSourceRefs,
  hashContent,
  DEFAULT_MODULE_TOKEN_BUDGET,
  DEFAULT_FILE_TOKEN_BUDGET_PER_CHUNK,
}
