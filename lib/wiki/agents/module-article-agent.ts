/**
 * ModuleArticleAgent — LLM-driven, one call per module.
 *
 * Inputs come from the orchestrator: a `ModuleStat` (file list + line
 * counts) plus the chunks selected within the module's token budget.
 * Output is a `ModuleArticleDraft` ready to be split into sections and
 * persisted into `wikiArticles` / `wikiSections`.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { moduleToSlug } from "../file-walker"
import { moduleArticlePrompt, WIKI_SYSTEM_VOICE } from "../prompts"
import type { CodeChunk, ModuleArticleDraft, ModuleSectionDraft, ModuleStat } from "../types"
import type { WikiSourceRef } from "@/types/wiki"

const MAX_OUTPUT_TOKENS = 2048

export interface ModuleArticleAgentDeps {
  llm: LlmClient
}

export interface RunModuleArticleInput {
  stat: ModuleStat
  chunks: readonly CodeChunk[]
  /** Pass-through to `wikiArticles.fileHashes`. */
  fileHashes: Record<string, string>
}

/**
 * Drive one LLM call to produce the article body, then parse/structure
 * the response into `sections[]`.
 */
export async function runModuleArticleAgent(
  deps: ModuleArticleAgentDeps,
  input: RunModuleArticleInput
): Promise<ModuleArticleDraft> {
  const prompt = moduleArticlePrompt({
    module: input.stat.module,
    stat: input.stat,
    chunks: input.chunks,
  })

  const responseMd = await deps.llm.complete(prompt, {
    system: WIKI_SYSTEM_VOICE,
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
  })

  return assembleArticle(input.stat, input.chunks, input.fileHashes, responseMd)
}

/**
 * Assemble a draft from a raw LLM response. Exposed separately so tests can
 * inject a canned markdown body without spinning a fake LlmClient.
 */
export function assembleArticle(
  stat: ModuleStat,
  chunks: readonly CodeChunk[],
  fileHashes: Record<string, string>,
  responseMd: string
): ModuleArticleDraft {
  const cleaned = stripFencedBody(responseMd).trim()
  const slug = moduleToSlug(stat.module)
  const title = extractTitle(cleaned, stat.module)
  const summary = extractSummary(cleaned)
  const sections = splitIntoSections(cleaned)
  const sourceRefs = unionSourceRefs(chunks)

  // Re-emit the canonical body so the persisted contentMd is normalized:
  // H1 + summary line + sections in order. This guards against agent drift.
  const contentMd = renderArticleBody(title, summary, sections)

  return {
    module: stat.module,
    slug,
    title,
    summary,
    sections,
    sourceRefs,
    contentMd,
    fileHashes,
  }
}

/** Strip an outer ```markdown fence the model occasionally wraps the body in. */
function stripFencedBody(text: string): string {
  const fence = text.trim().match(/^```(?:markdown|md)?\s*([\s\S]+?)\s*```$/i)
  return fence ? fence[1] : text
}

function extractTitle(body: string, fallbackModule: string): string {
  const match = body.match(/^#\s+(.+?)\s*$/m)
  if (match) return match[1].trim()
  return `${fallbackModule} — module overview`
}

function extractSummary(body: string): string {
  // First non-heading paragraph after the H1.
  const lines = body.split(/\r?\n/)
  let pastH1 = false
  const out: string[] = []
  for (const line of lines) {
    if (!pastH1) {
      if (/^#\s+/.test(line)) pastH1 = true
      continue
    }
    if (/^#{1,6}\s+/.test(line)) break // hit next heading
    if (line.trim() === "" && out.length === 0) continue // skip blank between H1 and summary
    if (line.trim() === "") {
      if (out.length > 0) break // end of summary paragraph
      continue
    }
    out.push(line.trim())
  }
  const summary = out.join(" ").trim()
  return summary.length > 0 ? summary : "Module summary unavailable."
}

/**
 * Split body into sections at H2 boundaries. Each section gets a synthetic
 * `sectionIndex` matching render order; `headingPath` is the H2 slug split
 * by " > " for sub-headings (a flat list at v1).
 */
function splitIntoSections(body: string): ModuleSectionDraft[] {
  const lines = body.split(/\r?\n/)
  const sections: ModuleSectionDraft[] = []
  let current: { heading: string; bodyLines: string[] } | undefined

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/)
    if (h2) {
      if (current) {
        sections.push(toSection(sections.length, current))
      }
      current = { heading: h2[1].trim(), bodyLines: [] }
      continue
    }
    if (current) current.bodyLines.push(line)
  }
  if (current) sections.push(toSection(sections.length, current))

  return sections
}

function toSection(
  index: number,
  raw: { heading: string; bodyLines: string[] }
): ModuleSectionDraft {
  return {
    sectionIndex: index,
    headingPath: [raw.heading],
    bodyMd: raw.bodyLines.join("\n").trim(),
    sourceRefs: [],
  }
}

function unionSourceRefs(chunks: readonly CodeChunk[]): WikiSourceRef[] {
  return chunks.map((c) => ({
    filePath: c.filePath,
    lineStart: c.lineStart,
    lineEnd: c.lineEnd,
    sha: c.fileHash,
  }))
}

function renderArticleBody(
  title: string,
  summary: string,
  sections: readonly ModuleSectionDraft[]
): string {
  const lines: string[] = []
  lines.push(`# ${title}`)
  lines.push("")
  lines.push(summary)
  for (const section of sections) {
    lines.push("")
    lines.push(`## ${section.headingPath[0]}`)
    if (section.bodyMd.length > 0) {
      lines.push("")
      lines.push(section.bodyMd)
    }
  }
  return lines.join("\n")
}

export const __TESTING__ = {
  stripFencedBody,
  extractTitle,
  extractSummary,
  splitIntoSections,
  renderArticleBody,
  MAX_OUTPUT_TOKENS,
}
