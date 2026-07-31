// Prompt templates used by the editor's AI assistant. The system prompt
// frames the model as a SKILL.md editor; the user prompt feeds the current
// content + the desired transformation. Each template ends with a strict
// "respond with only the rewritten markdown body, no commentary" directive
// so the response can be slotted back into the editor verbatim.

import type { SkillValidationError } from "@cognia/agent-config-types"

export type AiIntent = "optimize" | "simplify" | "expand" | "fixErrors"

export interface AiPromptInput {
  name: string
  description?: string
  /** Current SKILL.md body (without YAML frontmatter). */
  content: string
  /** Validation issues, only used for the "fixErrors" intent. */
  validationErrors?: SkillValidationError[]
}

const SYSTEM_PROMPT = `You are an expert SKILL.md editor for Claude Code.
You receive a skill's name, description, and current markdown body, plus an instruction to rewrite the body.
Respond with ONLY the rewritten markdown body — no preamble, no commentary, no fenced code wrapper.
Preserve the existing structure (headings, lists, code blocks) unless the instruction explicitly requires a structural change.
Keep imperative-mood instructions short and concrete.
Do not invent tool names or APIs that the original didn't already mention.
`.trim()

const INTENT_INSTRUCTIONS: Record<AiIntent, string> = {
  optimize:
    "Tighten the phrasing throughout. Remove redundancy, vague qualifiers, and filler. Aim for the same intent in fewer words. Keep all factual content.",
  simplify:
    "Rewrite for a reader who is new to the topic. Replace jargon with plain language. Define any term-of-art the first time it appears. Don't drop any actionable steps.",
  expand:
    "Add concrete detail, illustrative examples, and edge cases. Where the current content is abstract, ground it in a worked example. Don't repeat the same point twice in different words.",
  fixErrors:
    "Address each validation issue listed below by editing the markdown body so that, on a re-validate, those issues no longer apply. Do not introduce new headings or restructure the skill more than necessary.",
}

export function buildAiUserPrompt(intent: AiIntent, input: AiPromptInput): string {
  const instruction = INTENT_INSTRUCTIONS[intent]
  const lines: string[] = []
  lines.push(`Skill name: ${input.name || "(unnamed)"}`)
  if (input.description?.trim()) {
    lines.push(`Description: ${input.description.trim()}`)
  }
  lines.push("")
  lines.push("Instruction:")
  lines.push(instruction)
  if (intent === "fixErrors" && input.validationErrors?.length) {
    lines.push("")
    lines.push("Validation issues to address:")
    for (const err of input.validationErrors) {
      lines.push(`- ${err.message}`)
    }
  }
  lines.push("")
  lines.push("Current SKILL.md body:")
  lines.push("```markdown")
  lines.push(input.content.trim())
  lines.push("```")
  lines.push("")
  lines.push(
    "Respond with the rewritten body only — no fenced wrapper, no leading or trailing prose."
  )
  return lines.join("\n")
}

export function buildAiSystemPrompt(): string {
  return SYSTEM_PROMPT
}
