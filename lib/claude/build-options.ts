// Pure helper that resolves the final SendOptions for a turn by merging:
//   1. App-wide defaults (settings store)
//   2. Character config (if session.characterId is set)
//   3. Skills attached to that character (and not disabled on the session)
//   4. Per-session overrides (which always win)
//
// Lives in its own module so it can be imported from both the direct-chat
// hook and the team-chat hook, and unit-tested in Phase 6 without React.

import { getCharacter, listCharactersByIds } from "@/lib/db/characters"
import { listEnabledSkillsByIds, recordSkillUsage, renderSkillsSection } from "@/lib/db/skills"
import { buildMcpServerMap, listEnabledMcpServers } from "@/lib/db/mcp-servers"
import { getTeam } from "@/lib/db/teams"
import type {
  AppSettings,
  Character,
  ChatSession,
  SendOptions,
  Skill,
  Team,
  TeamMember,
} from "@/lib/claude/types"
import { BUILT_IN_AGENT_MODES, type AgentModeConfig } from "@/types/agent/agent-mode"
import { useAgentRuntimeStore } from "@/stores/agent"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { buildAgentModeSessionUpdate } from "@/lib/agent"
import { namespacedA2UIToolNames } from "@/lib/a2ui/mcp-tool-schemas"
import { A2UI_SYSTEM_PROMPT } from "@/lib/ai/prompts/a2ui-prompts"

export interface BuildOptionsContext {
  session?: ChatSession | null
  /** Override the resolving character — used by team chat per-member sends. */
  character?: Character | null
  appSettings?: AppSettings | null
  /**
   * Per-team-slot override applied on top of the character defaults. Only set
   * by the team chat hook; ignored when undefined. Override fields that are
   * left undefined fall through to the character's value as usual.
   */
  memberOverride?: TeamMember | null
  /**
   * Absolute paths the user has @-referenced in the composer. We pass each
   * file's parent directory (and folders themselves) to the SDK as
   * `additionalDirectories` so the Read tool can fetch them without prompting.
   * Caller is responsible for passing absolute paths (frontend resolves them
   * via `referencedPaths.absolute`).
   */
  referencedPaths?: { absolute: string; isDir: boolean }[]
  /**
   * Optional explicit Agent Mode override. When omitted, `resolveSendOptions`
   * reads the active mode id from `useAgentRuntimeStore` and looks it up in
   * the built-in or custom mode registries. Pass `null` to opt OUT of mode
   * application (e.g., diagnostics dumps).
   */
  agentMode?: AgentModeConfig | null
  /**
   * Optional twin runtime configuration. When BOTH this and `twinUserMessage`
   * are supplied AND the resolving character carries a `twinId`,
   * `resolveSendOptions` will invoke `applyTwinContext` and replace the base
   * character system prompt with the four-segment twin prompt (character +
   * identity + retrieved chunks + style few-shot). Mode / Skill sections still
   * append below.
   *
   * Importing the dep type lazily to avoid a hard cycle when build-options.ts
   * is loaded outside the twin runtime — the field is structurally typed so
   * tests / non-twin callers can omit it cleanly.
   */
  twinDeps?: TwinRuntimeDepsForBuild
  /**
   * The user's current message text. Required input to twin RAG; ignored when
   * `twinDeps` or `character.twinId` is missing.
   */
  twinUserMessage?: string
}

/**
 * Structural mirror of `lib/twin/runtime/apply-twin-context:ApplyTwinContextDeps`.
 * Keeping the shape inline here decouples build-options.ts from the twin
 * subsystem at type-resolution time so the chat-send hook only pays the cost
 * (importing twin code) when it actually opts in via `ctx.twinDeps`.
 */
export interface TwinRuntimeDepsForBuild {
  store: {
    searchByEmbedding?: (
      collection: string,
      embedding: number[],
      options?: { limit?: number }
    ) => Promise<Array<{ id: string; content: string; score: number }>>
  }
  embedding: {
    provider: "openai" | "google" | "cohere" | "mistral" | "transformersjs"
    model: string
    apiKey: string
    baseURL?: string
  }
  vectorBackend?: "qdrant" | "pinecone" | "milvus" | "weaviate" | "chroma"
  vectorCollection?: string
}

