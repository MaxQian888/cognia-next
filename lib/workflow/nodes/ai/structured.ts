/**
 * Structured-output helpers shared by the AI node executors
 * (`ai.prompt` v1/v2, `ai.extract` in built-ins.ts, and the v2 module).
 */

import { extractJson } from "@/lib/twin/distill/llm"

/**
 * Non-throwing JSON extraction from an LLM completion. Reuses the robust
 * `extractJson` (handles fenced blocks + leading/trailing prose) and converts
 * its throw into a `{ value, error }` result so node executors can surface a
 * `parseError` downstream instead of failing the whole run.
 */
export function parseStructured(completion: string): { value: unknown; error?: string } {
  try {
    return { value: extractJson<unknown>(completion) }
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Build the JSON-only system instruction appended in `responseFormat: "json"`. */
export function buildJsonInstruction(schema?: string): string {
  const base = "Respond with ONLY a single valid JSON value — no prose, no markdown code fences."
  return schema && schema.trim() ? `${base}\nMatch this shape:\n${schema.trim()}` : base
}
