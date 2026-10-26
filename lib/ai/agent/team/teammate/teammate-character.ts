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
 *
 * A teammate can also be backed by a saved agent: the first id of its resolved
 * `characterPackIds` (a user agent, a variant or a plugin-pack character). The
 * dispatch resolves that agent's effective profile and passes it as
 * `baseAgent`; the teammate then runs on that profile, with its own explicit
 * settings and the team's capability lists layered on top.
 */

import type { Character } from "@cognia/agent-config-types"
import { materializeVariantProfile } from "@cognia/agent-config-types/agent-variant"
import type { AgentTeam, AgentTeammate, ResolvedCapabilities } from "@/types/agent/agent-team"
import { clampSandboxPolicy } from "@/lib/sandbox/policy-bridge"
import { resolvePrompt } from "@/lib/prompts/resolve"
import { definePrompt } from "@/lib/prompts/types"

/** Stable synthetic character id for a teammate. Never looked up in the DB. */
export function teammateCharacterId(teammate: Pick<AgentTeammate, "id">): string {
  return `__teammate__:${teammate.id}`
}

/**
 * The canned identity a teammate runs as when nothing more specific names one
 * (ADR-0236). Editable; it is the last fallback of {@link teammateSystemPrompt}.
 */
export const DEFAULT_TEAMMATE_IDENTITY_PROMPT = definePrompt({
  id: "team.teammate.default-identity",
  contractVersion: 1,
  kind: "role",
  group: "team",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app", "cli"],
  maxChars: 8_000,
  outputContract:
    "A teammate's system prompt when the dispatch, the teammate, its backing agent and the team all leave it unset.",
  consumers: ["lib/ai/agent/team/teammate/teammate-character.ts"],
  defaultBody:
    "You are a focused, helpful agent teammate. Stay on-task and produce concrete output.",
})

export interface TeammateCharacterInput {
  team: Pick<AgentTeam, "name" | "config"> & Partial<Pick<AgentTeam, "projectId">>
  teammate: AgentTeammate
  resolvedCaps: ResolvedCapabilities
  /** Absolute repo path the teammate's tools are scoped to. */
  cwd?: string
  /** Model preference from the run's ModelPreferenceController, if any. */
  modelHint?: string
  /**
   * Effective profile of the saved agent backing this teammate (the first id
   * of `resolvedCaps.characterPackIds`, resolved by the dispatch). Absent for
   * a teammate defined only by its own config.
   */
  baseAgent?: Character
}

/** The id of the saved agent a teammate runs as, if its capabilities name one. */
export function teammateBaseAgentId(resolvedCaps: ResolvedCapabilities): string | undefined {
  return resolvedCaps.characterPackIds[0]
}

/**
 * A teammate's system prompt. Most specific first: the dispatch's own prompt,
 * the teammate's, the backing agent's, the team default, then the canned one.
 *
 * Synchronous because the turn router projects a member's persona inside a
 * sync function; the canned identity resolves from the loaded override
 * snapshot (the app-wide initializer keeps it loaded), and only when it is
 * actually the prompt in use.
 */
export function teammateSystemPrompt(input: {
  team: Pick<AgentTeam, "config"> & Partial<Pick<AgentTeam, "projectId">>
  teammate: Pick<AgentTeammate, "config">
  baseAgent?: Pick<Character, "systemPrompt">
  override?: string
}): string {
  return (
    input.override?.trim() ||
    input.teammate.config?.systemPrompt?.trim() ||
    input.baseAgent?.systemPrompt?.trim() ||
    input.team.config?.defaultSystemPrompt?.trim() ||
    resolvePrompt(DEFAULT_TEAMMATE_IDENTITY_PROMPT, {
      context: input.team.projectId ? { workspaceId: input.team.projectId } : {},
    }).text
  )
}