/**
 * Resolve the active Agent Mode by id from either the built-in registry or
 * the custom-mode store. Returns `undefined` when no mode is active or the
 * id is unknown.
 */
function resolveActiveAgentMode(modeId: string | undefined | null): AgentModeConfig | undefined {
  if (!modeId) return undefined
  const builtIn = BUILT_IN_AGENT_MODES.find((m) => m.id === modeId)
  if (builtIn) return builtIn
  // Custom modes live in a Zustand store that's persisted to localStorage.
  // Reading via getState() is safe here because this function only runs
  // client-side (it's called from React hooks).
  const custom = useCustomModeStore.getState().customModes[modeId]
  return custom
}

/**
 * Resolves the effective per-member configuration inside a team. Each override
 * field on `member` (when present) replaces the corresponding character
 * default; absent fields fall through. `mcpServerIdsOverride` further falls
 * through to the team-level MCP subset before defaulting to "all enabled".
 *
 * Pure: no I/O. Used both by `resolveSendOptions` and by UI surfaces that
 * preview a member's effective config.
 */
export function resolveMemberConfig(
  team: Team,
  member: TeamMember,
  character: Character
): {
  systemPrompt?: string
  model?: string
  allowedTools?: string[]
  mcpServerIds?: string[]
} {
  return {
    systemPrompt: member.systemPromptOverride ?? character.systemPrompt,
    model: member.modelOverride ?? character.model,
    allowedTools: member.allowedToolsOverride ?? character.allowedTools,
    mcpServerIds: member.mcpServerIdsOverride ?? character.mcpServerIds ?? team.mcpServerIds,
  }
}

/**
 * Resolves the final SendOptions for a chat turn.
 *
 * Precedence for each field is: per-session override > character > app default.
 * Skills are appended to whichever system prompt won that contest (under
 * `\n\n---\n\n` to keep them visually separate from the persona prompt).
 *
 * Tool whitelist semantics: character.allowedTools and skill.allowedTools are
 * UNIONED. If neither character nor skills declare any allowed tools, the
 * field is omitted (= use the SDK's default which is "everything").
 */
