// Convert normalized SubagentImportDraft to internal cognia-next types.
//
// We support two import targets, picked by the user at the import dialog:
//   - SubAgentTemplate (Zustand-backed runtime template)
//   - CharacterDraft   (Dexie character row, written via createCharacter)

import { nanoid } from "nanoid"

import type { CharacterDraft } from "@/lib/db/characters"
import type { ProviderName } from "@/types/provider/provider"
import type { SubAgentTemplate } from "@/types/agent/sub-agent"

import type { SubagentImportDraft } from "./types"

/** Map provider hint to cognia's `ProviderName`. Unknown hints become undefined. */
function toProviderName(hint: SubagentImportDraft["providerHint"]): ProviderName | undefined {
  if (hint === "anthropic") return "anthropic"
  if (hint === "openai") return "openai"
  // cognia uses "google" as the id for Gemini's provider.
  if (hint === "gemini") return "google"
  return undefined
}

/**
 * Convert a draft to a complete `SubAgentTemplate`. The result has a fresh id
 * and `isBuiltIn: false` so the runtime store always treats it as a user
 * template.
 */
export function toSubagentTemplate(d: SubagentImportDraft): SubAgentTemplate {
  return {
    id: nanoid(),
    name: d.name,
    description: d.description ?? "",
    category: "general",
    taskTemplate: "{{task}}",
    config: {
      systemPrompt: d.systemPrompt,
      tools: d.tools,
      model: d.model,
      provider: toProviderName(d.providerHint),
      maxSteps: 10,
      timeout: 180_000,
      priority: "normal",
    },
    isBuiltIn: false,
    createdAt: new Date(),
  }
}

/** Convert a draft to a `CharacterDraft` ready for `createCharacter`. */
export function toCharacterDraft(d: SubagentImportDraft): CharacterDraft {
  return {
    name: d.name,
    description: d.description,
    systemPrompt: d.systemPrompt,
    model: d.model,
    permissionMode: "default",
    allowedTools: d.tools,
  }
}
