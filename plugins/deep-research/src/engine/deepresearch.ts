/**
 * DeepResearch report layer — builds on DeepSearch.
 *
 * Pipeline (NVIDIA AI-Q / Jina DeepResearch shape):
 *   1. Scout    — a quick landscape search over the topic.
 *   2. Architect— an evidence-grounded outline (title + section questions).
 *   3. Sections — run the DeepSearch loop per section, in parallel (bounded).
 *   4. Coherence— merge section findings into one report (unify terminology,
 *                 transitions) and append a deduplicated Sources list.
 *
 * Citations: each section's DeepSearch loop numbers its own sources 1..k, so a
 * naive merge makes `[1]` mean a different page per section. Before weaving,
 * every section's markers are remapped onto ONE global index — the same index
 * the appended Sources list uses — so inline markers resolve correctly in the
 * final report.
 */
import { completeJson, completeText } from "../lib/ai"
import { extractJson } from "../lib/json"
import { normalizeUrl } from "../lib/url"
import type {
  Citation,
  DeepResearchResult,
  DeepSearchConfig,
  EngineDeps,
  ResearchOutline,
  SectionResult,
} from "../types"
import { runDeepSearch } from "./deepsearch"
import { engineText, reportEngineProgress } from "./progress"
import { coherenceMessages, outlineMessages } from "./prompts"

const SCOUT_RESULTS = 8
const SECTION_CONCURRENCY = 3
const SECTION_TOKEN_BUDGET = 60_000

const SECTION_CONFIG: Partial<DeepSearchConfig> = {
  maxSteps: 10,
  tokenBudget: SECTION_TOKEN_BUDGET,
  readTopK: 3,
}

