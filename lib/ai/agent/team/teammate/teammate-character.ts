/**
 * Teammate → Character bridge (ADR-0022 addendum).
 *
 * The Agent Team's `AgentTeammate` has no `characterId`, but the only
 * tool-enabled execution path (`runAndCaptureAssistantReply` via the Tauri
 * sidecar) resolves its `SendOptions` from a `Character`. This module
 * synthesizes an **in-memory** `Character` from a teammate's config plus its
 * resolved plugin-capability bundle, so a teammate dispatch can ride the full
 * `resolveSendOptions` pipeline (skills / MCP / native tools / twin / A2UI /
 * provider routing) — far more complete than the chat-`Team` `memberOverride`
 * surface, which only covers model / systemPrompt / allowedTools / mcpServers.
 *
 * The synthesized character is never persisted; it is passed directly as
 * `BuildOptionsContext.character`. Subagents are enabled separately by giving
 * the dispatch session `kind: "team"` (see build-options.ts:1198), which unions
 * the team-context subagent registry.
 */

import type { Character } from "@cognia/agent-config-types"
import type { AgentTeam, AgentTeammate, ResolvedCapabilities } from "@/types/agent/agent-team"
import { clampSandboxPolicy } from "@/lib/sandbox/policy-bridge"

/** Stable synthetic character id for a teammate. Never looked up in the DB. */
export function teammateCharacterId(teammate: Pick<AgentTeammate, "id">): string {
  return `__teammate__:${teammate.id}`
}

const DEFAULT_TEAMMATE_SYSTEM_PROMPT =
  "You are a focused, helpful agent teammate. Stay on-task and produce concrete output."

export interface TeammateCharacterInput {
  team: Pick<AgentTeam, "name" | "config">
  teammate: AgentTeammate
  resolvedCaps: ResolvedCapabilities
  /** Absolute repo path the teammate's tools are scoped to. */
  cwd?: string
  /** Model preference from the run's ModelPreferenceController, if any. */
  modelHint?: string
}

/**
 * Build an in-memory `Character` for a teammate dispatch.
 *
 * Capability mapping:
 *  - `mcpServerIds`         ← `resolvedCaps.mcpServerIds` (empty → undefined =
 *                             inherit the default "all enabled servers")
 *  - `skillIds`/`pluginSkillIds` ← `resolvedCaps.skillIds` set on BOTH fields;
 *    each resolver in `resolveSendOptions` silently drops ids it doesn't own,
 *    so a skill is never lost regardless of whether it is a host or plugin skill.
 *  - `enableComputerUse` + `computerUseSettings.allowedToolIds`
 *                           ← `resolvedCaps.nativeAnthropicToolIds` (when any)
 *  - `allowedTools`         ← `teammate.config.tools`
 *  - `workingDir`           ← `cwd`
 *  - `twinId` / `twinSettings` ← `teammate.config.{twinId,twinSettings}` (ADR-0003).
 *    Setting `twinId` is what makes the `resolveSendOptions` twin branch fire for
 *    a teammate — the dispatch (`dispatch-teammate.ts`) additionally threads the
 *    per-run `twinDeps` + the task prompt so the twin's persona + per-task RAG
 *    knowledge inject. Without this the twin branch is unreachable for teams.
 *  - subagents (`resolvedCaps.subagentIds`) are enabled at the session level
 *    (`kind: "team"`), not here, since `Character` has no subagent field.
 */
export function teammateToCharacter(input: TeammateCharacterInput): Character {
  const { team, teammate, resolvedCaps, cwd, modelHint } = input

  const systemPrompt =
    teammate.config?.systemPrompt?.trim() ||
    team.config?.defaultSystemPrompt?.trim() ||
    DEFAULT_TEAMMATE_SYSTEM_PROMPT

  const model = modelHint || teammate.config?.model || team.config?.defaultModel
  const providerId = teammate.config?.provider || team.config?.defaultProvider

  const mcpServerIds =
    resolvedCaps.mcpServerIds.length > 0 ? [...resolvedCaps.mcpServerIds] : undefined

  const skillIds = resolvedCaps.skillIds.length > 0 ? [...resolvedCaps.skillIds] : undefined

  const allowedTools =
    teammate.config?.tools && teammate.config.tools.length > 0
      ? [...teammate.config.tools]
      : undefined

  const enableComputerUse = resolvedCaps.nativeAnthropicToolIds.length > 0

  // OS sandbox (ADR-0028): a teammate opt-in beats the team default; the
  // teammate's own policy is clamped DOWN to the team ceiling (monotonic — a
  // teammate can only narrow the writable roots / network / caps, never widen).
  // Setting these on the synthesized Character is what activates the existing
  // `resolveSendOptions` sandbox gate for a teammate dispatch.
  const sandboxEnabled = teammate.config?.sandboxEnabled ?? team.config?.sandboxEnabled ?? false
  const sandboxPolicy = clampSandboxPolicy(
    team.config?.sandboxPolicy,
    teammate.config?.sandboxPolicy
  )

  const ts = Date.now()
  const character: Character = {
    id: teammateCharacterId(teammate),
    name: teammate.name,
    description: teammate.description,
    // Avatar fields are display-only and never surface for a headless dispatch,
    // but `Character.avatarColor` is required — give it a stable neutral token.
    avatarColor: "oklch(0.6 0 0)",
    systemPrompt,
    createdAt: ts,
    updatedAt: ts,
    ...(model ? { model } : {}),
    ...(providerId ? { providerId } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(mcpServerIds ? { mcpServerIds } : {}),
    ...(skillIds ? { skillIds, pluginSkillIds: skillIds } : {}),
    ...(cwd ? { workingDir: cwd } : {}),
    ...(teammate.config?.twinId ? { twinId: teammate.config.twinId } : {}),
    ...(teammate.config?.twinId && teammate.config.twinSettings
      ? { twinSettings: teammate.config.twinSettings }
      : {}),
    enableComputerUse,
    ...(enableComputerUse
      ? { computerUseSettings: { allowedToolIds: [...resolvedCaps.nativeAnthropicToolIds] } }
      : {}),
    ...(sandboxEnabled ? { sandboxEnabled: true } : {}),
    ...(sandboxEnabled && sandboxPolicy ? { sandboxPolicy } : {}),
  }

  return character
}
