/**
 * AI bridge — a thin, decoupled interface over the host's chat/embed model.
 *
 * The shapes intentionally match the host's `PluginAIProviderAPI`
 * (`ctx.ai.chat` / `ctx.ai.embed`) structurally, so the plugin glue can pass
 * `ctx.ai` straight in without importing `@/types/plugin` here. Keeping the
 * interface local means the engine + its tests depend on nothing external.
 */

export interface AiMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface AiOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

export interface AiChunk {
  content: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

export interface AiBridge {
  chat: (messages: AiMessage[], options?: AiOptions) => AsyncIterable<AiChunk>
  embed: (texts: string[]) => Promise<number[][]>
}

export interface CompletionResult {
  text: string
  /** Best-effort cumulative token count for this call (0 when unreported). */
  tokens: number
}

/**
 * Drive `ai.chat` to completion: concatenate every chunk's `content` and take
 * the largest reported cumulative `totalTokens` (providers usually send the
 * running total on the final chunk; fall back to summing completion deltas).
 */
export async function completeText(
  ai: AiBridge,
  messages: AiMessage[],
  options?: AiOptions
): Promise<CompletionResult> {
  let text = ""
  let maxTotal = 0
  let summedCompletion = 0
  let lastPrompt = 0

  for await (const chunk of ai.chat(messages, options)) {
    if (chunk.content) text += chunk.content
    const u = chunk.usage
    if (u) {
      if (typeof u.totalTokens === "number") maxTotal = Math.max(maxTotal, u.totalTokens)
      if (typeof u.completionTokens === "number") summedCompletion += u.completionTokens
      if (typeof u.promptTokens === "number") lastPrompt = u.promptTokens
    }
  }

  const tokens = maxTotal > 0 ? maxTotal : lastPrompt + summedCompletion
  return { text, tokens }
}

export interface JsonCompletionResult<T> extends CompletionResult {
  value: T
}

/**
 * Like `completeText` but parses the response as JSON via the caller-supplied
 * `parse` (so the engine can use its tolerant `extractJson` without this
 * module importing it — avoids a cycle and keeps `ai.ts` parse-agnostic).
 */
export async function completeJson<T>(
  ai: AiBridge,
  messages: AiMessage[],
  parse: (text: string) => T,
  options?: AiOptions
): Promise<JsonCompletionResult<T>> {
  const { text, tokens } = await completeText(ai, messages, options)
  return { value: parse(text), text, tokens }
}
