/**
 * DeepResearch report layer — builds on DeepSearch.
 *
 * Pipeline (NVIDIA AI-Q / Jina DeepResearch shape):
 *   1. Scout    — a quick landscape search over the topic.
 *   2. Architect— an evidence-grounded outline (title + section questions).
 *   3. Sections — run the DeepSearch loop per section, in parallel (bounded).
 *   4. Coherence— merge section findings into one report (unify terminology,
 *                 transitions) and append a deduplicated Sources list.
 */
import type { AiBridge } from "../lib/ai"
import { completeJson, completeText } from "../lib/ai"
import { extractJson } from "../lib/json"
import type {
  Citation,
  DeepResearchResult,
  DeepSearchConfig,
  EngineDeps,
  ResearchOutline,
  SectionResult,
} from "../types"
import { runDeepSearch } from "./deepsearch"
import { coherenceMessages, outlineMessages } from "./prompts"

const SCOUT_RESULTS = 8
const SECTION_CONCURRENCY = 3

const SECTION_CONFIG: Partial<DeepSearchConfig> = {
  maxSteps: 10,
  tokenBudget: 60_000,
  readTopK: 3,
}

export async function runDeepResearch(
  topic: string,
  deps: EngineDeps,
  configOverride: Partial<DeepSearchConfig> = {}
): Promise<DeepResearchResult> {
  let tokens = 0
  deps.reportProgress?.(0.02, "🛰️ Scoping the landscape…")

  const landscape = await scout(topic, deps)
  const { outline, tokens: outlineTokens } = await architect(topic, landscape, deps)
  tokens += outlineTokens

  const sectionDeps: EngineDeps = { ...deps, reportProgress: undefined }
  const sectionConfig: Partial<DeepSearchConfig> = {
    ...SECTION_CONFIG,
    readTopK: configOverride.readTopK ?? SECTION_CONFIG.readTopK,
    searchResultsPerQuery: configOverride.searchResultsPerQuery,
    locale: configOverride.locale,
  }

  let done = 0
  const sections = await mapLimit(outline.sections, SECTION_CONCURRENCY, async (section) => {
    const result = await runDeepSearch(section.question, sectionDeps, sectionConfig)
    tokens += result.usage.totalTokens
    done += 1
    deps.reportProgress?.(
      0.1 + 0.8 * (done / Math.max(1, outline.sections.length)),
      `📝 Section ${done}/${outline.sections.length}: ${section.heading}`
    )
    return {
      heading: section.heading,
      question: section.question,
      answer: result.answer,
      citations: result.citations,
      gaveUp: result.gaveUp,
    } satisfies SectionResult
  })

  deps.reportProgress?.(0.95, "🧵 Weaving the report together…")
  const citations = dedupeCitations(sections.flatMap((s) => s.citations))
  const { report, tokens: reportTokens } = await weave(topic, outline, sections, citations, deps)
  tokens += reportTokens

  deps.reportProgress?.(1, "Done")
  return {
    topic,
    title: outline.title,
    report,
    outline,
    sections,
    citations,
    usage: { totalTokens: tokens },
  }
}

async function scout(topic: string, deps: EngineDeps): Promise<string> {
  try {
    const hits = await deps.search(topic, SCOUT_RESULTS)
    return hits.map((h) => `- ${h.title}: ${h.content.slice(0, 150)}`).join("\n")
  } catch (err) {
    deps.logger?.warn("scout search failed", err)
    return ""
  }
}

async function architect(
  topic: string,
  landscape: string,
  deps: EngineDeps
): Promise<{ outline: ResearchOutline; tokens: number }> {
  try {
    const res = await completeJson<{ title?: unknown; sections?: unknown }>(
      deps.ai,
      outlineMessages(topic, landscape),
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
  deps: EngineDeps
): Promise<{ report: string; tokens: number }> {
  const blocks = sections.map((s) => `## ${s.heading}\n${s.answer}`).join("\n\n")
  let prose = ""
  let tokens = 0
  try {
    const res = await completeText(deps.ai, coherenceMessages(topic, outline.title, blocks), {
      temperature: 0.4,
      maxTokens: 4_000,
    })
    prose = res.text.trim()
    tokens = res.tokens
  } catch (err) {
    deps.logger?.warn("coherence pass failed; concatenating sections", err)
    prose = `# ${outline.title}\n\n${blocks}`
  }
  // Always append a deterministic, deduplicated Sources list so URLs are
  // correct regardless of how the model renumbered inline markers.
  return { report: `${prose}\n\n${renderSourcesList(citations)}`.trim(), tokens }
}

function renderSourcesList(citations: Citation[]): string {
  if (citations.length === 0) return ""
  const items = citations.map((c, i) => `${i + 1}. [${c.title || c.url}](${c.url})`)
  return `## Sources\n${items.join("\n")}`
}

export function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>()
  const out: Citation[] = []
  for (const c of citations) {
    if (seen.has(c.url)) continue
    seen.add(c.url)
    out.push(c)
  }
  return out
}

/** Run `fn` over `items` with at most `limit` in flight; preserves order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, () => worker()))
  return results
}
