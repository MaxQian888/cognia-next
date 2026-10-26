/**
 * The LLM query-expansion prompts (HyDE / step-back) as Prompt Center slots
 * (ADR-0236).
 *
 * The package (`@cognia/rag/query-expansion`) owns the shipped templates and
 * fills in each call's values (the query, the passage cap); the two retrieval
 * legs that run an expansion (project knowledge, the twin runtime) render the
 * resolved template through the package's `renderPrompt` hook. The snapshot is
 * read once per retrieval, so both the template and the scope that selected it
 * are fixed before the model is called.
 *
 * Scopes: a project-knowledge retrieval names its workspace and a twin
 * retrieval names its character (an agent), so each can carry an override of
 * its own.
 */

import {
  HYDE_PROMPT_TEMPLATE,
  STEP_BACK_PROMPT_TEMPLATE,
  type HydePromptValues,
  type StepBackPromptValues,
} from "@cognia/rag/query-expansion"
import { resolvePrompt } from "@/lib/prompts/resolve"
import {
  loadPromptOverrideSnapshot,
  peekPromptOverrideSnapshot,
  type PromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { definePrompt, type PromptResolutionContext } from "@/lib/prompts/types"

/** The user message is uncapped where expansion runs; this only guards. */
const QUERY_MAX = 200_000

/** The binder below is the one place either slot is resolved. */
const CONSUMERS = ["lib/ai/retrieval/expansion-prompts.ts"]

export const RAG_HYDE_PROMPT = definePrompt({
  id: "knowledge.rag.hyde",
  contractVersion: 1,
  kind: "feature-template",
  group: "knowledge",
  operation: "replace-template",
  scopes: ["account", "workspace", "agent"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app"],
  maxChars: 4_000,
  variables: [
    // Empty, or `Domain: <domain>` plus a newline when the caller names one.
    { name: "domainContext", required: false, maxChars: 1_000 },
    { name: "maxLength", required: false, maxChars: 16 },
    { name: "query", required: true, maxChars: QUERY_MAX },
  ],
  outputContract:
    "The reply is trimmed, cut to the passage cap (300 characters) and embedded as a second query; an empty reply skips the expansion leg.",
  consumers: CONSUMERS,
  defaultBody: HYDE_PROMPT_TEMPLATE,
})

export const RAG_STEP_BACK_PROMPT = definePrompt({
  id: "knowledge.rag.step-back",
  contractVersion: 1,
  kind: "feature-template",
  group: "knowledge",
  operation: "replace-template",
  scopes: ["account", "workspace", "agent"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app"],
  maxChars: 4_000,
  variables: [{ name: "query", required: true, maxChars: QUERY_MAX }],
  outputContract:
    "The reply is trimmed, stripped of surrounding quotes and embedded as a second query; a failed call falls back to the original question.",
  consumers: CONSUMERS,
  defaultBody: STEP_BACK_PROMPT_TEMPLATE,
})

/** The package's `renderPrompt` hooks, bound to one retrieval's snapshot and scope. */
export interface ExpansionPromptRenderers {
  hyde: (values: HydePromptValues) => string
  stepBack: (values: StepBackPromptValues) => string
}

/**
 * Load the override snapshot (once) and bind both expansion renderers to it.
 * An unreadable snapshot renders the shipped templates; it never fails the
 * retrieval.
 */
export async function loadExpansionPromptRenderers(
  context: PromptResolutionContext
): Promise<ExpansionPromptRenderers> {
  const snapshot: PromptOverrideSnapshot | null =
    peekPromptOverrideSnapshot() ?? (await loadPromptOverrideSnapshot().catch(() => null))
  return {
    hyde: (values) =>
      resolvePrompt(RAG_HYDE_PROMPT, { context, snapshot, values: { ...values } }).text,
    stepBack: (values) =>
      resolvePrompt(RAG_STEP_BACK_PROMPT, { context, snapshot, values: { ...values } }).text,
  }
}