export async function runDeepResearch(
  topic: string,
  deps: EngineDeps,
  configOverride: Partial<DeepSearchConfig> = {}
): Promise<DeepResearchResult> {
  let tokens = 0
  reportEngineProgress(deps, 0.02, "progress.scoping")
  const emptyOutline: ResearchOutline = {
    title: topic,
    sections: [{ heading: topic, question: topic }],
  }
  if (deps.signal?.aborted) return cancelledReport(topic, emptyOutline, tokens, deps)

  const landscape = await scout(topic, deps, configOverride.searchResultsPerQuery)
  const { outline, tokens: outlineTokens } = await architect(
    topic,
    landscape,
    deps,
    configOverride.locale
  )
  tokens += outlineTokens
  if (deps.signal?.aborted) return cancelledReport(topic, outline, tokens, deps)

  // Sections must not report their own progress — the outer loop owns the bar.
  // OMIT the key; setting it to `undefined` is what `exactOptionalPropertyTypes`
  // rejects, and it is not equivalent (see the config note below).
  const { reportProgress: _sectionProgress, ...sectionDeps } = deps
  const sectionConfig: Partial<DeepSearchConfig> = {
    ...SECTION_CONFIG,
    // Same rule, and here a present-but-undefined key was a live bug rather
    // than a style nit: `runDeepSearch` merges `{ ...DEFAULT_CONFIG, ...override }`,
    // so passing `searchResultsPerQuery: undefined` CLOBBERED the default and
    // every section search asked for `undefined` results instead of 6.
    // Spreading SECTION_CONFIG first already supplies its own `readTopK`.
    ...(configOverride.maxSteps !== undefined ? { maxSteps: configOverride.maxSteps } : {}),
    ...(configOverride.maxBadAttempts !== undefined
      ? { maxBadAttempts: configOverride.maxBadAttempts }
      : {}),
    ...(configOverride.readTopK !== undefined ? { readTopK: configOverride.readTopK } : {}),
    ...(configOverride.searchResultsPerQuery !== undefined
      ? { searchResultsPerQuery: configOverride.searchResultsPerQuery }
      : {}),
    ...(configOverride.locale !== undefined ? { locale: configOverride.locale } : {}),
  }

  // Run-level token cap: when the caller supplies one (explicit config or a
  // depth preset) it bounds the WHOLE report, not each section; otherwise the
  // plan itself is the budget. `shouldStop` also freezes scheduling on abort.
  const runCap = configOverride.tokenBudget ?? SECTION_TOKEN_BUDGET * outline.sections.length
  const shouldStop = () => deps.signal?.aborted === true || tokens >= runCap

  let done = 0
  const settled = await mapLimit(
    outline.sections,
    SECTION_CONCURRENCY,
    async (section): Promise<SectionResult> => {
      const result = await runDeepSearch(section.question, sectionDeps, sectionConfig)
      tokens += result.usage.totalTokens
      done += 1
      reportEngineProgress(
        deps,
        0.1 + 0.8 * (done / Math.max(1, outline.sections.length)),
        "progress.section",
        { done, total: outline.sections.length, heading: section.heading }
      )
      return {
        heading: section.heading,
        question: section.question,
        answer: result.answer,
        citations: result.citations,
        gaveUp: result.gaveUp,
        ...(result.aborted ? { aborted: true } : {}),
        steps: result.steps.length,
      }
    },
    { shouldStop }
  )
  const sections = settled.filter((s): s is SectionResult => s !== undefined)
  // A cancelled section's stub answer must not reach the report; its citations
  // are kept below only if a real section happened to share the URL anyway.
  const usable = sections.filter((s) => !s.aborted)

  reportEngineProgress(deps, 0.95, "progress.weaving")
  const citations = dedupeCitations(usable.flatMap((s) => s.citations))
  const globalIndex = new Map(citations.map((c, i) => [normalizeUrl(c.url), i + 1]))
  for (const section of usable) {
    section.answer = renumberMarkers(section.answer, section.citations, globalIndex)
  }

  // The coherence pass is another model call — skip it when the run was cut
  // short or the budget is already spent; the concatenated sections still make
  // a correct report, just less polished.
  const skipCoherence = deps.signal?.aborted === true || tokens >= runCap
  const { report, tokens: reportTokens } = await weave(
    topic,
    outline,
    usable,
    citations,
    deps,
    configOverride.locale,
    skipCoherence
  )
  tokens += reportTokens

  reportEngineProgress(deps, 1, "progress.done")
  return {
    topic,
    title: outline.title,
    report,
    outline,
    sections,
    citations,
    usage: { totalTokens: tokens },
    gaveUp:
      deps.signal?.aborted === true ||
      sections.length < outline.sections.length ||
      sections.some((s) => s.gaveUp || s.aborted),
  }
}

/**
 * Rewrite a section answer's `[n]` markers from its LOCAL citation list onto
 * the report's global source index. Section citations are contiguous 1..k
 * (the DeepSearch loop renumbers on the way out), so any marker within range
 * is a real citation; out-of-range brackets (years, footnotes) are left alone.
 */
export function renumberMarkers(
  answer: string,
  local: Citation[],
  globalIndex: Map<string, number>
): string {
  return answer.replace(/\[(\d+)\]/g, (match, digits: string) => {
    const cited = local[Number(digits) - 1]
    if (!cited) return match
    const global = globalIndex.get(normalizeUrl(cited.url))
    return global === undefined ? match : `[${global}]`
  })
}

async function scout(topic: string, deps: EngineDeps, searchWidth?: number): Promise<string> {
  try {
    const hits = await deps.search(topic, searchWidth ?? SCOUT_RESULTS)
    return hits.map((h) => `- ${h.title}: ${h.content.slice(0, 150)}`).join("\n")
  } catch (err) {
    deps.logger?.warn("scout search failed", err)
    return ""
  }
}

async function architect(
  topic: string,
  landscape: string,
  deps: EngineDeps,
  locale?: string
): Promise<{ outline: ResearchOutline; tokens: number }> {
  try {
    const res = await completeJson<{ title?: unknown; sections?: unknown }>(
      deps.ai,
      outlineMessages(topic, landscape, locale),
      (t) => extractJson(t),
      { temperature: 0.3, maxTokens: 900 }
    )
    return { outline: normalizeOutline(topic, res.value), tokens: res.tokens }
  } catch (err) {
    deps.logger?.warn("outline generation failed; using single-section fallback", err)
    return { outline: { title: topic, sections: [{ heading: topic, question: topic }] }, tokens: 0 }
  }
}

