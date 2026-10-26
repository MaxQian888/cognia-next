/**
 * The system prompts for canvas AI suggestions (ADR-0236).
 *
 * `useCanvasSuggestions` resolves these per run, in the canvas document's
 * session and workspace. The answer is a schema-validated object (the schema
 * stays in the hook), so the wording is editable; `{{N}}` is the suggestion
 * cap from Settings → Canvas → AI, which the hook also enforces by slicing.
 *
 * Ids sit under `generation.canvas-suggestions.*`, apart from the canvas
 * actions' `generation.canvas.<action>` (which already has a `review`).
 */

import { definePrompt } from "@/lib/prompts/types"

const SUGGESTION_PROMPT_CONSUMERS = ["hooks/canvas/use-canvas-suggestions.ts"] as const

const SUGGESTION_VARIABLES = [{ name: "N", required: false, maxChars: 16 }] as const

/** The caret-local pass: polish around the cursor / selection. */
export const CANVAS_SUGGESTIONS_PROMPT = definePrompt({
  id: "generation.canvas-suggestions.assist",
  contractVersion: 1,
  kind: "feature-template",
  group: "generation",
  operation: "replace-template",
  scopes: ["account", "workspace", "session"],
  activation: "next-operation",
  // The answer is validated against the suggestion schema the field names
  // below describe; a mismatch is a failed run, not a wrong suggestion.
  risk: "protocol",
  hosts: ["app"],
  maxChars: 4_000,
  variables: SUGGESTION_VARIABLES,
  requiredFragments: ["originalText"],
  outputContract:
    "Answered as a schema-validated object of anchored suggestions; at most {{N}} (the Settings cap) are kept and added to the document's Suggestions panel.",
  consumers: SUGGESTION_PROMPT_CONSUMERS,
  defaultBody: `You are an expert code/text editing assistant. Given a document and the user's
current cursor / selection context, propose AT MOST {{N}} concise, mechanical suggestions
that improve correctness, readability, or style.

Quote \`originalText\` verbatim from the document and give the 1-based line range it
covers. \`confidence\` is how sure you are the change is correct and wanted.
If no useful suggestion exists, return an empty list.`,
})

/**
 * A review pass rather than a caret-local one: the whole document is in scope,
 * and the interesting output is problems, not polish. `review` used to produce
 * a wall of prose that nothing rendered, so it is anchored suggestions now.
 */
export const CANVAS_REVIEW_PROMPT = definePrompt({
  id: "generation.canvas-suggestions.review",
  contractVersion: 1,
  kind: "feature-template",
  group: "generation",
  operation: "replace-template",
  scopes: ["account", "workspace", "session"],
  activation: "next-operation",
  risk: "protocol",
  hosts: ["app"],
  maxChars: 4_000,
  variables: SUGGESTION_VARIABLES,
  requiredFragments: ["originalText", "suggestedText"],
  outputContract:
    "Answered as a schema-validated object of anchored findings over the whole document; at most {{N}} are kept and offered for accept / reject one at a time.",
  consumers: SUGGESTION_PROMPT_CONSUMERS,
  defaultBody: `You are a meticulous reviewer. Read the whole document and report AT MOST {{N}}
specific, actionable findings: bugs, incorrect logic, unhandled edge cases, factual
errors, and clear violations of the conventions the document itself establishes.

Each finding must be anchored: quote \`originalText\` verbatim from the document, give
the 1-based line range it covers, and put the corrected text in \`suggestedText\`. When a
finding is a warning with no mechanical fix, repeat the original text as the suggestion
and use type "comment". \`confidence\` is how sure you are the finding is real.
If the document has no findings worth reporting, return an empty list.`,
})