function unionIds(
  base: readonly string[] | undefined,
  extra: readonly string[]
): string[] | undefined {
  const ids = [...new Set([...(base ?? []), ...extra])]
  return ids.length > 0 ? ids : undefined
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
 *  - subagents (`resolvedCaps.subagentIds`) are not a `Character` field: the
 *    team session (`kind: "team"`) registers the team surface, and the dispatch
 *    narrows it with a `subagents.only` capability grant (ADR-0198).
 */
export function teammateToCharacter(input: TeammateCharacterInput): Character {
  const { team, teammate, resolvedCaps, cwd, modelHint, baseAgent } = input

  const systemPrompt = teammateSystemPrompt({ team, teammate, baseAgent })

  const model = modelHint || teammate.config?.model || baseAgent?.model || team.config?.defaultModel
  const providerId =
    teammate.config?.provider || baseAgent?.providerId || team.config?.defaultProvider

  // The team's lists are what the team grants on top of the backing agent's
  // own. With no backing agent an empty list stays unset, which for MCP means
  // "every enabled server".
  const mcpServerIds =
    resolvedCaps.mcpServerIds.length > 0
      ? unionIds(baseAgent?.mcpServerIds, resolvedCaps.mcpServerIds)
      : baseAgent?.mcpServerIds
  const skillIds = unionIds(baseAgent?.skillIds, resolvedCaps.skillIds)
  const pluginSkillIds = unionIds(baseAgent?.pluginSkillIds, resolvedCaps.skillIds)

  const allowedTools =
    teammate.config?.tools && teammate.config.tools.length > 0
      ? [...teammate.config.tools]
      : baseAgent?.allowedTools

  const enableComputerUse =
    resolvedCaps.nativeAnthropicToolIds.length > 0 || baseAgent?.enableComputerUse === true

  // OS sandbox (ADR-0028): a teammate opt-in beats the team default, which
  // beats the backing agent's. The teammate's (or agent's) own policy is
  // clamped DOWN to the team ceiling (monotonic — a teammate can only narrow
  // the writable roots / network / caps, never widen). Setting these on the
  // synthesized Character is what activates the existing `resolveSendOptions`
  // sandbox gate for a teammate dispatch.
  const sandboxEnabled =
    teammate.config?.sandboxEnabled ??
    team.config?.sandboxEnabled ??
    baseAgent?.sandboxEnabled ??
    false
  const sandboxPolicy = clampSandboxPolicy(
    team.config?.sandboxPolicy,
    teammate.config?.sandboxPolicy ?? baseAgent?.sandboxPolicy
  )

  const twinId = teammate.config?.twinId ?? baseAgent?.twinId
  const twinSettings = teammate.config?.twinId
    ? teammate.config.twinSettings
    : baseAgent?.twinSettings

  const ts = Date.now()
  const character: Character = {
    // The backing agent's whole profile (knowledge bases, memory policy,
    // output style, execution policy, ...) first; every field below is either
    // identity or something the teammate or team decides.
    ...(baseAgent ? materializeVariantProfile(baseAgent) : {}),
    id: teammateCharacterId(teammate),
    name: teammate.name,
    description: teammate.description,
    // Avatar fields are display-only and never surface for a headless dispatch,
    // but `Character.avatarColor` is required — give it a stable neutral token.
    avatarColor: "oklch(0.6 0 0)",
    systemPrompt,
    createdAt: ts,
    updatedAt: ts,
  }
  const set = <K extends keyof Character>(key: K, value: Character[K] | undefined): void => {
    if (value === undefined) delete character[key]
    else character[key] = value
  }
  set("model", model || undefined)
  set("providerId", providerId || undefined)
  set("allowedTools", allowedTools ? [...allowedTools] : undefined)
  set("mcpServerIds", mcpServerIds ? [...mcpServerIds] : undefined)
  set("skillIds", skillIds)
  set("pluginSkillIds", pluginSkillIds)
  set("workingDir", cwd)
  set("twinId", twinId)
  set("twinSettings", twinId ? twinSettings : undefined)
  character.enableComputerUse = enableComputerUse
  set(
    "computerUseSettings",
    resolvedCaps.nativeAnthropicToolIds.length > 0
      ? {
          ...baseAgent?.computerUseSettings,
          allowedToolIds: [
            ...new Set([
              ...(baseAgent?.computerUseSettings?.allowedToolIds ?? []),
              ...resolvedCaps.nativeAnthropicToolIds,
            ]),
          ],
        }
      : enableComputerUse
        ? baseAgent?.computerUseSettings
        : undefined
  )
  set("sandboxEnabled", sandboxEnabled ? true : undefined)
  set("sandboxPolicy", sandboxEnabled ? sandboxPolicy : undefined)

  return character
}
