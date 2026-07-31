/**
 * Pure projections from the character editor's form fields into the ADR-0030
 * v2 pack shapes. Extracted from `components/settings/characters-section.tsx`
 * so the mapping (and its "blank → undefined" rules) is unit-testable without
 * mounting the editor.
 */

import type { Character } from "@cognia/agent-config-types"
import type { TTSProvider } from "@cognia/tts/types"
import { isOverlayCharacterId } from "@/lib/plugin/registries/character-pack-registry"
import type {
  PluginCharacterDef,
  PluginCharacterPersona,
  PluginCharacterVoiceProfile,
} from "@/types/plugin/plugin-character-pack"

export type CharacterSource = "builtin" | "plugin" | "user"

/** Classify a character by origin for the Settings list source filter. */
export function classifyCharacterSource(c: Character): CharacterSource {
  if (c.isBuiltIn) return "builtin"
  if (isOverlayCharacterId(c.id) || c.sourcePluginId) return "plugin"
  return "user"
}

/**
 * Filter the character list by a free-text query (name / description) and an
 * optional source bucket. Pure — drives the Settings → Characters search bar.
 */
export function filterCharacters(
  characters: readonly Character[],
  query: string,
  sourceFilter: "all" | CharacterSource
): Character[] {
  const q = query.trim().toLowerCase()
  return characters.filter((c) => {
    if (sourceFilter !== "all" && classifyCharacterSource(c) !== sourceFilter) return false
    if (!q) return true
    return c.name.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q)
  })
}

/** Split a textarea into trimmed, non-empty lines (one exemplar prompt each). */
export function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
}

export interface PersonaInput {
  tone: string
  personality: string
  openingMessage: string
  /** Newline-separated exemplar prompts. */
  exemplarPromptsText: string
}

/** Project persona fields into a `PluginCharacterPersona`, or `undefined`
 *  when every field is blank. */
export function buildPersona(input: PersonaInput): PluginCharacterPersona | undefined {
  const tone = input.tone.trim()
  const personality = input.personality.trim()
  const openingMessage = input.openingMessage.trim()
  const exemplarPrompts = parseLines(input.exemplarPromptsText)
  if (!tone && !personality && !openingMessage && exemplarPrompts.length === 0) return undefined
  return {
    ...(tone ? { tone } : {}),
    ...(personality ? { personality } : {}),
    ...(openingMessage ? { openingMessage } : {}),
    ...(exemplarPrompts.length > 0 ? { exemplarPrompts } : {}),
  }
}

export interface VoiceInput {
  provider: TTSProvider | "none"
  voiceId: string
  rate: number
  pitch: number
  volume: number
}

/** Project voice fields into a `PluginCharacterVoiceProfile`, or `undefined`
 *  when no provider/voice is chosen. */
export function buildVoiceProfile(input: VoiceInput): PluginCharacterVoiceProfile | undefined {
  if (input.provider === "none" || !input.voiceId.trim()) return undefined
  return {
    provider: input.provider,
    voiceId: input.voiceId.trim(),
    rate: input.rate,
    pitch: input.pitch,
    volume: input.volume,
  }
}

/**
 * Project a Dexie `Character` into the portable `PluginCharacterDef` shape for
 * bulk export into a `.cognia-pack.json`. Host-managed identity / lifecycle /
 * Twin-binding fields are intentionally dropped — only the pack-portable
 * subset survives. `undefined` fields are omitted to keep the file lean.
 */
export function characterToPackDef(character: Character): PluginCharacterDef {
  const def: PluginCharacterDef = {
    localId: character.id,
    name: character.name,
    avatarColor: character.avatarColor,
    systemPrompt: character.systemPrompt,
  }
  const optional: Partial<PluginCharacterDef> = {
    description: character.description,
    avatarEmoji: character.avatarEmoji,
    model: character.model,
    providerId: character.providerId,
    permissionMode: character.permissionMode,
    allowedTools: character.allowedTools,
    disallowedTools: character.disallowedTools,
    mcpServerIds: character.mcpServerIds,
    skillIds: character.skillIds,
    pluginSkillIds: character.pluginSkillIds,
    workingDir: character.workingDir,
    bareMode: character.bareMode,
    debugMode: character.debugMode,
    briefMode: character.briefMode,
    enableComputerUse: character.enableComputerUse,
    enableBrowserTools: character.enableBrowserTools,
    computerUseSettings: character.computerUseSettings,
    sandboxEnabled: character.sandboxEnabled,
    sandboxTier: character.sandboxTier,
    a2uiEnabled: character.a2uiEnabled,
    a2uiCatalogId: character.a2uiCatalogId,
    platformDefaults: character.platformDefaults,
    availableOnPlatforms: character.availableOnPlatforms,
    avatarImage: character.avatarImage,
    persona: character.persona,
    voiceProfile: character.voiceProfile,
  }
  const target = def as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(optional)) {
    if (v !== undefined) target[k] = v
  }
  return def
}
