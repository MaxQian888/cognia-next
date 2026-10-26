/**
 * The recall reranker's prompt definition, kept apart from its consumer so
 * the Prompt Center catalog does not load the twin runtime with it.
 */

import { MEMORY_RERANK_SYSTEM_PROMPT } from "@cognia/memory/retrieve/llm-rerank"
import { definePrompt } from "@/lib/prompts/types"

/**
 * The opt-in recall reranker's system prompt (ADR-0236). Account scope only:
 * the reranker sees a redacted query and recalled texts, not the reader's
 * workspace. Resolved per recall, so an edit applies on the next one.
 */
export const MEMORY_RERANK_PROMPT = definePrompt({
  id: "knowledge.memory.rerank",
  contractVersion: 1,
  kind: "feature-template",
  group: "knowledge",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  // The reply is parsed as JSON scores; an incomplete answer keeps the local order.
  risk: "protocol",
  hosts: ["app"],
  maxChars: 4_000,
  requiredFragments: ["JSON"],
  outputContract:
    "Sent as the system prompt of the recall reranker; the reply is parsed as JSON `scores` and anything but exactly one valid score per candidate keeps the local order.",
  consumers: ["lib/memory/runtime/build-deps.ts"],
  defaultBody: MEMORY_RERANK_SYSTEM_PROMPT,
})
