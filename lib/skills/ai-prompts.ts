// Prompt templates used by the editor's AI assistant. The system prompt
// frames the model as a SKILL.md editor; the user prompt feeds the current
// content + the desired transformation. Each template ends with a strict
// "respond with only the rewritten markdown body, no commentary" directive
// so the response can be slotted back into the editor verbatim.
//
// The framing, each intent's instruction and the request layout are Prompt
// Center definitions (ADR-0236); the skill's name, description, body and
// validation issues are values rendered into the request.

import type { SkillValidationError } from "@cognia/agent-config-types"
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import { definePrompt, type PromptDefinitionV1 } from "@/lib/prompts/types"

export type AiIntent = "optimize" | "simplify" | "expand" | "fixErrors"

export interface AiPromptInput {
  name: string
  description?: string
  /** Current SKILL.md body (without YAML frontmatter). */
  content: string
  /** Validation issues, only used for the "fixErrors" intent. */
  validationErrors?: SkillValidationError[]
}

const SKILL_AI_CONSUMERS = ["lib/skills/ai-prompts.ts"] as const
const REWRITE_CONTRACT =
  "The reply replaces the SKILL.md body in the editor as a reviewable suggestion; a wrapping ```markdown fence is stripped."
/** A SKILL.md body is bounded by the editor; this only guards. */
const SKILL_VALUE_MAX = 1_000_000

export const SKILL_AI_SYSTEM_PROMPT = definePrompt({
  id: "developer.skills.authoring",
  contractVersion: 1,
  kind: "feature-template",
  group: "developer",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  // The reply is slotted into the editor verbatim.
  risk: "protocol",
  hosts: ["app"],
  maxChars: 4_000,
  outputContract: REWRITE_CONTRACT,
  consumers: SKILL_AI_CONSUMERS,
  defaultBody: `You are an expert SKILL.md editor for Claude Code.
You receive a skill's name, description, and current markdown body, plus an instruction to rewrite the body.
Respond with ONLY the rewritten markdown body — no preamble, no commentary, no fenced code wrapper.
Preserve the existing structure (headings, lists, code blocks) unless the instruction explicitly requires a structural change.
Keep imperative-mood instructions short and concrete.
Do not invent tool names or APIs that the original didn't already mention.`,
})

function intentPrompt(slug: string, defaultBody: string): PromptDefinitionV1 {
  return definePrompt({
    id: `developer.skills.authoring.${slug}`,
    contractVersion: 1,
    kind: "feature-template",
    group: "developer",
    operation: "replace-template",
    scopes: ["account"],
    activation: "next-operation",
    risk: "ordinary",
    hosts: ["app"],
    maxChars: 4_000,
    outputContract:
      "Rendered as {{instruction}} in the rewrite request when the user picks this action.",
    consumers: SKILL_AI_CONSUMERS,
    defaultBody,
  })
}

/** The instruction each ✨ action sends. */
export const SKILL_AI_INTENT_PROMPTS: Readonly<Record<AiIntent, PromptDefinitionV1>> = {
  optimize: intentPrompt(
    "optimize",
    "Tighten the phrasing throughout. Remove redundancy, vague qualifiers, and filler. Aim for the same intent in fewer words. Keep all factual content."
  ),
  simplify: intentPrompt(
    "simplify",
    "Rewrite for a reader who is new to the topic. Replace jargon with plain language. Define any term-of-art the first time it appears. Don't drop any actionable steps."
  ),
  expand: intentPrompt(
    "expand",
    "Add concrete detail, illustrative examples, and edge cases. Where the current content is abstract, ground it in a worked example. Don't repeat the same point twice in different words."
  ),
  fixErrors: intentPrompt(
    "fix-errors",
    "Address each validation issue listed below by editing the markdown body so that, on a re-validate, those issues no longer apply. Do not introduce new headings or restructure the skill more than necessary."
  ),
}

/**
 * The request around the skill. `{{description}}` and `{{validationIssues}}`
 * are empty or start with their own line breaks, so an absent one leaves no
 * blank section behind.
 */
export const SKILL_AI_REQUEST_PROMPT = definePrompt({
  id: "developer.skills.authoring.request",
  contractVersion: 1,
  kind: "feature-template",
  group: "developer",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  risk: "protocol",
  hosts: ["app"],
  maxChars: 4_000,
  variables: [
    { name: "name", required: true, maxChars: SKILL_VALUE_MAX },
    { name: "description", required: false, maxChars: SKILL_VALUE_MAX },
    { name: "instruction", required: true, maxChars: SKILL_VALUE_MAX },
    { name: "validationIssues", required: false, maxChars: SKILL_VALUE_MAX },
    { name: "content", required: true, maxChars: SKILL_VALUE_MAX },
  ],
  outputContract: REWRITE_CONTRACT,
  consumers: SKILL_AI_CONSUMERS,
  defaultBody: [
    "Skill name: {{name}}{{description}}",
    "",
    "Instruction:",
    "{{instruction}}{{validationIssues}}",
    "",
    "Current SKILL.md body:",
    "```markdown",
    "{{content}}",
    "```",
    "",
    "Respond with the rewritten body only — no fenced wrapper, no leading or trailing prose.",
  ].join("\n"),
})

export async function buildAiUserPrompt(intent: AiIntent, input: AiPromptInput): Promise<string> {
  const instruction = (await resolvePromptAsync(SKILL_AI_INTENT_PROMPTS[intent])).text
  const description = input.description?.trim() ? `\nDescription: ${input.description.trim()}` : ""
  const validationIssues =
    intent === "fixErrors" && input.validationErrors?.length
      ? [
          "",
          "",
          "Validation issues to address:",
          ...input.validationErrors.map((err) => `- ${err.message}`),
        ].join("\n")
      : ""
  return (
    await resolvePromptAsync(SKILL_AI_REQUEST_PROMPT, {
      values: {
        name: input.name || "(unnamed)",
        description,
        instruction,
        validationIssues,
        content: input.content.trim(),
      },
    })
  ).text
}

export async function buildAiSystemPrompt(): Promise<string> {
  return (await resolvePromptAsync(SKILL_AI_SYSTEM_PROMPT)).text
}
