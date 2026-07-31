/**
 * Knowledge-RAG stub.
 *
 * Cognia injects a project-context block into agent system prompts via
 * a knowledge-RAG layer. cognia-next has no Project model yet — this
 * file ships the *signature* expected by the instruction stack but
 * always returns an empty `systemPrompt`. Replace later if/when a
 * real RAG layer is added.
 */

import type { Project } from "./types"

export interface KnowledgeChunk {
  id: string
  content: string
  source?: string
  score?: number
}

export interface KnowledgeRagOptions {
  query: string
  topK?: number
}

export async function retrieveKnowledge(_options: KnowledgeRagOptions): Promise<KnowledgeChunk[]> {
  return []
}

export const knowledgeRag = {
  retrieve: retrieveKnowledge,
}

/**
 * Stub for `searchKnowledgeBaseAdvanced` — Cognia's RAG-aware search entry.
 * cognia-next will replace this when the twin RAG runtime is wired up; for
 * now it returns an empty result so the ported parity test in
 * `lib/ai/rag/rag-consumption-parity.test.ts` typechecks. The test itself
 * is gated behind `describe.skip` because cognia-next has a different RAG
 * architecture (see Phase 2 plan).
 */
export interface AdvancedSearchOptions {
  query: string
  topK?: number
  filter?: Record<string, unknown>
}

export interface AdvancedSearchResult {
  chunks: KnowledgeChunk[]
  total: number
}

export async function searchKnowledgeBaseAdvanced(
  _options: AdvancedSearchOptions
): Promise<AdvancedSearchResult> {
  return { chunks: [], total: 0 }
}

export interface BuildProjectContextOptions {
  maxContextLength?: number
  useRelevanceFiltering?: boolean
}

export interface ProjectContextResult {
  systemPrompt: string
  chunks: KnowledgeChunk[]
}

/**
 * Build a project-aware context block for the agent's system prompt.
 * Returns an empty block today; signature matches Cognia's so the
 * external-agent-instruction-stack works unchanged.
 */
export function buildProjectContext(
  _project: Project | undefined,
  _userQuery: string | undefined,
  _options?: BuildProjectContextOptions
): ProjectContextResult {
  return { systemPrompt: "", chunks: [] }
}
