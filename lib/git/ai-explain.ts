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
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import { definePrompt } from "@/lib/prompts/types"

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

export const DIFF_EXPLAIN_PROMPT = definePrompt({
  id: "developer.diff-explain",
  contractVersion: 1,
  kind: "feature-template",
  group: "developer",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app"],
  maxChars: 8_000,
  outputContract:
    'Shown as the change explanation after markdown fences are stripped. The source-control "Additional instructions" setting for explanations is appended after this text.',
  consumers: ["lib/git/ai-explain.ts"],
  defaultBody: [
    "You explain a Git diff to a developer reviewing the change.",
    "Write a brief, plain-language summary: first a one-sentence overview of WHAT changed, then 2–5 short bullet points covering the notable edits and, where inferable, WHY.",
    "Be concrete and grounded in the diff — never invent changes that are not present. Keep it under ~150 words. Output plain text (a short intro line then `- ` bullets), no markdown headings, no code fences.",
  ].join("\n"),
})

/** The base instructions plus the user's appended explanation instructions, if any. */
export function buildExplainSystemPrompt(
  config: DiffExplainConfig,
  base: string = DIFF_EXPLAIN_PROMPT.defaultBody
): string {
  const extra = config.customInstructions?.trim()
  return extra ? `${base}\nAdditional instructions: ${extra}` : base
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
 * testable with a mock `{ complete }`. The base instructions resolve from the
 * Prompt Center (ADR-0236) at each call.
 */
export async function generateDiffExplanation(
  input: BuildExplainInput,
  client: Pick<LlmClient, "complete">
): Promise<string> {
  const base = (await resolvePromptAsync(DIFF_EXPLAIN_PROMPT)).text
  const text = await client.complete(buildExplainUserPrompt(input), {
    system: buildExplainSystemPrompt(input.config, base),
    temperature: 0.3,
    maxTokens: 500,
  })
  return stripFences(text)
}