export function normalizeOutline(
  topic: string,
  raw: { title?: unknown; sections?: unknown }
): ResearchOutline {
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : topic
  const sections = Array.isArray(raw.sections)
    ? raw.sections
        .map((s) => s as Record<string, unknown>)
        .filter((s) => typeof s.question === "string" && (s.question as string).trim())
        .map((s) => ({
          heading:
            typeof s.heading === "string" && s.heading.trim()
              ? (s.heading as string).trim()
              : (s.question as string).trim(),
          question: (s.question as string).trim(),
        }))
    : []
  return { title, sections: sections.length > 0 ? sections : [{ heading: topic, question: topic }] }
}

async function weave(
  topic: string,
  outline: ResearchOutline,
  sections: SectionResult[],
  citations: Citation[],
  deps: EngineDeps,
  locale: string | undefined,
  skipCoherence: boolean
): Promise<{ report: string; tokens: number }> {
  const blocks = sections.map((s) => `## ${s.heading}\n${s.answer}`).join("\n\n")
  let prose = ""
  let tokens = 0
  if (skipCoherence) {
    prose = sections.length > 0 ? `# ${outline.title}\n\n${blocks}` : `# ${outline.title}`
  } else {
    try {
      const res = await completeText(
        deps.ai,
        coherenceMessages(topic, outline.title, blocks, locale),
        {
          temperature: 0.4,
          maxTokens: 4_000,
        }
      )
      prose = res.text.trim()
      tokens = res.tokens
    } catch (err) {
      deps.logger?.warn("coherence pass failed; concatenating sections", err)
      prose = `# ${outline.title}\n\n${blocks}`
    }
  }
  // Always append a deterministic, deduplicated Sources list so URLs are
  // correct regardless of how the model renumbered inline markers.
  return { report: `${prose}\n\n${renderSourcesList(citations)}`.trim(), tokens }
}

function cancelledReport(
  topic: string,
  outline: ResearchOutline,
  tokens: number,
  deps: EngineDeps
): DeepResearchResult {
  reportEngineProgress(deps, 1, "progress.cancelled")
  return {
    topic,
    title: outline.title,
    report: `# ${outline.title}\n\n_${engineText(deps, "report.cancelledEmpty")}_`,
    outline,
    sections: [],
    citations: [],
    usage: { totalTokens: tokens },
    gaveUp: true,
  }
}

function renderSourcesList(citations: Citation[]): string {
  if (citations.length === 0) return ""
  const items = citations.map((c, i) => {
    const date = c.publishedDate?.trim()
    return `${i + 1}. [${c.title || c.url}](${c.url})${date ? ` (${date.slice(0, 24)})` : ""}`
  })
  return `## Sources\n${items.join("\n")}`
}

export function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>()
  const out: Citation[] = []
  for (const c of citations) {
    // Canonicalised key: `?utm_*` / fragment / casing variants of one page are
    // one source, not several rows in the list.
    const key = normalizeUrl(c.url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

/**
 * Run `fn` over `items` with at most `limit` in flight; preserves order.
 * Sparse return: entries never started (because `shouldStop` fired or a
 * sibling failed) stay `undefined`. The first failure is rethrown after the
 * in-flight work settles — previously a rejection raced out through
 * `Promise.all` while the remaining workers kept launching new items and
 * burning model calls nobody awaited.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options: { shouldStop?: () => boolean } = {}
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length)
  let next = 0
  let firstError: unknown
  let failed = false
  async function worker(): Promise<void> {
    while (true) {
      if (failed || options.shouldStop?.() === true) return
      const i = next++
      if (i >= items.length) return
      try {
        results[i] = await fn(items[i], i)
      } catch (err) {
        if (!failed) {
          failed = true
          firstError = err
        }
        return
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, () => worker()))
  if (failed) throw firstError
  return results
}
