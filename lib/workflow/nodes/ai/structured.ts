/**
 * Structured-output helpers shared by the AI node executors
 * (`ai.prompt` v1/v2, `ai.extract` in built-ins.ts, and the v2 module).
 */

import { extractJson } from "@/lib/twin/distill/llm"
import { resolvePrompt } from "@/lib/prompts/resolve"
import { definePrompt } from "@/lib/prompts/types"

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

/**
 * The JSON-only reply contract appended in `responseFormat: "json"` (and to
 * an agent run with a JSON output format). Protocol text the parser depends
 * on: visible in the Prompt Center, never editable (ADR-0236).
 */
export const JSON_OUTPUT_PROMPT = definePrompt({
  id: "developer.workflow.json-output",
  contractVersion: 1,
  kind: "protocol",
  group: "developer",
  operation: "inspect-only",
  scopes: [],
  activation: "next-operation",
  risk: "protocol",
  hosts: ["app", "cli"],
  outputContract:
    "Appended to the system prompt of a JSON-mode ai.prompt node or JSON-format agent run; the reply is parsed with a fenced-block / surrounding-prose tolerant JSON extractor.",
  consumers: ["lib/workflow/nodes/ai/structured.ts"],
  defaultBody: "Respond with ONLY a single valid JSON value — no prose, no markdown code fences.",
})

/** The shape hint that follows {@link JSON_OUTPUT_PROMPT} when a schema is declared. */
export const JSON_OUTPUT_SHAPE_PROMPT = definePrompt({
  id: "developer.workflow.json-output.shape",
  contractVersion: 1,
  kind: "protocol",
  group: "developer",
  operation: "inspect-only",
  scopes: [],
  activation: "next-operation",
  risk: "protocol",
  hosts: ["app", "cli"],
  variables: [{ name: "schema", required: true, maxChars: 1_000_000 }],
  outputContract:
    "Follows the JSON-only line when the node declares a schema; {{schema}} is the node's JSON shape hint or its output schema, trimmed.",
  consumers: ["lib/workflow/nodes/ai/structured.ts"],
  defaultBody: "Match this shape:\n{{schema}}",
})

/** Build the JSON-only system instruction appended in `responseFormat: "json"`. */
export function buildJsonInstruction(schema?: string): string {
  const base = resolvePrompt(JSON_OUTPUT_PROMPT).text
  return schema && schema.trim()
    ? `${base}\n${resolvePrompt(JSON_OUTPUT_SHAPE_PROMPT, { values: { schema: schema.trim() } }).text}`
    : base
}
