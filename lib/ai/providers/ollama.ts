/**
 * Stub for the Ollama embedding provider.
 *
 * Cognia references this path but does not actually ship `embedding/providers/`
 * — `lib/ai/embedding/embedding.ts` imports `generateOllamaEmbedding` from
 * here as a side-channel for users who run a local Ollama daemon.
 * cognia-next's twin pipeline targets cloud providers in v1, so this stub
 * surfaces a clear error if anyone tries to use the Ollama branch.
 */

export async function generateOllamaEmbedding(
  baseURL: string,
  _modelId: string,
  _text: string
): Promise<number[]> {
  throw new Error(
    `Ollama embedding provider is not configured in cognia-next. ` +
      `Set up a cloud embedding provider (OpenAI/Voyage/Cohere) or ` +
      `port the Ollama runtime. (Tried baseURL=${baseURL})`
  )
}
