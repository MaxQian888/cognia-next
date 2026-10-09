/**
 * The agent editor's form model and its two projections (ADR-0220).
 *
 * `CharacterEditor` edits an `EditorState`; a `Character` (or an agent draft)
 * becomes one through {@link characterToEditorState} and goes back through
 * {@link editorStateToOutput}. Both used to be written inline in the settings
 * list, the "edit row" copy and the "create" copy drifting apart field by
 * field. They live here so the agents console, the blank-create form and the
 * conversational builder's draft panel all project through the same code, and
 * so the builder's tools can validate a draft with the rules the form uses.
 */

import type {
  AgentBuilderDraft,
  AgentEnvBinding,
  AppSettings,
  Character,
  CharacterRuntimeBinding,
} from "@cognia/agent-config-types"
import type { SandboxShellTier } from "@/types/sandbox"
import type {
  PluginCharacterAvatarImage,
  PluginCharacterPersona,
  PluginCharacterVoiceProfile,
} from "@/types/plugin/plugin-character-pack"
import type { PluginRuntimeProfile } from "@/types/plugin/plugin"
import { normalizeTTSProvider, type SelectableTTSProvider } from "@cognia/tts/types"
import { buildPersona, buildVoiceProfile } from "@/lib/plugin/character-pack/editor-projection"
import { isValidAgentEnvName } from "@/lib/agent/agent-profile-policy"
import {
  pickAgentOverrides,
  type AgentOverrideField,
  type AgentOverrides,
} from "@/lib/agents/agent-overrides"

/** The avatar palette the editor offers; the first entry is a new agent's. */
export const AGENT_AVATAR_COLORS = [
  "oklch(0.65 0.18 245)",
  "oklch(0.7 0.15 30)",
  "oklch(0.7 0.13 150)",
  "oklch(0.78 0.16 90)",
  "oklch(0.7 0.14 320)",
  "oklch(0.7 0.16 200)",
  "oklch(0.65 0.18 350)",
  "oklch(0.7 0.14 60)",
] as const

const ALL_MEMORY_SCOPES: NonNullable<Character["memoryPolicy"]>["readableScopes"] = [
  "global",
  "workspace",
  "character",
  "agent",
]

export type EditorState = {
  name: string
  description: string
  avatarColor: string
  avatarEmoji: string
  systemPrompt: string
  model: string
  planModel: string
  utilityModel: string
  executionEffort: NonNullable<Character["executionPolicy"]>["effort"] | "inherit"
  executionMaxTurns: string
  executionEnvBindings: NonNullable<Character["executionPolicy"]>["envBindings"]
  permissionMode: AppSettings["permissionMode"]
  allowedTools: string[]
  disallowedTools: string[]
  mcpServerIds: string[] | undefined
  skillIds: string[]
  /** Plugin skill registry ids (`character.pluginSkillIds`). */
  pluginSkillIds: string[]
  knowledgeBaseIds: string[]
  memoryRecall: boolean
  memoryCreate: boolean
  memoryUpdate: boolean
  memoryForget: boolean
  memoryAutoLearn: boolean
  memoryReadableScopes: NonNullable<Character["memoryPolicy"]>["readableScopes"]
  memoryWritableScopes: NonNullable<Character["memoryPolicy"]>["writableScopes"]
  workingDir: string
  bareMode: boolean
  debugMode: boolean
  briefMode: boolean
  twinId?: string
  twinSettings?: Character["twinSettings"]
  enableComputerUse: boolean
  enableBrowserTools: boolean
  computerUseSettings?: Character["computerUseSettings"]
  /** ADR-0020 remote-target — `"local"` or a sandbox connection id. */
  computerUseTarget: "local" | string
  /** ADR-0028 Phase 10 — per-character sandbox enablement override. */
  sandboxEnabled: boolean
  /** ADR-0028 Phase 10 — `"inherit"` writes back as `undefined`. */
  sandboxTier: SandboxShellTier | "inherit"
  /** ADR-0028 Phase 10 — account UUID from `ProviderVault::accounts[]`. */
  accountIdOverride: string | "inherit"
  /** ADR-0220 — the default runtime; `undefined` follows the app default. */
  runtime: CharacterRuntimeBinding | undefined
  // ---- ADR-0030 v2 fields ---------------------------------------------------
  /** Persona — tone / personality prose. */
  personaTone: string
  personaPersonality: string
  /** Opening greeting seeded as the first assistant message on a new chat. */
  openingMessage: string
  /** Exemplar prompts (one per line) surfaced as quick-start chips. */
  exemplarPromptsText: string
  /** Avatar image as a web data URL ("" = none). */
  avatarImageDataUrl: string
  /** Voice profile — `"none"` means inherit the global TTS settings. */
  voiceProvider: SelectableTTSProvider | "none"
  voiceId: string
  voiceRate: number
  voicePitch: number
  voiceVolume: number
  /** Host profiles this character is available on (empty = all). */
  availablePlatforms: PluginRuntimeProfile[]
  /**
   * Overrides of app-level defaults, held verbatim (`undefined` = inherit) and
   * written back as-is, so an unchanged agent round-trips exactly.
   */
  overrides: AgentOverrides
}

