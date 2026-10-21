/**
 * A narrow bridge over the host model (`ctx.ai.chat`) and a tolerant reader
 * for the JSON object each call is asked to answer with.
 *
 * The engine depends on this interface, not on the plugin context, so every
 * engine test injects a fake. Models wrap JSON in fences or prose now and
 * then; the reader takes the first balanced object and never evaluates
 * anything.
 */

export interface LlmMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface LlmBridge {
  /** Complete one request and return the whole text. */
  complete(messages: LlmMessage[], options?: { signal?: AbortSignal }): Promise<string>
}

export interface LlmChatSource {
  chat(
    messages: LlmMessage[],
    options?: { model?: string; temperature?: number; signal?: AbortSignal }
  ): AsyncIterable<{ content: string }>
}

export function createLlmBridge(source: LlmChatSource, model?: string): LlmBridge {
  return {
    async complete(messages, options = {}) {
      let text = ""
      for await (const chunk of source.chat(messages, {
        ...(model ? { model } : {}),
        temperature: 0,
        ...(options.signal ? { signal: options.signal } : {}),
      })) {
        if (chunk.content) text += chunk.content
      }
      return text
    },
  }
}

/** A model answered without the JSON object it was asked for. */
export class UnparseableAnswerError extends Error {
  readonly code = "governance_unparseable"
  constructor(what: string) {
    super(`${what} did not return a JSON object`)
    this.name = "UnparseableAnswerError"
  }
}

/** The first balanced `{…}` in `text`, parsed; `undefined` when there is none. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{")
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) {
        try {
          const value: unknown = JSON.parse(text.slice(start, index + 1))
          return value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

export function asInteger(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value
  return typeof number === "number" && Number.isInteger(number) ? number : undefined
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
