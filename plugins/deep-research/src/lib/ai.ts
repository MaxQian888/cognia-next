/**
 * AI bridge — a thin, decoupled interface over the host's chat/embed model.
 *
 * The shapes intentionally match `ctx.ai.chat` / `ctx.ai.embed` structurally,
 * so the runtime adapter can bind the host API straight in. Keeping the
 * interface local is what lets the engine and its tests depend on nothing but
 * a plain object — every engine test injects a fake bridge, no host in sight.
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

/** Per-call routing shared by both methods; see {@link bindAiBridge}. */
export interface AiCallContext {
  /** Session the call belongs to — the host resolves credentials from it. */
  sessionId?: string
  /** Cancellation signal for the underlying provider request. */
  signal?: AbortSignal
}

export interface AiBridge {
  chat: (messages: AiMessage[], options?: AiOptions & AiCallContext) => AsyncIterable<AiChunk>
  embed: (texts: string[], options?: AiCallContext) => Promise<number[][]>
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

/**
 * Bind the host's model API to the engine's bridge for one run.
 *
 * Every call carries the run's `sessionId`. That is not decoration: the host
 * resolves WHICH provider, key and usage account answers from it, and on hosts
 * that serve several sessions in one process (the CLI) a call without it has no
 * credentials at all. Passing it here is what makes `/research` in one session
 * bill that session.
 */
export function bindAiBridge(
  ai: AiBridge,
  context: { sessionId?: string; signal?: AbortSignal } = {}
): AiBridge {
  const routing = {
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  }
  return {
    chat: (messages, options) => ai.chat(messages, { ...options, ...routing }),
    embed: (texts) => ai.embed(texts, routing),
  }
}
