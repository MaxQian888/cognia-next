// Composite context builder — the engine behind `codegraph_context` /
// `codegraph_explore`.
//
// Ported from codegraph's `findRelevantContext`:
//   1. extract candidate symbol names from the NL query
//   2. seed from exact name matches + FTS hits (named seeds boosted)
//   3. co-location boost when several query terms hit the same file
//   4. Random-Walk-with-Restart re-rank over the call/reference graph
//   5. assemble entry points + related subgraph + verbatim snippets + related
//      files + summary, all under the adaptive output budget (whole snippets
//      kept, never truncated mid-method; dropped list surfaced)

import { randomWalkWithRestart } from "./graph.mjs"
import { computeBudget, packSnippets } from "./budget.mjs"
import { splitIdentifier } from "./store-memory.mjs"

/**
 * Pull candidate symbol names out of a natural-language query: identifier-ish
 * tokens plus their camelCase/snake_case constituents, de-duplicated.
 * @param {string} query
 * @returns {string[]}
 */
export function extractSymbolsFromQuery(query) {
  if (typeof query !== "string") return []
  const out = new Set()
  for (const raw of query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (STOPWORDS.has(raw.toLowerCase())) continue
    out.add(raw)
    for (const piece of splitIdentifier(raw)) {
      if (piece.length >= 2 && !STOPWORDS.has(piece.toLowerCase())) out.add(piece)
    }
  }
  return [...out]
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "is",
  "are",
  "how",
  "does",
  "what",
  "where",
  "who",
  "why",
  "when",
  "find",
  "show",
  "me",
  "all",
  "for",
  "and",
  "or",
  "with",
  "this",
  "that",
  "it",
  "do",
  "i",
  "we",
  "function",
  "class",
  "method",
  "code",
])

/**
 * @param {object} store
 * @param {string} query
 * @param {{
 *   getSnippet?: (node: object) => string,
 *   fileCount?: number,
 *   maxNodes?: number,
 *   namedSeeds?: string[],
 * }} [opts]
 * @returns {{
 *   query: string,
 *   entryPoints: object[],
 *   related: { node: object, score: number }[],
 *   snippets: { id: string, file: string, qualified_name: string, text: string }[],
 *   relatedFiles: string[],
 *   dropped: object[],
 *   summary: string,
 * }}
 */
export function buildContext(store, query, opts = {}) {
  const { getSnippet, fileCount, maxNodes = 12, namedSeeds = [] } = opts
  const terms = extractSymbolsFromQuery(query)

  // 1. Exact-name seeds (highest confidence) + explicitly named seeds.
  /** @type {Map<string, number>} nodeId → base score */
  const base = new Map()
  const seedIds = new Set()
  const fileTermHits = new Map() // file → Set(term) for co-location boosting

  const addSeed = (node, score) => {
    if (!node || node.kind === "file") return
    base.set(node.id, Math.max(base.get(node.id) ?? 0, score))
    seedIds.add(node.id)
  }

  for (const name of namedSeeds) {
    for (const node of store.nodesByName(name)) addSeed(node, 120)
  }
  for (const term of terms) {
    for (const node of store.nodesByName(term)) {
      addSeed(node, 60)
      track(fileTermHits, node.file_path, term)
    }
  }

  // 2. FTS / inverted-index hits (lower confidence) widen the seed set.
  for (const node of store.searchNodes(query, { limit: 25 })) {
    if (node.kind === "file") continue
    base.set(node.id, Math.max(base.get(node.id) ?? 0, 20))
    seedIds.add(node.id)
    for (const term of terms) {
      if (matchesTerm(node, term)) track(fileTermHits, node.file_path, term)
    }
  }

  // 3. Co-location boost: a file where ≥2 distinct query terms resolved is
  // architecturally central to the query.
  for (const [id, score] of base) {
    const node = store.getNode(id)
    const hits = fileTermHits.get(node?.file_path)?.size ?? 0
    if (hits >= 2) base.set(id, score + 15 * (hits - 1))
  }

  // 4. RWR connectivity relevance from the seeds.
  const rwr = randomWalkWithRestart(store, [...seedIds])
  const rwrMax = Math.max(1e-9, ...rwr.values())

  // 5. Combine and rank.
  const combined = new Map()
  for (const [id, score] of base) combined.set(id, score)
  for (const [id, score] of rwr) {
    const node = store.getNode(id)
    if (!node || node.kind === "file") continue
    const norm = (score / rwrMax) * 40
    combined.set(id, (combined.get(id) ?? 0) + norm)
  }

  const ranked = [...combined.entries()]
    .map(([id, score]) => ({ node: store.getNode(id), score }))
    .filter((r) => r.node && r.node.kind !== "file")
    .sort((a, b) => b.score - a.score || a.node.qualified_name.localeCompare(b.node.qualified_name))

  const related = ranked.slice(0, maxNodes)
  const entryPoints = ranked
    .filter((r) => seedIds.has(r.node.id))
    .slice(0, 5)
    .map((r) => r.node)

  // 6. Snippets under the adaptive budget.
  const budget = computeBudget(fileCount ?? store.stats().fileCount)
  const candidateSnippets = related.map((r) => ({
    id: r.node.id,
    file: r.node.file_path,
    qualified_name: r.node.qualified_name,
    text: getSnippet ? getSnippet(r.node) : (r.node.signature ?? ""),
  }))
  const { kept, dropped } = packSnippets(candidateSnippets, budget)

  const relatedFiles = [...new Set(related.map((r) => r.node.file_path))]
  const summary = buildSummary(query, entryPoints, related, relatedFiles)

  return { query, entryPoints, related, snippets: kept, relatedFiles, dropped, summary }
}

function track(map, file, term) {
  if (!file) return
  let set = map.get(file)
  if (!set) {
    set = new Set()
    map.set(file, set)
  }
  set.add(term)
}

function matchesTerm(node, term) {
  const t = term.toLowerCase()
  return node.name.toLowerCase().includes(t) || node.qualified_name.toLowerCase().includes(t)
}

function buildSummary(query, entryPoints, related, relatedFiles) {
  if (related.length === 0) return `No indexed symbols matched "${query}".`
  const eps = entryPoints
    .map((n) => n.qualified_name)
    .slice(0, 3)
    .join(", ")
  return (
    `${related.length} relevant symbol(s) across ${relatedFiles.length} file(s)` +
    (eps ? `; entry points: ${eps}.` : ".")
  )
}
