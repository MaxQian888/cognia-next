/**
 * Prompt assembly for generating a Skill from a recording trace. Pure (no model
 * call) so it is unit-testable. Mirrors the structure of OpenAI Codex's
 * generated skills: a procedure with "when to use / inputs / steps / verify".
 */

import { SKILL_CATEGORIES } from "@/lib/skills/categories"

const CATEGORY_IDS = SKILL_CATEGORIES.map((c) => c.id).join(" | ")

export function buildSkillSystemPrompt(): string {
  return [
    "You are an expert at turning a recorded desktop workflow into a reusable SKILL.md procedure.",
    "You are given a compact transcript of what a user did (clicks, typed text hints, scrolls) with the UI elements they touched.",
    "Write a skill that an AI agent could later follow to reproduce the workflow with different inputs, using its own tools (it will NOT replay exact coordinates).",
    "",
    "Output ONLY a JSON object (no markdown fences, no preamble) with these keys:",
    '- "name": a short imperative title (<= 60 chars, letters/numbers/spaces/hyphens only).',
    '- "description": one sentence on what the skill accomplishes and when to use it.',
    '- "content": a markdown procedure with these sections, in order:',
    "    ## When to use",
    "    ## Inputs   (the variables a caller must supply — generalize the recorded specifics)",
    "    ## Steps    (numbered, imperative; describe intent, not pixel coordinates)",
    "    ## Verify   (how to confirm the workflow succeeded)",
    '- "tags": an array of 2-5 short lowercase tags.',
    `- "category": one of ${CATEGORY_IDS}.`,
    '- "allowedTools": an array of tool names the skill needs, or [] if unsure. Never invent tool names.',
    "",
    "Generalize: replace the specific values the user typed with named inputs. Do not fabricate steps that are not implied by the transcript.",
  ].join("\n")
}

export function buildSkillUserPrompt(traceText: string): string {
  return ["Recorded workflow transcript:", "", traceText].join("\n")
}
