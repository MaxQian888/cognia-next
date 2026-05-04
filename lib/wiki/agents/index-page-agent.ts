/**
 * IndexPageAgent — single LLM call that produces the top-level `wiki/index.md`.
 *
 * Inputs are article summaries (slug + module + summary + pageRank); output
 * is one Markdown page that groups related modules under H2 headings and
 * uses `[[slug]]` link syntax. The orchestrator validates the output's
 * referenced slugs against the actual article set so the index can never
 * link to a slug that doesn't exist.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { findDeadLinks } from "./cross-ref-agent"
import { indexPagePrompt, WIKI_SYSTEM_VOICE } from "../prompts"
import type { IndexPageDraft } from "../types"

const MAX_OUTPUT_TOKENS = 1500

export interface IndexPageAgentDeps {
  llm: LlmClient
}

export interface ArticleSummary {
  slug: string
  module: string
  summary: string
  pageRank: number
}

export async function runIndexPageAgent(
  deps: IndexPageAgentDeps,
  articles: readonly ArticleSummary[]
): Promise<IndexPageDraft> {
  // Order by pageRank descending so the model writes "most important first".
  const ordered = [...articles].sort((a, b) => b.pageRank - a.pageRank)

  const prompt = indexPagePrompt({ articles: ordered })
  const responseMd = await deps.llm.complete(prompt, {
    system: WIKI_SYSTEM_VOICE,
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
  })

  return assembleIndexPage(ordered, responseMd)
}

/**
 * Pull a clean draft out of the LLM response and gather every `[[slug]]`
 * the model emitted. Exposed for tests so the markdown parsing can be
 * exercised without a real LlmClient.
 */
export function assembleIndexPage(
  articles: readonly ArticleSummary[],
  responseMd: string
): IndexPageDraft {
  const cleaned = stripFencedBody(responseMd).trim()
  const knownSlugs = articles.map((a) => a.slug)
  const dead = findDeadLinks(cleaned, knownSlugs)
  if (dead.length > 0) {
    // Soft-fail: leave the body alone but throw so the orchestrator can
    // decide whether to retry the call or persist the page anyway. The
    // orchestrator catches and logs; we don't suppress here so the
    // failure surfaces in tests.
    throw new Error(`IndexPageAgent emitted unresolved slugs: ${dead.join(", ")}`)
  }
  const referencedSlugs = collectReferencedSlugs(cleaned)
  return { contentMd: cleaned, referencedSlugs }
}

function stripFencedBody(text: string): string {
  const fence = text.trim().match(/^```(?:markdown|md)?\s*([\s\S]+?)\s*```$/i)
  return fence ? fence[1] : text
}

function collectReferencedSlugs(body: string): string[] {
  const out = new Set<string>()
  const re = /\[\[([\w-]+)\]\]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) out.add(match[1])
  return Array.from(out).sort()
}

export const __TESTING__ = { stripFencedBody, collectReferencedSlugs, MAX_OUTPUT_TOKENS }