/** What the editor hands its `onSave`: a `createCharacter` / `updateCharacter` payload. */
export type EditorOutput = Partial<Pick<Character, AgentOverrideField>> & {
  name: string
  description?: string
  avatarColor: string
  avatarEmoji?: string
  systemPrompt: string
  model?: string
  modelRouting?: Character["modelRouting"]
  executionPolicy?: Character["executionPolicy"]
  permissionMode?: AppSettings["permissionMode"]
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServerIds?: string[]
  skillIds?: string[]
  pluginSkillIds?: string[]
  knowledgeBaseIds?: string[]
  memoryPolicy?: Character["memoryPolicy"]
  workingDir?: string
  bareMode?: boolean
  debugMode?: boolean
  briefMode?: boolean
  twinId?: string
  twinSettings?: Character["twinSettings"]
  enableComputerUse?: boolean
  enableBrowserTools?: boolean
  computerUseSettings?: Character["computerUseSettings"]
  computerUseTarget?: Character["computerUseTarget"]
  sandboxEnabled?: boolean
  sandboxTier?: SandboxShellTier
  accountIdOverride?: string
  runtime?: CharacterRuntimeBinding
  // ---- ADR-0030 v2 fields ----
  persona?: PluginCharacterPersona
  voiceProfile?: PluginCharacterVoiceProfile
  avatarImage?: PluginCharacterAvatarImage
  availableOnPlatforms?: PluginRuntimeProfile[]
}

/** The form a brand-new agent opens with. */
export function emptyEditorState(): EditorState {
  return characterToEditorState({ avatarEmoji: "✨" })
}

/**
 * Hydrate the form from a stored agent or a draft. Every field the form shows
 * has its "not set" value here, so a partial draft opens like a blank agent
 * with only what the draft names filled in.
 */
