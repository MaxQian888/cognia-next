/**
 * The agent task that hatches a v2 sprite pet (ADR-0236).
 *
 * Settings → Pet → "Create with an agent" seeds a new chat's composer with
 * this task: the user reviews it, then sends it to an agent that runs the
 * `$hatch-pet` skill to generate the image atlas. It is the user's message
 * once sent, so the entry is a `composer-template`.
 *
 * The shipped text is localized: it is copy the user reads and may edit in
 * the composer, so with no override the caller's translated lines are used,
 * exactly as before. `defaultBody` is the English copy (a test pins it to the
 * English messages). A published override replaces the whole task in every
 * locale, with `{{concept}}` standing for the user's brief.
 */

import { resolvePromptAsync } from "@/lib/prompts/resolve"
import { definePrompt } from "@/lib/prompts/types"

/** The translated lines of the shipped task, in order. */
export interface HatchPetPromptCopy {
  defaultConcept: string
  instruction: string
  concept: (brief: string) => string
  qa: string
  outputFiles: string
  scope: string
}

export const HATCH_PET_SPRITE_PROMPT = definePrompt({
  id: "generation.pet.hatch-sprite",
  contractVersion: 1,
  kind: "composer-template",
  group: "generation",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app"],
  maxChars: 4_000,
  variables: [{ name: "concept", required: true, maxChars: 200_000 }],
  outputContract:
    "Seeded as the draft of a new chat for the user to review and send; the agent's pet.json and spritesheet are then imported by the v2 sprite importer. {{concept}} is the user's brief, or a default pet when it is blank. Shipped in the UI language; an override applies in every language.",
  consumers: ["lib/pet/hatch-prompt.ts"],
  defaultBody: [
    "Use the $hatch-pet skill to create a Codex-compatible v2 animated pet.",
    "Pet concept: {{concept}}",
    "Complete every required animation row and QA gate.",
    "Keep the final pet.json and spritesheet.webp files and report their absolute paths.",
    "This is for Cognia's v2 sprite importer; do not modify Cognia source code.",
  ].join("\n"),
})

/**
 * The task to seed for `concept`: a published override when there is one,
 * otherwise the translated shipped lines.
 */
export async function buildHatchPetPrompt(
  concept: string,
  copy: HatchPetPromptCopy
): Promise<string> {
  const brief = concept.trim() || copy.defaultConcept
  const resolved = await resolvePromptAsync(HATCH_PET_SPRITE_PROMPT, { values: { concept: brief } })
  if (resolved.source.kind === "override") return resolved.text
  return [copy.instruction, copy.concept(brief), copy.qa, copy.outputFiles, copy.scope].join("\n")
}
