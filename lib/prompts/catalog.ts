/**
 * The code-owned prompt catalog (ADR-0236).
 *
 * A list of references to definitions that live with their owners; it is not
 * a second home for any prompt text. Every entry here has a real consumer
 * that resolves it (see each definition's `consumers`), and the catalog test
 * fails on a duplicate id, a default that does not validate against its own
 * contract, or a definition nothing resolves.
 *
 * Imported by the Prompt Center and the CLI `prompts` command only, never on
 * a send path: consumers import their own definition directly.
 */

import { TITLE_CHAT_PROMPT, TITLE_WORK_PROMPT } from "@/lib/ai/generation/title"
import type { PromptDefinitionV1 } from "./types"

export const PROMPT_DEFINITIONS: readonly PromptDefinitionV1[] = [
  TITLE_CHAT_PROMPT,
  TITLE_WORK_PROMPT,
]

const BY_ID = new Map<string, PromptDefinitionV1>()
for (const def of PROMPT_DEFINITIONS) {
  if (BY_ID.has(def.id)) throw new Error(`duplicate prompt definition id: ${def.id}`)
  BY_ID.set(def.id, def)
}

export function getPromptDefinition(id: string): PromptDefinitionV1 | undefined {
  return BY_ID.get(id)
}

export function listPromptDefinitions(): readonly PromptDefinitionV1[] {
  return PROMPT_DEFINITIONS
}