export function characterToEditorState(character: AgentBuilderDraft | Character): EditorState {
  const target = character.computerUseTarget
  return {
    name: character.name ?? "",
    description: character.description ?? "",
    avatarColor: character.avatarColor ?? AGENT_AVATAR_COLORS[0],
    avatarEmoji: character.avatarEmoji ?? "",
    systemPrompt: character.systemPrompt ?? "",
    model: character.modelRouting?.execute ?? character.model ?? "",
    planModel: character.modelRouting?.plan ?? "",
    utilityModel: character.modelRouting?.utility ?? "",
    executionEffort: character.executionPolicy?.effort ?? "inherit",
    executionMaxTurns: character.executionPolicy?.maxTurns?.toString() ?? "",
    executionEnvBindings: character.executionPolicy?.envBindings,
    permissionMode: character.permissionMode,
    allowedTools: character.allowedTools ?? [],
    disallowedTools: character.disallowedTools ?? [],
    mcpServerIds: character.mcpServerIds,
    skillIds: character.skillIds ?? [],
    pluginSkillIds: character.pluginSkillIds ?? [],
    knowledgeBaseIds: character.knowledgeBaseIds ?? [],
    memoryRecall: character.memoryPolicy?.operations.recall ?? true,
    memoryCreate: character.memoryPolicy?.operations.create ?? true,
    memoryUpdate: character.memoryPolicy?.operations.update ?? true,
    memoryForget: character.memoryPolicy?.operations.forget ?? true,
    memoryAutoLearn: character.memoryPolicy?.autoLearn ?? true,
    memoryReadableScopes: character.memoryPolicy?.readableScopes ?? [...ALL_MEMORY_SCOPES],
    memoryWritableScopes: character.memoryPolicy?.writableScopes ?? [...ALL_MEMORY_SCOPES],
    workingDir: character.workingDir ?? "",
    bareMode: Boolean(character.bareMode),
    debugMode: Boolean(character.debugMode),
    briefMode: Boolean(character.briefMode),
    twinId: character.twinId,
    twinSettings: character.twinSettings,
    enableComputerUse: Boolean(character.enableComputerUse),
    enableBrowserTools: Boolean(character.enableBrowserTools),
    computerUseSettings: character.computerUseSettings,
    computerUseTarget: target && typeof target === "object" ? target.connectionId : "local",
    sandboxEnabled: Boolean(character.sandboxEnabled),
    sandboxTier: character.sandboxTier ?? "inherit",
    accountIdOverride: character.accountIdOverride ?? "inherit",
    runtime: character.runtime,
    personaTone: character.persona?.tone ?? "",
    personaPersonality: character.persona?.personality ?? "",
    openingMessage: character.persona?.openingMessage ?? "",
    exemplarPromptsText: (character.persona?.exemplarPrompts ?? []).join("\n"),
    avatarImageDataUrl: character.avatarImage?.webDataUrl ?? "",
    voiceProvider: character.voiceProfile
      ? normalizeTTSProvider(character.voiceProfile.provider)
      : "none",
    voiceId: character.voiceProfile?.voiceId ?? "",
    voiceRate: character.voiceProfile?.rate ?? 1,
    voicePitch: character.voiceProfile?.pitch ?? 1,
    voiceVolume: character.voiceProfile?.volume ?? 1,
    availablePlatforms: character.availableOnPlatforms ?? [],
    overrides: pickAgentOverrides(character),
  }
}

/** Why a form cannot be saved yet. One issue at a time, in the order a person fixes them. */
export type EditorValidationIssue =
  | { code: "nameRequired" }
  | { code: "systemPromptRequired" }
  | { code: "maxTurnsInvalid" }
  | { code: "envNameInvalid"; name: string }
  | { code: "envNameDuplicate"; name: string }

/** The first thing stopping `state` from being saved, or `null`. Secrets are the caller's. */
export function validateEditorState(state: EditorState): EditorValidationIssue | null {
  if (!state.name.trim()) return { code: "nameRequired" }
  if (!state.systemPrompt.trim()) return { code: "systemPromptRequired" }
  const maxTurns = parseMaxTurns(state.executionMaxTurns)
  if (maxTurns === "invalid") return { code: "maxTurnsInvalid" }
  const names = new Set<string>()
  for (const binding of state.executionEnvBindings ?? []) {
    const name = binding.name.trim()
    if (!isValidAgentEnvName(name)) return { code: "envNameInvalid", name: name || "?" }
    if (names.has(name)) return { code: "envNameDuplicate", name }
    names.add(name)
  }
  return null
}

function parseMaxTurns(text: string): number | undefined | "invalid" {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const value = Number(trimmed)
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : "invalid"
}

/** The environment bindings as they are saved: names trimmed. */
export function normalizedEnvBindings(state: EditorState): AgentEnvBinding[] {
  return (state.executionEnvBindings ?? []).map((binding) => ({
    ...binding,
    name: binding.name.trim(),
  }))
}

/**
 * Project a valid form to the payload `onSave` receives. Call
 * {@link validateEditorState} first; an invalid max-turn value is dropped here.
 */
