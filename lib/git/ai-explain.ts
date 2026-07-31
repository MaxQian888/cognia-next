/**
 * Pure prompt assembly + one-shot generation for AI change explanation.
 *
 * Given a diff (a working-tree file, a staged file, or a commit's file), produce
 * a short natural-language summary of WHAT changed and WHY. Kept free of React,
 * stores, and Tauri (like `lib/git/ai-commit.ts`) so it is unit-testable with a
 * mock `{ complete }`; the caller (`useAiDiffExplain`) owns PII gating and model
 * resolution.
 */

import { clampDiff, stripFences } from "@/lib/git/ai-commit"
import type { LlmClient } from "@/lib/twin/distill/llm"

export interface DiffExplainConfig {
  /** Optional extra steering appended to the system prompt. */
  customInstructions?: string
}

export interface BuildExplainInput {
  /** Human label for the diff subject, e.g. a file path or `commit abc123`. */
  subject: string
  /** Unified diff text — already PII-gated / redacted by the caller. */
  diffText: string
  config: DiffExplainConfig
}

export function buildExplainSystemPrompt(config: DiffExplainConfig): string {
  const lines = [
    "You explain a Git diff to a developer reviewing the change.",
    "Write a brief, plain-language summary: first a one-sentence overview of WHAT changed, then 2–5 short bullet points covering the notable edits and, where inferable, WHY.",
    "Be concrete and grounded in the diff — never invent changes that are not present. Keep it under ~150 words. Output plain text (a short intro line then `- ` bullets), no markdown headings, no code fences.",
  ]
  const extra = config.customInstructions?.trim()
  if (extra) lines.push(`Additional instructions: ${extra}`)
  return lines.join("\n")
}

export function buildExplainUserPrompt(input: BuildExplainInput): string {
  return [
    `Subject: ${input.subject}`,
    "",
    "Diff:",
    "```diff",
    clampDiff(input.diffText),
    "```",
  ].join("\n")
}

/**
 * One-shot generation: assemble prompts, call the resolved utility LLM client,
 * return clean text (fences stripped). The client is injected so this stays
 * testable with a mock `{ complete }`.
 */
export async function generateDiffExplanation(
  input: BuildExplainInput,
  client: Pick<LlmClient, "complete">
): Promise<string> {
  const text = await client.complete(buildExplainUserPrompt(input), {
    system: buildExplainSystemPrompt(input.config),
    temperature: 0.3,
    maxTokens: 500,
  })
  return stripFences(text)
}