export async function resolveSendOptions(ctx: BuildOptionsContext): Promise<SendOptions> {
  const { session, appSettings, memberOverride } = ctx
  const opts: SendOptions = {}

  // --- Resolve the active character -----------------------------------------
  let character = ctx.character ?? null
  if (!character && session?.characterId) {
    character = (await getCharacter(session.characterId)) ?? null
  }

  // --- Resolve skills attached to this character (minus session-disables) --
  // Honour the per-skill `status` flag — disabled skills don't get appended,
  // even if the character references them. Non-fatal: a missing/legacy row
  // that has no status is treated as "enabled".
  let skills: Skill[] = []
  if (character?.skillIds?.length) {
    const disabled = new Set(session?.disabledSkillIds ?? [])
    const wantedIds = character.skillIds.filter((id) => !disabled.has(id))
    skills = await listEnabledSkillsByIds(wantedIds)
  }
  // Bump usage counters for the skills that actually made it into the prompt.
  // Fire-and-forget: a failed write here shouldn't block the send.
  if (skills.length > 0) {
    void recordSkillUsage(skills.map((s) => s.id)).catch(() => undefined)
  }

  // --- Agent Mode (built-in / custom) -------------------------------------
  // Reads the active mode id from `useAgentRuntimeStore` unless ctx supplies
  // an explicit override. Modes are a *prompt modifier* — their systemPrompt
  // appends to the base prompt (under the same `---` separator as skills) and
  // their tools union into the allowedTools whitelist.
  let activeMode: AgentModeConfig | undefined
  if (ctx.agentMode === null) {
    activeMode = undefined
  } else if (ctx.agentMode) {
    activeMode = ctx.agentMode
  } else {
    activeMode = resolveActiveAgentMode(useAgentRuntimeStore.getState().modeId)
  }

  // Centralize mode-derived session fields through the shared helper. The
  // returned `model` is whatever the (possibly custom) mode declares; we
  // surface it below as one input to the model precedence.
  const modeUpdate = activeMode ? buildAgentModeSessionUpdate(activeMode) : undefined

  // --- Model: per-session > member override > mode override > character > app default ------
  const model =
    session?.model ??
    memberOverride?.modelOverride ??
    modeUpdate?.model ??
    character?.model ??
    appSettings?.defaultModel
  if (model) opts.model = model

  // --- System prompt + skills section --------------------------------------
  // Member override replaces the character system prompt (skills still append).
  let baseSystem =
    session?.systemPrompt ??
    memberOverride?.systemPromptOverride ??
    character?.systemPrompt ??
    appSettings?.defaultSystemPrompt ??
    undefined

  // --- Twin runtime injection (opt-in) -------------------------------------
  // When the resolving character is twin-bound AND the caller supplied
  // `twinDeps` + `twinUserMessage`, replace `baseSystem` with the four-segment
  // twin prompt. The runtime never throws — failures degrade to a no-context
  // prompt, matching the rest of the resolver's "best effort" semantics.
  if (character?.twinId && ctx.twinDeps && ctx.twinUserMessage && ctx.twinUserMessage.trim()) {
    try {
      const { applyTwinContext } = await import("@/lib/twin/runtime")
      const result = await applyTwinContext({
        character,
        userMessage: ctx.twinUserMessage,
        deps: ctx.twinDeps as Parameters<typeof applyTwinContext>[0]["deps"],
      })
      if (result.applied) {
        baseSystem = result.applied.systemPrompt
      }
    } catch {
      // Twin runtime failure is non-fatal — keep the original baseSystem.
    }
  }

  const skillSection = renderSkillsSection(skills)
  const modeSection = activeMode?.systemPrompt?.trim() || ""
  const systemPrompt = [baseSystem, modeSection, skillSection]
    .filter((p) => p && p.trim().length > 0)
    .join("\n\n---\n\n")
  if (systemPrompt) opts.systemPrompt = systemPrompt

  // --- Working directory ---------------------------------------------------
  const cwd = session?.workingDir ?? character?.workingDir ?? appSettings?.defaultWorkingDir
  if (cwd) opts.cwd = cwd

  // --- Additional directories from @-referenced files/folders --------------
  // For folders we add the folder itself; for files we add their parent dir.
  // Deduplicate, drop empty/nullish entries, and skip when nothing to add.
  if (ctx.referencedPaths && ctx.referencedPaths.length > 0) {
    const dirs = new Set<string>()
    for (const ref of ctx.referencedPaths) {
      if (!ref.absolute) continue
      if (ref.isDir) {
        dirs.add(ref.absolute)
      } else {
        const sep = ref.absolute.includes("\\") ? "\\" : "/"
        const idx = ref.absolute.lastIndexOf(sep)
        if (idx > 0) dirs.add(ref.absolute.slice(0, idx))
      }
    }
    if (dirs.size > 0) opts.additionalDirectories = [...dirs]
  }

  // --- Permission mode -----------------------------------------------------
  // Per-session override (set via the composer's Shift+Tab cycle) wins, then
  // the character's mode, then the app default. Composer always writes a
  // concrete mode when toggled, so once a user opts in it sticks.
  const permissionMode =
    session?.permissionMode ?? character?.permissionMode ?? appSettings?.permissionMode
  if (permissionMode) opts.permissionMode = permissionMode

  // --- Tool whitelist/blacklist --------------------------------------------
  // Member override REPLACES the character's allowedTools (does not union).
  // Skills still contribute their tools so an override doesn't accidentally
  // strip a skill's required permissions.
  const allowed = new Set<string>()
  const baseAllowed = memberOverride?.allowedToolsOverride ?? character?.allowedTools
  for (const t of baseAllowed ?? []) allowed.add(t)
  for (const sk of skills) for (const t of sk.allowedTools ?? []) allowed.add(t)
  // Agent mode tools union in too — picking "Code Generator" should grant
  // execute_code without forcing the user to also tweak the character.
  for (const t of activeMode?.tools ?? []) allowed.add(t)
  // A2UI: when the active scope opts in, fold the 4 bridge tools into the
  // whitelist + tack the A2UI system-prompt extension onto appendSystemPrompt
  // so the model knows when to paint surfaces. Resolution order matches the
  // rest of build-options: session > character > appSettings default.
  const a2uiEnabled =
    (session as { a2uiEnabled?: boolean } | undefined)?.a2uiEnabled ??
    character?.a2uiEnabled ??
    appSettings?.a2uiDefaultEnabled ??
    false
  if (a2uiEnabled) {
    for (const t of namespacedA2UIToolNames()) allowed.add(t)
  }

  if (allowed.size > 0) opts.allowedTools = [...allowed]
  if (character?.disallowedTools?.length) opts.disallowedTools = [...character.disallowedTools]

  if (a2uiEnabled) {
    const existing = opts.appendSystemPrompt?.trim() ?? ""
    opts.appendSystemPrompt = existing ? `${existing}\n\n${A2UI_SYSTEM_PROMPT}` : A2UI_SYSTEM_PROMPT
  }

  // --- MCP server subset ---------------------------------------------------
  // Resolution order:
  //   1. member override mcpServerIds (team chat only)
  //   2. character.mcpServerIds (if defined) → intersect with enabled
  //   3. team.mcpServerIds      (if team session, neither override nor char)
  //   4. fall back to all enabled servers
  try {
    const enabled = await listEnabledMcpServers()
    let chosen = enabled
    const memberMcp = memberOverride?.mcpServerIdsOverride

    if (memberMcp) {
      const wanted = new Set(memberMcp)
      chosen = enabled.filter((srv) => wanted.has(srv.id))
    } else if (character?.mcpServerIds) {
      const wanted = new Set(character.mcpServerIds)
      chosen = enabled.filter((srv) => wanted.has(srv.id))
    } else if (session?.kind === "team" && session.teamId) {
      const team = await getTeam(session.teamId)
      if (team?.mcpServerIds) {
        const wanted = new Set(team.mcpServerIds)
        chosen = enabled.filter((srv) => wanted.has(srv.id))
      }
    }

    if (chosen.length > 0) {
      opts.mcpServers = buildMcpServerMap(chosen)
    }
  } catch (err) {
    // Non-fatal — just skip MCP for this turn.
    console.warn("listEnabledMcpServers failed", err)
  }

  // --- Built-in tools (sidecar protocol field) ----------------------------
  // Forward the per-category toggles from app settings to the sidecar. The
  // sidecar consumes this field to build the in-process `cognia-tools` MCP
  // server and strips it before calling the SDK. Keeping this on every
  // SendOptions (rather than relying on settings IPC) means a per-session
  // override could later be added without changing the sidecar protocol.
  if (appSettings?.builtinTools) {
    opts.builtinTools = appSettings.builtinTools
  }

  // --- Resume continuity ---------------------------------------------------
  // The sidecar persists the SDK-issued `session_id` onto the ChatSession row
  // (see hooks/use-claude-chat.ts). Re-passing it as `resumeSessionId` on
  // every send is harmless — the sidecar only honours `resume` when it has to
  // start a fresh SDK Query (e.g. after a sidecar restart or app reload). When
  // an in-flight session already has streaming input wired up, options are
  // ignored. Skip on team sub-sessions and when the session is being forked.
  if (session?.sdkSessionId && !session?.forkedFromSdkSessionId) {
    opts.resumeSessionId = session.sdkSessionId
  }

  return opts
}

/**
 * Convenience: pre-resolve every team member's character row for the team
 * chat hook so it doesn't have to call getCharacter() per member.
 */
export async function listTeamMembers(memberCharacterIds: string[]): Promise<Character[]> {
  return listCharactersByIds(memberCharacterIds)
}
