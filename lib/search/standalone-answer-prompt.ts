/**
 * The standalone search answer's prompt definition, kept apart from its
 * consumer so the Prompt Center catalog does not load the settings store and
 * the search runtime with it.
 */

import { STANDALONE_ANSWER_SYSTEM_PROMPT } from "@cognia/web-search/standalone-answer"
import { definePrompt } from "@/lib/prompts/types"

/**
 * The cited-answer synthesis system prompt (ADR-0236). Account scope only: the
 * standalone search surface is not bound to a workspace (its ledger binding
 * carries none). The numbered sources it cites are framed in the user prompt.
 */
export const STANDALONE_SEARCH_ANSWER_PROMPT = definePrompt({
  id: "knowledge.web-search.answer",
  contractVersion: 1,
  kind: "feature-template",
  group: "knowledge",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app"],
  maxChars: 4_000,
  outputContract:
    "Sent as the system prompt of the standalone search answer; the trimmed reply is shown as the answer above the numbered sources (an empty reply falls back to the search provider's own answer).",
  consumers: ["lib/search/standalone-answer.ts"],
  defaultBody: STANDALONE_ANSWER_SYSTEM_PROMPT,
})