export function editorStateToOutput(s: EditorState): EditorOutput {
  const maxTurns = parseMaxTurns(s.executionMaxTurns)
  const envBindings = normalizedEnvBindings(s)
  const executeModel = s.model.trim() || undefined
  const planModel = s.planModel.trim() || undefined
  const utilityModel = s.utilityModel.trim() || undefined
  const modelRouting =
    planModel || executeModel || utilityModel
      ? { plan: planModel, execute: executeModel, utility: utilityModel }
      : undefined
  const executionEffort = s.executionEffort === "inherit" ? undefined : s.executionEffort
  const turns = maxTurns === "invalid" ? undefined : maxTurns
  const executionPolicy =
    executionEffort || turns !== undefined || envBindings.length > 0
      ? {
          effort: executionEffort,
          maxTurns: turns,
          envBindings: envBindings.length > 0 ? envBindings : undefined,
        }
      : undefined
  return {
    name: s.name.trim(),
    description: s.description.trim() || undefined,
    avatarColor: s.avatarColor,
    avatarEmoji: s.avatarEmoji.trim() || undefined,
    systemPrompt: s.systemPrompt,
    // Keep the legacy column for older clients while semantic routing is
    // the new execution source of truth.
    model: executeModel,
    modelRouting,
    executionPolicy,
    permissionMode: s.permissionMode,
    allowedTools: s.allowedTools.length > 0 ? s.allowedTools : undefined,
    disallowedTools: s.disallowedTools.length > 0 ? s.disallowedTools : undefined,
    mcpServerIds: s.mcpServerIds,
    skillIds: s.skillIds.length > 0 ? s.skillIds : undefined,
    // Empty array, not undefined: clearing the last plugin skill must
    // overwrite the stored list rather than leave it untouched.
    pluginSkillIds: s.pluginSkillIds,
    knowledgeBaseIds: s.knowledgeBaseIds.length > 0 ? s.knowledgeBaseIds : undefined,
    memoryPolicy: {
      operations: {
        recall: s.memoryRecall,
        create: s.memoryCreate,
        update: s.memoryUpdate,
        forget: s.memoryForget,
      },
      readableScopes: s.memoryReadableScopes,
      writableScopes: s.memoryWritableScopes,
      autoLearn: s.memoryAutoLearn,
    },
    workingDir: s.workingDir.trim() || undefined,
    bareMode: s.bareMode || undefined,
    debugMode: s.debugMode || undefined,
    briefMode: s.briefMode || undefined,
    twinId: s.twinId,
    twinSettings: s.twinSettings,
    enableComputerUse: s.enableComputerUse || undefined,
    enableBrowserTools: s.enableBrowserTools || undefined,
    computerUseSettings: s.computerUseSettings,
    computerUseTarget:
      s.enableComputerUse && s.computerUseTarget && s.computerUseTarget !== "local"
        ? { connectionId: s.computerUseTarget }
        : undefined,
    sandboxEnabled: s.sandboxEnabled || undefined,
    sandboxTier: s.sandboxTier === "inherit" ? undefined : s.sandboxTier,
    accountIdOverride: s.accountIdOverride === "inherit" ? undefined : s.accountIdOverride,
    // Written even when undefined, so switching back to the app default
    // clears a stored runtime instead of leaving it in place.
    runtime: s.runtime,
    persona: buildPersona({
      tone: s.personaTone,
      personality: s.personaPersonality,
      openingMessage: s.openingMessage,
      exemplarPromptsText: s.exemplarPromptsText,
    }),
    voiceProfile: buildVoiceProfile({
      provider: s.voiceProvider,
      voiceId: s.voiceId,
      rate: s.voiceRate,
      pitch: s.voicePitch,
      volume: s.voiceVolume,
    }),
    avatarImage: s.avatarImageDataUrl ? { webDataUrl: s.avatarImageDataUrl } : undefined,
    availableOnPlatforms: s.availablePlatforms.length > 0 ? s.availablePlatforms : undefined,
    // Every override key is written, `undefined` included: an override the
    // user switched back to "inherit" has to clear the stored value.
    ...pickAgentOverrides(s.overrides),
  }
}

/** Split a comma- or newline-separated tool list into trimmed names. */
export function parseToolChips(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}
