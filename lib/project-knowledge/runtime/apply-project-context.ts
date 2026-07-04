/**
 * Project-knowledge read runtime — mirrors `lib/memory/runtime/apply-memory-context.ts`:
 * best-effort, dependency-injected, and **never throws**. Assembles a
 * system-prompt section from the active workspace's retrieved knowledge chunks.
 *
 * The section COEXISTS with (and is appended after) the Twin + Memory sections
 * by `resolveSendOptions` — project knowledge is retrieved factual context, not
 * a persona, so it never replaces the base system prompt.
 */

import {
  retrieveProjectChunks,
  type ProjectKnowledgeRuntimeDeps,
  type RetrievedProjectChunk,
} from "./retrieve"

export interface ApplyProjectKnowledgeContextInput {
  projectId: string
  userMessage: string
  topK: number
  precomputedQueryEmbedding?: number[]
  /** Map of `KnowledgeFile.id` → display name, for citations. */
  fileNames?: Record<string, string>
  deps: ProjectKnowledgeRuntimeDeps
}

export interface AppliedProjectChunk {
  fileId: string
  fileName?: string
  content: string
  score: number
}

export interface ApplyProjectKnowledgeContextResult {
  /** Section to append to the system prompt, or null when nothing to inject. */
  systemPromptSection: string | null
  retrievedChunks: AppliedProjectChunk[]
  degraded: boolean
}

const HEADING = "## Project knowledge base"
const PREAMBLE =
  "The following excerpts are retrieved from this workspace's knowledge files. " +
  "Use them when they are relevant to the user's request, and cite the source file by name."

const EMPTY: ApplyProjectKnowledgeContextResult = {
  systemPromptSection: null,
  retrievedChunks: [],
  degraded: false,
}

export async function applyProjectKnowledgeContext(
  input: ApplyProjectKnowledgeContextInput
): Promise<ApplyProjectKnowledgeContextResult> {
  const query = input.userMessage.trim()
  if (!query || input.topK <= 0) return EMPTY

  try {
    const result = await retrieveProjectChunks({
      projectId: input.projectId,
      userMessage: query,
      topK: input.topK,
      precomputedQueryEmbedding: input.precomputedQueryEmbedding,
      deps: input.deps,
    })

    const retrievedChunks: AppliedProjectChunk[] = result.chunks.map(
      (rc: RetrievedProjectChunk) => ({
        fileId: rc.chunk.fileId,
        fileName: input.fileNames?.[rc.chunk.fileId],
        content: rc.chunk.content,
        score: rc.score,
      })
    )

    if (retrievedChunks.length === 0) {
      return { systemPromptSection: null, retrievedChunks: [], degraded: result.degraded }
    }

    const body = retrievedChunks
      .map((c) => {
        const label = c.fileName ? `[${c.fileName}]` : `[file ${c.fileId}]`
        return `${label}\n${c.content}`
      })
      .join("\n\n")

    return {
      systemPromptSection: `${HEADING}\n${PREAMBLE}\n\n${body}`,
      retrievedChunks,
      degraded: result.degraded,
    }
  } catch {
    return { ...EMPTY, degraded: true }
  }
}
