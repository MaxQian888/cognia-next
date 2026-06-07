// Pure helper that resolves the final SendOptions for a turn by merging:
//   1. App-wide defaults (settings store)
//   2. Character config (if session.characterId is set)
//   3. Skills attached to that character (and not disabled on the session)
//   4. Per-session overrides (which always win)
//
// Lives in its own module so it can be imported from both the direct-chat
// hook and the team-chat hook, and unit-tested in Phase 6 without React.

import { primaryRootOf, additionalDirsOf } from "@/lib/workspace/roots"
import { RESTRICTED_MODE_DENIED_TOOLS } from "@/lib/workspace/restricted-tools"
import { resolveLspServers } from "@/lib/lsp/resolve-config"
import { readProjectLspFile } from "@/lib/lsp/project-file-reader"
import { resolveAccountEnv, resolveAccountId, resolveProxyEnv } from "@/lib/claude/env-resolver"
import { setActiveSandboxTier } from "@/lib/sandbox/microvm-bridge"
import { listCharactersByIds, resolveCharacterById } from "@/lib/db/characters"
import { listEnabledSkillsByIds, recordSkillUsage, renderSkillsSection } from "@/lib/db/skills"
import { recordPluginSkillUsage } from "@/lib/db/plugin-skill-usage"
import { buildMcpServerMap, listEnabledMcpServers } from "@/lib/db/mcp-servers"
import { getTeam } from "@/lib/db/teams"
import { isInQuietHours } from "@/lib/connectors/outbound-runner"
import { isOcrToolAllowed } from "@/lib/claude/ocr-tool-gate"
import { loggers } from "@/lib/logging"
import type {
  AppSettings,
  Character,
  ChatSession,
  SendOptions,
  Skill,
  Team,
  TeamMember,
} from "@/lib/claude/types"
import type { Project } from "@/types"
import { resolveMemoryConfig } from "@/types/memory/memory"
import type { ConnectorMode } from "@/types/connectors/policy"
import { BUILT_IN_AGENT_MODES, type AgentModeConfig } from "@/types/agent/agent-mode"
import { useAgentRuntimeStore } from "@/stores/agent"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { buildAgentModeSessionUpdate } from "@/lib/agent"
import { namespacedA2UIToolNames } from "@/lib/a2ui/mcp-tool-schemas"
import { A2UI_SYSTEM_PROMPT } from "@/lib/ai/prompts/a2ui-prompts"
import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
} from "@/lib/ai/provider-consumption"
import { buildModelInferenceParams } from "@/lib/ai/providers/inference-params"
import { processPromptTemplateVariables } from "@/stores/agent/custom-mode-store/helpers"
import {
  ProviderRoutingEngine,
  createMappingRegistry,
  type RoutingEngineDeps,
} from "@/lib/ai/routing"
import {
  applyCircuitConfigOverrides,
  buildRoutingEngineDeps,
} from "@/lib/ai/routing/build-preview-engine"
import { DEFAULT_ROUTING_CONFIG } from "@/types/provider/model-mapping"
import { estimateCJKTokenCount } from "@/lib/ai/rag/cjk-tokenizer"

/**
 * Snippet appended to `appendSystemPrompt` when brief mode is on. Exported so
 * the ACP route can reuse it when threading `briefMode` into a `session/new`
 * payload — keeping a single source of truth for the wording.
 */
export const BRIEF_OUTPUT_SNIPPET =
  "Respond concisely. Skip preamble, headers, and bullet-list filler. Direct answers only — match length to the question."

/**
 * Build the workflow-editor system-prompt snapshot block.
 *
 * Trimmed to <3KB so we don't blow the system-prompt budget on a
 * 200-node graph: only the envelope, node count, selection, and (for
 * up to 12 selected nodes) per-node detail. The agent gets the full
 * picture via wf_read_graph when it needs it.
 */
function buildWorkflowSnapshotBlock(
  workflowId: string,
  s: {
    baseWorkflow: { id: string; name?: string; description?: string }
    nodes: ReadonlyArray<{ id: string; data: { kind: string; label: string } }>
    edges: ReadonlyArray<unknown>
    selectedNodeIds: string[]
    runStatusByStepId: Record<string, string>
    validationByStepId: Record<string, unknown>
  }
): string {
  const lines: string[] = []
  lines.push("# Currently-open workflow")
  lines.push(`- workflowId: ${workflowId}`)
  lines.push(`- name: ${s.baseWorkflow.name ?? "(untitled)"}`)
  if (s.baseWorkflow.description) {
    lines.push(`- description: ${s.baseWorkflow.description}`)
  }
  lines.push(`- nodes: ${s.nodes.length}; edges: ${s.edges.length}`)
  const failingCount = Object.keys(s.validationByStepId).length
  if (failingCount > 0) lines.push(`- nodes failing validation: ${failingCount}`)
  const runningCount = Object.values(s.runStatusByStepId).filter((v) => v === "running").length
  if (runningCount > 0) lines.push(`- nodes currently running: ${runningCount}`)
  if (s.selectedNodeIds.length > 0) {
    lines.push(`- selection: ${s.selectedNodeIds.length} node(s)`)
    const detailLimit = 12
    const detailIds = s.selectedNodeIds.slice(0, detailLimit)
    for (const id of detailIds) {
      const node = s.nodes.find((n) => n.id === id)
      if (node) lines.push(`  - ${id} :: ${node.data.kind} :: ${node.data.label}`)
    }
    if (s.selectedNodeIds.length > detailLimit) {
      lines.push(`  - …and ${s.selectedNodeIds.length - detailLimit} more`)
    }
  }
  lines.push("")
  lines.push(
    "Use the wf_* MCP tools to read / mutate / lay out / run this workflow on the user's behalf. ALWAYS call wf_read_graph before referencing any node id you didn't just create."
  )
  return lines.join("\n")
}

export interface BuildOptionsContext {
  session?: ChatSession | null
  /** Override the resolving character — used by team chat per-member sends. */
  character?: Character | null
  appSettings?: AppSettings | null
  /**
   * The active workspace (project). Its `rootDir` feeds the cwd resolution
   * chain (between the session override and the character default) and its
   * `additionalDirs` are unioned into `additionalDirectories` alongside any
   * @-referenced paths. Direct chat passes the `useProjectStore` active
   * project; team/connector/diagnostics paths pass `null` to opt out.
   */
  activeProject?: Project | null
  /**
   * True when the active workspace has any untrusted root. Restricted Mode then
   * unions `RESTRICTED_MODE_DENIED_TOOLS` into `disallowedTools` (and strips
   * computer-use from the allow list). Only direct chat sets this; team/
   * connector paths leave it undefined (no restriction).
   */
  workspaceRestricted?: boolean
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
  /**
   * Pre-embedded vector for `twinUserMessage`. When provided, the twin runtime
   * skips its own embed call. Used by team chat to share one embed across
   * multiple twin-bound members per turn.
   */
  precomputedQueryEmbedding?: number[]
  /**
   * Optional hint for the routing engine's context-window pre-check: the
   * outgoing prompt text. A rough CJK-aware token estimate is derived from it
   * and alias entries whose window can't fit the input are deprioritized.
   * Absent → the check is skipped (no-info passthrough).
   */
  routingContextHint?: { promptText?: string }
  /**
   * Optional long-term memory runtime dependencies (ADR — autonomous memory).
   * When supplied AND `memoryUserMessage` is set AND `appSettings.memory` is
   * enabled (and not in temporary mode), `resolveSendOptions` invokes
   * `applyMemoryContext` and APPENDS a "What you remember about the user"
   * section to the system prompt — coexisting with, never replacing, the Twin
   * section. Built by `tryBuildMemoryDeps`. Structurally typed + lazily used so
   * non-memory callers omit it cleanly. Undefined → memory injection skipped.
   */
  memoryDeps?: import("@/lib/memory/runtime/apply-memory-context").ApplyMemoryContextDeps
  /**
   * The user's current message text for memory recall. Usually the same value
   * as `twinUserMessage`; kept separate so a caller can drive one without the
   * other. Ignored when `memoryDeps` is missing.
   */
  memoryUserMessage?: string
  /**
   * Per-message ephemeral skill ids unioned with the active character's
   * `skillIds`. The composer's SkillPicker drives this; the chat send hook
   * is expected to clear the store slice after dispatch. Disabled skills
   * and ids already on the character are de-duped at resolve time.
   */
  ephemeralSkillIds?: string[]
  /**
   * Active `/goal` for this session (ADR-0013). When set AND
   * `activeGoal.status === "active"`, the resolver appends a
   * `renderGoalSystemSection(activeGoal)` block to `opts.appendSystemPrompt`
   * — keeping `baseSystem` / character / skill / mode sections untouched.
   * The chat-send hook pulls this from Dexie via `useActiveGoal()`; team
   * chat passes `null` to opt out.
   */
  activeGoal?: import("@/types/goal").Goal | null
  /**
   * Active plan for this session (ADR-0045). When set AND
   * `activePlan.status === "executing"`, the resolver appends a
   * `renderPlanSystemSection(activePlan)` block to `opts.appendSystemPrompt`
   * — the same surgical append convention as `activeGoal`. The plan runtime's
   * in-session driver pulls this from Dexie via `getExecutingPlanForSession`;
   * non-plan sends pass `null` / undefined to opt out.
   */
  activePlan?: import("@/types/agent/plan").AgentPlan | null
  /**
   * Conversation key for connector-driven sends. Set by the connector
   * runtime when an inbound message kicks off an ai-run. Direct chat sends
   * leave this undefined. Currently only used for audit / metadata; the
   * gating logic lives in `inboxPolicy` so the resolver doesn't have to
   * fetch the override row itself.
   */
  conversationKey?: string
  /**
   * Pulls through verbatim from `ChatSession.platformBinding`. Same purpose
   * as `conversationKey` — context only, no behavioural impact at this
   * resolver layer.
   */
  platformBinding?: ChatSession["platformBinding"]
  /**
   * Inbox / connector policy facts the runtime gathers from the adapter row
   * (`quietHours`, `muted`) and the matching `ConversationOverrideRow`
   * (`mode === "manual"` → forcedMode). When any field hits, the resolver
   * stamps `opts.suppressedReason` and the runtime short-circuits the
   * sidecar call. `null` / undefined means "no inbox gating applies".
   *
   * Direct chat hooks pass undefined; only the connector ai-run path sets
   * this. The resolver does not fetch any of these facts itself — the
   * runtime owns the lookup so the gate stays one-stop.
   */
  inboxPolicy?: InboxSendPolicy | null
}

/**
 * Aggregate of inbox / connector facts evaluated by `resolveSendOptions`
 * to decide whether the send should be suppressed. Constructed by the
 * connector runtime from `AdapterInstanceRow.{quietHours,muted}` plus the
 * matching `ConversationOverrideRow.mode`. Never set by direct chat sends.
 */
export interface InboxSendPolicy {
  /** Quiet-hours window from the adapter row. Undefined = always allowed. */
  quietHours?: { from: string; to: string; tz: string }
  /** Adapter-wide global mute switch from the adapter row. */
  muted?: boolean
  /**
   * The conversation override's mode. When `"manual"` we suppress an
   * ai-run ahead of any other gate so the user owns the reply. `"auto"` /
   * `"draft"` / `undefined` do not suppress here — they are handled
   * elsewhere in the runtime (`mode-router`, `draft-prepare`, etc.).
   */
  forcedMode?: ConnectorMode
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
  vectorBackend?: "qdrant" | "pinecone" | "milvus" | "weaviate" | "chroma" | "native"
  vectorCollection?: string
  /**
   * Optional RAG reranker. When present, applyTwinContext over-fetches a wider
   * candidate pool and re-scores it with `scorer` before keeping top-K. Shape
   * mirrors `apply-twin-context:ApplyTwinContextDeps.reranker` structurally
   * (kept inline so build-options stays decoupled from the twin module).
   */
  reranker?: {
    model?: string
    overFetch?: number
    timeoutMs?: number
    scorer?: (
      query: string,
      candidate: { id: string; content: string; score: number; sourceTitle?: string }
    ) => number | Promise<number>
  }
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
    // ADR-0030: resolveCharacterById falls through to the plugin-overlay
    // pack registry when the id is a synthetic `cognia-pack:` runtime id,
    // so a session bound to a plugin-contributed character keeps working
    // without a Dexie row.
    character = (await resolveCharacterById(session.characterId)) ?? null
  }

  // --- Resolve skills: character.skillIds ∪ ephemeralSkillIds, minus session-disables.
  // Honour the per-skill `status` flag — disabled skills don't get appended,
  // even if the character references them or the user attached them ad-hoc.
  // Non-fatal: a missing/legacy row that has no status is treated as enabled.
  let skills: Skill[] = []
  const characterSkillIds = character?.skillIds ?? []
  const ephemeralIds = ctx.ephemeralSkillIds ?? []
  if (characterSkillIds.length || ephemeralIds.length) {
    const disabled = new Set(session?.disabledSkillIds ?? [])
    const seen = new Set<string>()
    const wantedIds: string[] = []
    for (const id of [...characterSkillIds, ...ephemeralIds]) {
      if (disabled.has(id)) continue
      if (seen.has(id)) continue
      seen.add(id)
      wantedIds.push(id)
    }
    if (wantedIds.length) {
      skills = await listEnabledSkillsByIds(wantedIds)
    }
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

  // --- IM per-channel override (ADR-0009 v41 / A6) ------------------------
  // For IM-bound sessions, look up the ConversationOverrideRow once up-front
  // so its `providerOverride` / `modelOverride` fields can sit at the very
  // top of the model + provider precedence chains. The same row is reused
  // later for the computer-use gate (line ~648) — fetching it once here is
  // cheaper than two separate reads, and keeping the read at the top makes
  // the precedence ordering legible.
  //
  // The IM channel's override is intentionally above `session.providerOverride`
  // because users edit it from the inbox header at runtime, where the
  // ChatSession may have been minted weeks ago with a stale `providerOverride`.
  let imOverrideRow:
    | Awaited<ReturnType<typeof import("@/lib/db/conversation-overrides").readForResolution>>
    | undefined
  if (session?.platformBinding?.adapterId && session.platformBinding.conversationKey) {
    try {
      const { readForResolution } = await import("@/lib/db/conversation-overrides")
      imOverrideRow = await readForResolution(session.platformBinding.conversationKey)
    } catch {
      // Best-effort — missing override row / stale Dexie shouldn't crash the
      // send; fall back to the session/character/app chain.
    }
  }
  const imProviderOverride = imOverrideRow?.providerOverride
  const imModelOverride = imOverrideRow?.modelOverride

  // --- Model: IM channel override > per-session > member override > mode override > character > app default ------
  let model: string | undefined =
    imModelOverride ??
    session?.model ??
    memberOverride?.modelOverride ??
    modeUpdate?.model ??
    character?.model ??
    appSettings?.defaultModel

  // --- Provider: IM channel override > per-session override > character > app default > "anthropic" -----
  // The sidecar uses `provider` to pick which dispatcher (`anthropic` vs the
  // generic `ai-sdk` runner) to invoke. Credentials travel inline so the
  // sidecar never reads keys from disk. Resolution is best-effort: when the
  // selected provider has no key configured we leave both fields off and
  // let the sidecar fall back to ANTHROPIC_API_KEY (legacy path).
  let providerId =
    imProviderOverride ??
    session?.providerOverride ??
    character?.providerId ??
    appSettings?.defaultProvider ??
    "anthropic"

  // --- Alias resolution (P4) ------------------------------------------------
  // When `model` matches a registered alias (e.g., "fast", "coding"), run
  // it through the routing engine to pick a concrete provider:model from
  // the alias's fallback chain. The decision metadata is stamped on
  // `opts.aliasResolution` + `opts.routingDecision` so the renderer
  // adapter can retry on failure (P4 fallback path) and the message
  // metadata badge can show what was actually used.
  if (model && appSettings?.modelMappings && appSettings.modelMappings.length > 0) {
    const registry = createMappingRegistry(appSettings.modelMappings)
    const routingConfig = appSettings.routingConfig ?? DEFAULT_ROUTING_CONFIG
    // Per-provider circuit overrides (allowed_fails / cooldown_time) apply
    // before the engine consults breaker state. Idempotent merge.
    applyCircuitConfigOverrides(routingConfig.providerConstraints)
    // Live-store-backed deps shared with the routing-tab preview panel —
    // health metrics, circuit breaker, today-spend mirror, rate window,
    // pricing, and the context-window resolver all live in
    // `lib/ai/routing/build-preview-engine.ts`.
    const deps: RoutingEngineDeps = buildRoutingEngineDeps(appSettings)
    // Rough token estimate of the outgoing prompt (CJK-aware). Only the text
    // the caller handed us — history/system additions are not counted, which
    // keeps the check conservative-but-cheap (O(prompt length), no awaits).
    const promptText = ctx.routingContextHint?.promptText ?? ctx.twinUserMessage
    const estimatedInputTokens =
      promptText && promptText.length > 0 ? estimateCJKTokenCount(promptText) : undefined
    const engine = new ProviderRoutingEngine(registry, routingConfig, deps)
    const result = engine.selectProvider({ model, estimatedInputTokens, promptText })
    if (result?.fromAlias && result.alias) {
      model = result.modelId
      providerId = result.providerId
      opts.aliasResolution = {
        alias: result.alias,
        resolvedTo: { providerId: result.providerId, modelId: result.modelId },
        fallbackEntries: result.fallbackEntries,
        // Flatten the strongly-typed ModelMappingParameterDefaults into the
        // opaque map the SendOptions wire shape carries. The renderer + Rust
        // struct treat this as metadata only; the sidecar ignores it.
        parameterDefaults: result.parameterDefaults as Record<string, unknown> | undefined,
        // Error-class routing metadata: the renderer retry path acts on
        // these without a registry lookup.
        ...(result.specialFallbacks ? { specialFallbacks: result.specialFallbacks } : {}),
        ...(result.retryPolicy ? { retryPolicy: result.retryPolicy } : {}),
      }
      opts.routingDecision = {
        strategy: result.strategy,
        reason: result.reason,
        ...(result.overBudgetWarning ? { overBudgetWarning: result.overBudgetWarning } : {}),
      }
    }
  }

  if (model) opts.model = model
  if (providerId) {
    opts.provider = providerId
    if (appSettings) {
      const snapshot = createProviderSettingsSnapshot({
        defaultProvider: appSettings.defaultProvider,
        providerSettings: appSettings.providerSettings as
          | Record<string, import("@/lib/ai/provider-consumption").ProviderSettingsEntry>
          | undefined,
        customProviders: appSettings.customProviders as
          | import("@/lib/ai/provider-consumption").RichCustomProviderEntry[]
          | undefined,
      })
      const resolution = resolveFeatureProvider(
        {
          featureId: "chat-send",
          routeProfile: "general-text",
          selectionMode: "explicit-provider",
          providerId,
          fallbackMode: "none",
        },
        snapshot
      )
      if (resolution.kind === "resolved") {
        opts.providerCredentials = {
          apiKey: resolution.apiKey,
          baseURL: resolution.baseURL,
          // Always forward the resolved protocol. The resolver is the single
          // authority on which AI SDK family a provider speaks; relying on the
          // sidecar to re-derive it from the id silently broke built-in local
          // providers (ollama / lmstudio / …) and the openai-compat aggregators
          // (xai / togetherai / fireworks). The Anthropic path selects by id,
          // so forwarding "anthropic" is inert there.
          protocol: resolution.protocol,
        }
        // Backfill model from the provider's default when the caller didn't
        // pin one — keeps the resolver one-stop for "what should this turn
        // run against?".
        if (!opts.model && resolution.model) {
          opts.model = resolution.model
        }
        // Carry the provider's configured inference defaults (temperature,
        // maxOutputTokens, penalties, …) so the non-Anthropic ai-sdk dispatcher
        // honours them instead of dropping every knob. The Anthropic path
        // ignores `modelParams` (ADR-0043).
        const providerCfg =
          appSettings?.providerSettings?.[providerId] ??
          appSettings?.customProviders?.find((p) => p.id === providerId)
        const modelParams = buildModelInferenceParams(providerCfg)
        if (modelParams) opts.modelParams = modelParams
      }
      // Unresolved providers (no key, disabled, etc.) fall through with
      // `opts.provider` set but no credentials — for "anthropic" that means
      // the sidecar still works via the legacy ANTHROPIC_API_KEY env path
      // (back-compat). For any other provider the sidecar emits a clean
      // "missing credential" session_ended and the picker UI can surface it.
    }
  }

  // --- System prompt + skills section --------------------------------------
  // Member override replaces the character system prompt (skills still append).
  let baseSystem =
    session?.systemPrompt ??
    memberOverride?.systemPromptOverride ??
    character?.systemPrompt ??
    appSettings?.defaultSystemPrompt ??
    undefined

  // Tracks whether the twin runtime replaced `baseSystem` below. When it did,
  // the twin prompt already encodes personality, so the v2 persona section
  // (tone / personality) is suppressed to avoid contradictory guidance.
  let twinReplacedBase = false

  // --- Cache-friendly prompt assembly (experimental, default off) ----------
  // When enabled, per-turn dynamic sections (twin retrieved chunks + style
  // few-shot, memory recall) are collected here instead of being woven into
  // `systemPrompt`, and appended at the very END of `appendSystemPrompt`.
  // This keeps the leading prompt prefix byte-stable across turns so
  // provider prompt caches (DeepSeek context caching on disk, OpenAI
  // automatic caching, Anthropic cache_control) keep hitting. When the flag
  // is off this array stays empty and assembly is byte-identical to the
  // legacy path.
  const cacheOptimizationEnabled = appSettings?.cacheOptimizationEnabled === true
  const dynamicTailSections: string[] = []
  // Forward the flag so the sidecar's ai-sdk dispatcher can place an
  // explicit anthropic cacheControl breakpoint on the stable segment.
  if (cacheOptimizationEnabled) opts.cacheOptimizationEnabled = true

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
        precomputedQueryEmbedding: ctx.precomputedQueryEmbedding,
        deps: ctx.twinDeps as Parameters<typeof applyTwinContext>[0]["deps"],
      })
      if (result.applied) {
        if (cacheOptimizationEnabled && result.applied.cacheSegments?.dynamic) {
          // Stable twin segments (character prompt + identity) stay in the
          // prefix; per-turn RAG chunks + style few-shot move to the tail.
          baseSystem = result.applied.cacheSegments.stable
          dynamicTailSections.push(result.applied.cacheSegments.dynamic)
        } else {
          baseSystem = result.applied.systemPrompt
        }
        twinReplacedBase = true
      }
      // Stash the retrieved context for the chat hook so it can render a
      // Twin SourcesPart on the assistant message. Always attached when the
      // runtime ran (even if degraded) so the UI can show a "no context"
      // indicator instead of staying silent.
      if (
        result.retrievedChunks.length > 0 ||
        result.selectedStyleSamples.length > 0 ||
        result.degraded
      ) {
        opts.twinContext = {
          twinId: character.twinId,
          retrievedChunks: result.retrievedChunks,
          selectedStyleSamples: result.selectedStyleSamples.map((s) => ({
            id: s.id,
            contextLabel: s.contextLabel,
            summary: s.summary,
            tone: s.tone,
          })),
          degraded: result.degraded,
        }
      }
    } catch {
      // Twin runtime failure is non-fatal — keep the original baseSystem.
    }
  }

  // --- Long-term memory injection (opt-in) ---------------------------------
  // When `memoryDeps` + `memoryUserMessage` are supplied and memory is enabled
  // (and not in temporary mode), recall semantic/episodic facts + the learned
  // procedural block and APPEND them as a dedicated section. This coexists with
  // the Twin section (Twin = persona, Memory = durable user facts) — it never
  // replaces `baseSystem`. The runtime never throws; failures degrade silently.
  let memorySection = ""
  if (ctx.memoryDeps && ctx.memoryUserMessage && ctx.memoryUserMessage.trim()) {
    const memoryConfig = resolveMemoryConfig(appSettings?.memory)
    if (memoryConfig.enabled && !memoryConfig.temporary) {
      try {
        const { applyMemoryContext } = await import("@/lib/memory/runtime/apply-memory-context")
        const twinChunkTexts = opts.twinContext?.retrievedChunks.map((c) => c.chunk.content) ?? []
        const result = await applyMemoryContext({
          userMessage: ctx.memoryUserMessage,
          characterId: character?.id,
          topK: memoryConfig.retrievalTopK,
          relevanceFloor: memoryConfig.relevanceFloor,
          twinChunkTexts,
          deps: ctx.memoryDeps,
        })
        if (result.systemPromptSection) {
          if (cacheOptimizationEnabled) {
            // Query-dependent recall changes every turn — keep it out of the
            // cacheable prefix and append it to the dynamic tail instead.
            dynamicTailSections.push(result.systemPromptSection)
          } else {
            memorySection = result.systemPromptSection
          }
        }
        if (result.retrievedMemories.length > 0 || result.proceduralCount > 0 || result.degraded) {
          opts.memoryContext = {
            retrievedMemories: result.retrievedMemories.map((m) => ({
              id: m.id,
              type: m.type,
              text: m.text,
              score: m.score,
            })),
            proceduralCount: result.proceduralCount,
            degraded: result.degraded,
          }
        }
      } catch {
        // Memory runtime failure is non-fatal — keep the prompt as-is.
      }
    }
  }

  const skillSection = renderSkillsSection(skills)
  // Substitute agent-mode prompt template variables ({{date}} / {{tools_list}} /
  // {{mode_name}} / …) the custom-mode editor advertises — without this the
  // literal `{{…}}` tokens are sent to the model verbatim.
  const rawModeSection = activeMode?.systemPrompt?.trim() || ""
  const modeSection = rawModeSection
    ? processPromptTemplateVariables(rawModeSection, {
        modeName: activeMode?.name,
        modeDescription: activeMode?.description,
        tools: activeMode?.tools,
      })
    : ""

  // --- Plugin-contributed skills (M4) -------------------------------------
  // Resolve registry-sourced skills (the skill-registry overlay landed in
  // M1·T3, lifecycle wiring landed in M1·T5). Plugin skills with
  // local-folder / inline source append their body to the system prompt
  // like chat skills; anthropic-managed plugin skills become
  // `container.skill_id` entries on the sidecar request. Best-effort —
  // a resolution failure must never block the send.
  let pluginSkillSection = ""
  const pluginAllowedTools = new Set<string>()
  const pluginUsageIds: string[] = []
  const pluginIdMap = new Map<string, string>()
  if (character?.pluginSkillIds?.length) {
    try {
      const { resolveSkillsForCharacter, extractContainerSkillIds, renderResolvedSkillsSection } =
        await import("@/lib/claude/skills-bridge")
      const resolvedPlugin = await resolveSkillsForCharacter(character.pluginSkillIds)
      const containerSkillIds = extractContainerSkillIds(resolvedPlugin)
      if (containerSkillIds.length > 0) {
        opts.containerSkillIds = containerSkillIds
      }
      pluginSkillSection = renderResolvedSkillsSection(resolvedPlugin)
      // Union each plugin skill's allowedTools into the whitelist so a
      // plugin that declares required tools doesn't get silently denied.
      // Symmetric with chat skills' allowedTools handling below.
      for (const r of resolvedPlugin) {
        for (const t of r.pluginSkill?.allowedTools ?? []) {
          pluginAllowedTools.add(t)
        }
        pluginUsageIds.push(r.id)
        if (r.pluginId) pluginIdMap.set(r.id, r.pluginId)
      }
    } catch (err) {
      console.warn("plugin skill resolution failed", err)
    }
  }
  // Bump usage counters for plugin skills that resolved. Mirrors the
  // `recordSkillUsage` call for chat skills above. Fire-and-forget.
  if (pluginUsageIds.length > 0) {
    void recordPluginSkillUsage(pluginUsageIds, pluginIdMap).catch(() => undefined)
  }

  // --- v2 persona (ADR-0030) ----------------------------------------------
  // Project the character's free-form `tone` / `personality` into a short
  // guidance block appended after the base system prompt. Suppressed when the
  // twin runtime already produced a personality-rich prompt (see above).
  let personaSection = ""
  if (!twinReplacedBase && character?.persona) {
    const personaParts: string[] = []
    const tone = character.persona.tone?.trim()
    const personality = character.persona.personality?.trim()
    if (tone) personaParts.push(`Tone: ${tone}`)
    if (personality) personaParts.push(personality)
    if (personaParts.length > 0) {
      personaSection = `## Persona\n\n${personaParts.join("\n\n")}`
    }
  }

  const systemPrompt = [
    baseSystem,
    personaSection,
    memorySection,
    modeSection,
    skillSection,
    pluginSkillSection,
  ]
    .filter((p) => p && p.trim().length > 0)
    .join("\n\n---\n\n")
  if (systemPrompt) opts.systemPrompt = systemPrompt

  // --- Working directory ---------------------------------------------------
  // Priority: per-session override → active workspace root → character default
  // → app default. The active workspace sits above the character default
  // because it reflects "which project the user is currently working in",
  // a stronger signal than a character's standing preference.
  const cwd =
    session?.workingDir ??
    (ctx.activeProject ? primaryRootOf(ctx.activeProject)?.path : undefined) ??
    character?.workingDir ??
    appSettings?.defaultWorkingDir
  if (cwd) opts.cwd = cwd

  // --- Additional directories ----------------------------------------------
  // Union of the active workspace's extra mounted dirs and the @-referenced
  // files/folders. For referenced folders we add the folder itself; for files
  // we add their parent dir. Deduplicate, drop empty/nullish entries.
  {
    const dirs = new Set<string>()
    for (const dir of ctx.activeProject ? additionalDirsOf(ctx.activeProject) : []) {
      if (dir) dirs.add(dir)
    }
    for (const ref of ctx.referencedPaths ?? []) {
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
    session?.permissionMode ??
    activeMode?.permissionMode ??
    character?.permissionMode ??
    appSettings?.permissionMode
  if (permissionMode) opts.permissionMode = permissionMode

  // --- Permission ruleset (OpenCode-style static command rules) ------------
  // Serialize the user's explicit `command-glob → allow|ask|deny` overrides
  // into SendOptions so the sidecar `canUseTool` can short-circuit obvious
  // allows/denies without a round-trip (Layer A). Only explicit rules are
  // sent — no blanket default — so absent a rule the normal approval flow is
  // untouched. The renderer's Auto-mode (Layer B) handles the richer cases.
  const commandRules = appSettings?.agentPermissions?.commandRules
  if (commandRules && Object.keys(commandRules).length > 0) {
    opts.permissionRuleset = { Bash: commandRules }
  }

  // --- Tool whitelist/blacklist --------------------------------------------
  // Member override REPLACES the character's allowedTools (does not union).
  // Skills still contribute their tools so an override doesn't accidentally
  // strip a skill's required permissions.
  const allowed = new Set<string>()
  const baseAllowed = memberOverride?.allowedToolsOverride ?? character?.allowedTools
  for (const t of baseAllowed ?? []) allowed.add(t)
  for (const sk of skills) for (const t of sk.allowedTools ?? []) allowed.add(t)
  // Plugin-contributed skills' allowedTools (Task M4) — same treatment as
  // chat skills so a plugin declaring required tools isn't silently denied.
  for (const t of pluginAllowedTools) allowed.add(t)
  // Agent mode tools union in too — picking "Code Generator" should grant
  // execute_code without forcing the user to also tweak the character.
  for (const t of activeMode?.tools ?? []) allowed.add(t)
  // A2UI: when the active scope opts in, fold the 4 bridge tools into the
  // whitelist + tack the A2UI system-prompt extension onto appendSystemPrompt
  // so the model knows when to paint surfaces. Resolution order matches the
  // rest of build-options: session > character > appSettings default.
  //
  // G6 — when the session is bound to an IM connector (platformBinding
  // present) AND the adapter has cached a non-empty A2UI capability
  // matrix, force a2uiEnabled regardless of the scope toggle. IM
  // conversations need A2UI to deliver any interactive UX at all, so
  // making it opt-in per IM session would silently degrade every reply
  // to plain markdown.
  const baseA2uiEnabled =
    (session as { a2uiEnabled?: boolean } | undefined)?.a2uiEnabled ??
    character?.a2uiEnabled ??
    appSettings?.a2uiDefaultEnabled ??
    false
  let connectorCapabilityPrompt: string | null = null
  if (session?.platformBinding?.adapterId) {
    try {
      const { getAdapterInstance } = await import("@/lib/db/adapter-instances")
      const adapterRow = await getAdapterInstance(session.platformBinding.adapterId)
      const matrix = adapterRow?.lastKnownCapabilities
      if (matrix && Object.keys(matrix).length > 0) {
        const { buildCapabilityPromptSection } =
          await import("@/lib/connectors/a2ui-bridge/capability-evaluator")
        // ADR-0026 — also pass the cached built-in skill capabilities so
        // the prompt declares which lark.* (and future) skill families
        // this channel can serve. Intersected against the per-channel
        // allowlist below.
        connectorCapabilityPrompt = buildCapabilityPromptSection(
          session.platformBinding.platform,
          matrix,
          adapterRow?.lastKnownSkillCapabilities
        )
      }
    } catch {
      // Best-effort — missing adapter row / capability matrix shouldn't
      // crash the send; just skip the prompt injection.
    }
  }
  const a2uiEnabled = baseA2uiEnabled || connectorCapabilityPrompt !== null
  if (a2uiEnabled) {
    for (const t of namespacedA2UIToolNames()) allowed.add(t)
  }

  // ── ADR-0026 — Built-in skills manifest ──────────────────────────────
  // The built-in skill tier produces MCP tool defs that surface to the
  // sidecar through the same plugin-tools manifest path. The dispatcher
  // owns HITL routing; here we only flow the manifest entries into the
  // allowed tools whitelist and append a skill-manifest entry the
  // sidecar bridge picks up.
  //
  // Gating: surface skills ONLY when the session is IM-bound (the
  // assistant needs `lark.calendar.*` to answer the Lark user) OR the
  // character has explicitly opted in via `enableBuiltInSkills`. Desktop
  // sessions without an explicit opt-in see an empty manifest — keeps
  // the chat-history token budget tight and avoids exposing skills the
  // user hasn't enabled.
  const builtInSkillsRequested =
    Boolean(session?.platformBinding?.adapterId) || character?.enableBuiltInSkills === true
  let builtInSkillsManifest: Awaited<
    ReturnType<typeof import("@/lib/skills/built-in/manifest").buildBuiltInSkillManifest>
  > = []
  if (builtInSkillsRequested) {
    try {
      // Side-effect import so every family's registerBuiltInSkill() runs
      // before the manifest builder walks the registry.
      await import("@/lib/skills/built-in")
      const { buildBuiltInSkillManifest } = await import("@/lib/skills/built-in/manifest")
      builtInSkillsManifest = buildBuiltInSkillManifest({
        imBinding: session?.platformBinding?.adapterId
          ? {
              adapterId: session.platformBinding.adapterId,
              platform: session.platformBinding.platform,
              conversationKey: session.platformBinding.conversationKey ?? "",
            }
          : undefined,
        imOverrideRow: imOverrideRow ?? undefined,
      })
      for (const entry of builtInSkillsManifest) {
        allowed.add(entry.name)
      }
    } catch {
      // Best-effort — registry import failure shouldn't break sends.
    }
  }

  if (allowed.size > 0) opts.allowedTools = [...allowed]
  if (character?.disallowedTools?.length) opts.disallowedTools = [...character.disallowedTools]

  // --- Tool/MCP filter overlay (global → character → session; deny wins) ---
  // Configurable allow/deny filter over the unified tool catalog
  // (`lib/tools/tool-catalog.ts`), Codex / Hermes style. Later scopes REPLACE
  // earlier ones (session beats character beats app). Applied AFTER the
  // allow/deny union above so it narrows the already-granted set. Resolved
  // here so the MCP-subset block below can read `toolFilter.mcpServerIds`.
  const toolFilter = session?.toolFilter ?? character?.toolFilter ?? appSettings?.toolFilter
  if (toolFilter && toolFilter.mode !== "all") {
    const filterTools = new Set(toolFilter.tools ?? [])
    if (filterTools.size > 0) {
      if (toolFilter.mode === "allow") {
        // Intersect the resolved allowlist with the filter. When no allowlist
        // was set (≡ "all tools available"), the filter becomes the allowlist.
        opts.allowedTools =
          opts.allowedTools && opts.allowedTools.length > 0
            ? opts.allowedTools.filter((t) => filterTools.has(t))
            : [...filterTools]
      } else {
        // deny: union the filtered tools into disallowedTools (deny always wins).
        const denied = new Set(opts.disallowedTools ?? [])
        for (const t of filterTools) denied.add(t)
        opts.disallowedTools = [...denied]
      }
    }
  }

  // --- Runtime tool-search (deferred loading) policy -----------------------
  // claude-agent-sdk `alwaysLoad` semantics (Phase 0): when enabled, the
  // bundled CLI defers MCP tools behind tool search and only the always-load
  // set stays resident. The sidecar dispatcher consumes these fields.
  const toolSearchRuntime = character?.toolSearchRuntimeOverride ?? appSettings?.toolSearchRuntime
  if (toolSearchRuntime?.enabled) {
    opts.toolSearchEnabled = true
    if (toolSearchRuntime.alwaysLoadServers?.length) {
      opts.alwaysLoadServers = [...toolSearchRuntime.alwaysLoadServers]
    }
    if (toolSearchRuntime.alwaysLoadTools?.length) {
      opts.alwaysLoadTools = [...toolSearchRuntime.alwaysLoadTools]
    }
  }

  if (a2uiEnabled) {
    const existing = opts.appendSystemPrompt?.trim() ?? ""
    opts.appendSystemPrompt = existing ? `${existing}\n\n${A2UI_SYSTEM_PROMPT}` : A2UI_SYSTEM_PROMPT
  }
  // G6 — append the connector-capability section after the A2UI prompt so
  // the model knows which kinds will degrade on this channel and avoids
  // the unsupported ones (Chart on OneBot, Slider on Slack, …).
  if (connectorCapabilityPrompt) {
    const existing = opts.appendSystemPrompt?.trim() ?? ""
    opts.appendSystemPrompt = existing
      ? `${existing}\n\n${connectorCapabilityPrompt}`
      : connectorCapabilityPrompt
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

    // Apply the configurable filter's MCP-server subset on top of the
    // character/team/member resolution above (deny wins, allow intersects).
    if (toolFilter && toolFilter.mode !== "all" && toolFilter.mcpServerIds?.length) {
      const fset = new Set(toolFilter.mcpServerIds)
      chosen =
        toolFilter.mode === "allow"
          ? chosen.filter((srv) => fset.has(srv.id))
          : chosen.filter((srv) => !fset.has(srv.id))
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

  // --- Unified LSP (agent runtime) -----------------------------------------
  // Resolve the builtin ← user ← project-local server layers ONCE in the
  // renderer (the sidecar is a separate Node project that cannot import
  // `lib/`) and hand the flat list to the sidecar via `sendOptions.lsp`. The
  // same `resolveLspServers` drives the editor LSP registry, so a server the
  // user adds in Settings is available to both the agent and the editors.
  //
  // Gated on the master toggle (`settings.lsp.enabled`, defaulting to the
  // legacy `builtinTools.lsp` category) plus a `cwd` — the agent LSP resolves
  // workspace roots relative to the working directory and reads
  // `<cwd>/.cognia/lsp.json` for the project layer.
  {
    const lspEnabled = appSettings?.lsp?.enabled ?? appSettings?.builtinTools?.lsp ?? false
    if (lspEnabled && opts.cwd) {
      const servers = await resolveLspServers({
        rootDir: opts.cwd,
        userServers: appSettings?.lsp?.servers,
        readProjectFile: readProjectLspFile,
      })
      // Managed install root for the npm-first install ladder. Resolved here
      // because the sidecar has no Tauri path API; absent on web/mobile.
      let installDir: string | undefined
      try {
        const { isTauri } = await import("@/lib/tauri")
        if (isTauri()) {
          const { appDataDir, join } = await import("@tauri-apps/api/path")
          installDir = await join(await appDataDir(), "lsp")
        }
      } catch {
        // Path API unavailable — the agent ladder simply skips managed rungs.
      }
      opts.lsp = {
        enabled: true,
        servers,
        autoInstall: appSettings?.lsp?.autoInstall !== false,
        installDir,
      }
    }
  }

  // --- Compute the effective Computer Use authorization once -------------
  // Two gates need this verdict: the plugin-tools manifest (so the chat
  // path doesn't surface `mcp__cognia-plugin-tools__{computer_use,bash,
  // text_editor}` to the model when the character — or an IM-session
  // safeguard — disallows it) AND the legacy anthropic-tools path below.
  //
  // G6 — IM-driven sessions default-deny Computer Use so an inbound
  // Telegram / Slack / Discord / Lark message can't fire screenshot /
  // mouse / keyboard actions. Per-conversation opt-in lives on
  // `ConversationOverrideRow.allowComputerUse`.
  //
  // Reuses `imOverrideRow` already fetched at the top of the resolver
  // (A6, per-channel provider override) instead of issuing a second Dexie
  // read. The first read is best-effort, so `imOverrideRow` may still be
  // undefined here; the fallback is the safe `false` default.
  const imSession = Boolean(session?.platformBinding?.adapterId)
  const allowImComputerUse = imOverrideRow?.allowComputerUse === true
  const computerUseAllowedForChat =
    character?.enableComputerUse === true && (!imSession || allowImComputerUse)

  // OCR tool (`cognia-ocr` / `ocr.extract`, ADR-0024) is low-risk and
  // default-allowed everywhere (incl. IM); see `isOcrToolAllowed`.
  const ocrAllowedForChat = isOcrToolAllowed({
    character,
    imSession,
    allowOcrOverride: imOverrideRow?.allowOcr,
  })

  // --- Plugin tools → SDK sidecar ------------------------------------------
  // Surface enabled plugin tools + ADR-0026 built-in skills + terminal_dock_*
  // as a manifest the sidecar turns into the synthetic `cognia-plugin-tools`
  // MCP server. Functions don't cross stdio; the sidecar emits
  // `plugin_tool_exec` and the global `PluginToolDispatchProvider`
  // (components/providers/plugin-tool-dispatch-provider.tsx) routes it to
  // `handlePluginToolExec`, writing the result back via the
  // `claude_plugin_tool_response` Tauri command.
  //
  // Per-character Computer Use gating: the `cognia-computer-use` plugin
  // contributes three tools (computer_use / bash / text_editor). Filter
  // them out when the character doesn't enable Computer Use, or when the
  // IM-session safeguard denies access. Other plugins flow through
  // unchanged.
  if (!character?.disablePluginTools) {
    try {
      const { buildPluginToolsManifest } = await import("@/lib/plugin/bridge/sidecar-tools-bridge")
      // Wave 1 — when the user has opted into agent-driven terminal use,
      // the manifest carries 4 synthetic `terminal_dock_*` entries that
      // route through the existing plugin_tool_exec wire and land in
      // `lib/terminal/dock-tool-handler.ts:runTerminalDockAction`. The
      // setting lives in `appSettings.terminal.exposeDockToAgents` and
      // defaults to false (agent has no terminal access).
      const exposeDockToAgents = appSettings?.terminal?.exposeDockToAgents === true
      let manifest = buildPluginToolsManifest({ exposeDockToAgents })
      if (!computerUseAllowedForChat) {
        manifest = manifest.filter((entry) => entry.pluginId !== "cognia-computer-use")
      }
      if (!ocrAllowedForChat) {
        manifest = manifest.filter((entry) => entry.pluginId !== "cognia-ocr")
      }
      // Semantic tool routing (opt-in, default OFF): when MORE plugin tools
      // than the activation threshold are exposed, keep only the top-K
      // semantic matches for the current prompt plus pinned tools. Only the
      // PLUGIN manifest is pruned — built-in skills below ride along
      // untouched — and any matcher failure (embedding engine unavailable,
      // no query text) skips pruning entirely. Never blocks a send.
      const semanticSettings = appSettings?.semanticToolRouting
      if (
        semanticSettings?.enabled === true &&
        manifest.length > Math.max(1, semanticSettings.activationToolCount ?? 24)
      ) {
        const semanticQuery = ctx.routingContextHint?.promptText ?? ctx.twinUserMessage ?? ""
        if (semanticQuery.trim()) {
          try {
            const { pruneToolsSemantica } = await import("@/lib/ai/routing/semantic-tool-router")
            const pruned = await pruneToolsSemantica({
              query: semanticQuery,
              candidates: manifest.map((entry) => ({
                name: entry.name,
                description: entry.description,
                pluginId: entry.pluginId,
              })),
              settings: semanticSettings,
            })
            if (pruned) {
              const keep = new Set(pruned.kept.map((candidate) => candidate.name))
              manifest = manifest.filter((entry) => keep.has(entry.name))
              loggers.app.info("semantic tool routing pruned plugin tools", {
                kept: manifest.length,
                pruned: pruned.prunedCount,
              })
            }
          } catch (err) {
            loggers.app.warn("semantic tool routing skipped", { error: String(err) })
          }
        }
      }
      // ADR-0026 — fold built-in skill manifest entries into the same
      // pluginTools stream the sidecar consumes. The two streams share
      // a shape; the sidecar's `plugin_tool_exec` IPC routes by tool
      // name so the synthetic `cognia-builtin-skills` namespace can
      // co-exist with real plugin tools without collision.
      const combined = [
        ...manifest,
        ...builtInSkillsManifest.map((e) => ({
          name: e.name,
          description: e.description,
          jsonSchema: e.jsonSchema,
          pluginId: e.pluginId,
        })),
      ]
      if (combined.length > 0) opts.pluginTools = combined
    } catch (err) {
      // Non-fatal — skip plugin tools for this turn if the bridge isn't ready
      // (e.g. the plugin store hasn't been hydrated yet on cold boot). Log so a
      // genuine manifest regression is visible instead of silently disabling
      // every plugin tool.
      loggers.app.warn("failed to build plugin tools manifest; tools skipped this turn", {
        error: String(err),
      })
    }
  }

  // --- Anthropic native tools (Computer Use) -------------------------------
  // When the character has `enableComputerUse === true`, attach every
  // registered native Anthropic tool (computer / bash / text_editor) plus
  // the matching `anthropic-beta` header to `appendHeaders`. The sidecar
  // forwards them to the Anthropic SDK verbatim. See ADR-0020.
  //
  // The Claude Code Agent SDK is MCP-only and currently ignores
  // `opts.anthropicTools` — the chat path uses the plugin-tools route
  // above. This call is kept so the `anthropic-beta` header still goes
  // out (harmless, future-proofs the day the SDK adds native-tool
  // support) and so the External Bridge MCP path can still introspect
  // the native-anthropic-tool registry.
  try {
    const { applyComputerUseTools } = await import("@/lib/claude/computer-use-tools")
    // ADR-0020 W3 — read the live Rust gate tier ahead of the call so
    // `chatConsentMode: "auto"` can decide whether to suppress the
    // chat modal in favour of the Rust overlay. Best-effort: any
    // failure (web mode, IPC hiccup, gate misread) falls through to
    // an undefined tier, in which case `applyComputerUseTools` treats
    // `auto` as `always-ask` (the safe default).
    let computerUseGateTier: "off" | "whitelist" | "perCall" | undefined
    try {
      const [{ desktop }, { isTauri }] = await Promise.all([
        import("@/lib/automation/client"),
        import("@/lib/tauri"),
      ])
      if (isTauri()) {
        const settings = await desktop.settingsGet()
        computerUseGateTier = settings.perSurface?.computerUse?.tier
      }
    } catch {
      // Silent fallthrough — undefined tier short-circuits to safe default.
    }
    const applied = applyComputerUseTools({
      character,
      opts,
      imSession,
      allowImComputerUse,
      // ADR-0020 W3 — session id flows in so the per-session grant
      // lookup can suppress redundant chat modals when the operator
      // chose `chatConsentMode: "session-grant"`.
      sessionId: session?.id,
      computerUseGateTier,
    })
    Object.assign(opts, applied.opts)
    // ADR-0020 remote-target — resolve the GUI execution target (session →
    // character → local) and stash it per-session so the computer-use plugin's
    // execute() callback can stamp `CallContext.sandboxConnectionId`. Cleared
    // when Computer Use is disabled so a stale remote target can't linger.
    const [
      { resolveComputerUseTarget },
      { setActiveComputerUseTarget, clearActiveComputerUseTarget },
    ] = await Promise.all([
      import("@/lib/automation/sandbox-target"),
      import("@/lib/claude/computer-use-target-state"),
    ])
    if (character?.enableComputerUse) {
      setActiveComputerUseTarget(
        session?.id,
        resolveComputerUseTarget(session?.computerUseTarget, character?.computerUseTarget)
      )
    } else {
      clearActiveComputerUseTarget(session?.id)
    }
  } catch {
    // Non-fatal — the registry import shouldn't ever fail in production,
    // but a hot-reload during dev can briefly leave it unresolved. Better
    // to skip computer-use than to break the send.
  }

  // --- Sandbox replacement of SDK builtin Bash / Edit / Write (ADR-0028 4.5)
  // When sandbox is enabled for this session, disallow the SDK's builtin
  // Bash / Edit / Write so the model can't bypass the sandbox. The
  // `cognia-sandboxed-tools` plugin contributes 4 replacements via
  // `opts.pluginTools` (built above by `buildPluginToolsManifest()` — that
  // helper collects every enabled plugin's tools, including ours when the
  // plugin is enabled in the store). Native `text_editor` is filtered out
  // of `opts.anthropicTools` so the model gets a single, sandboxed path.
  //
  // A short system-prompt note steers the model to `sandbox_*` tool names —
  // anthropic models do follow disallowedTools strictly, but the prompt
  // hint reduces "I notice Bash is disabled, can you tell me why?"
  // back-and-forth.
  const sandboxEnabled =
    session?.sandboxEnabled ??
    character?.sandboxEnabled ??
    appSettings?.sandboxDefaultEnabled ??
    false
  if (sandboxEnabled) {
    const disallowed = new Set(opts.disallowedTools ?? [])
    for (const t of ["Bash", "Edit", "Write"]) disallowed.add(t)
    opts.disallowedTools = [...disallowed]
    if (Array.isArray(opts.anthropicTools)) {
      opts.anthropicTools = opts.anthropicTools.filter(
        (t) => t.name !== "text_editor" && t.name !== "str_replace_based_edit_tool"
      )
    }
    // ADR-0028 / T4 — sandboxTier precedence: character override beats
    // the app default. Stamped onto the microvm-bridge so the
    // `cognia-sandboxed-tools` plugin can route this session's exec
    // calls to e2b when the user opts into microVM isolation.
    const sandboxTier: "os" | "microvm" = character?.sandboxTier ?? appSettings?.sandboxTier ?? "os"
    setActiveSandboxTier(session?.id, sandboxTier)
    const sandboxHint =
      "Filesystem-mutating and shell tools are sandboxed in this session. Use " +
      "`sandbox_bash` / `sandbox_edit` / `sandbox_write` / `sandbox_text_editor` " +
      "(from cognia-sandboxed-tools) instead of the SDK builtins; they accept the " +
      "same shape plus an explicit writable/readable scope. The unsandboxed Bash / " +
      "Edit / Write are not available in this session."
    const existing = opts.appendSystemPrompt?.trim() ?? ""
    opts.appendSystemPrompt = existing ? `${existing}\n\n${sandboxHint}` : sandboxHint
  } else {
    // Sandbox disabled — make sure stale tier state from a previous send
    // on the same session id doesn't leak into the next call.
    setActiveSandboxTier(session?.id, "os")
  }

  // --- Workspace Restricted Mode -------------------------------------------
  // An untrusted active workspace denies every disk/host-mutating tool. Mirrors
  // the sandbox deny above; read-only tools stay allowed. Computer-use plugin
  // tools (if present in the allow list) are stripped too.
  if (ctx.workspaceRestricted) {
    const denied = new Set(opts.disallowedTools ?? [])
    for (const t of RESTRICTED_MODE_DENIED_TOOLS) denied.add(t)
    for (const t of opts.allowedTools ?? []) {
      if (t.startsWith("mcp__cognia-plugin-tools__")) denied.add(t)
    }
    opts.disallowedTools = [...denied]
    if (opts.allowedTools) opts.allowedTools = opts.allowedTools.filter((t) => !denied.has(t))
  }

  // --- Per-session account / proxy env (ADR-0028) --------------------------
  // Resolve the accountId via the chain (session → character → settings →
  // global active pointer), then ask the Rust side for the env tuple to
  // forward to this `query()` call. The sidecar's dispatch path spreads
  // `{ ...process.env, ...opts.env }` so per-call env wins over process env
  // — exactly what we want for multi-account isolation. Per-account
  // `CLAUDE_CONFIG_DIR` is also the OAuth refresh race mitigation (each
  // account gets its own .credentials.json).
  //
  // Runs BEFORE the convenience-modes block below so `debugMode` can layer
  // `DEBUG=*` / `CLAUDE_CODE_DEBUG=1` on top.
  const accountId = resolveAccountId(session ?? null, character ?? null, appSettings ?? null)
  const [accountEnv, proxyEnv] = await Promise.all([
    resolveAccountEnv(providerId, accountId),
    resolveProxyEnv(session?.id ?? null),
  ])
  if (Object.keys(accountEnv).length > 0 || Object.keys(proxyEnv).length > 0) {
    opts.env = { ...(opts.env ?? {}), ...accountEnv, ...proxyEnv }
  }

  // --- Convenience modes (bare / debug / brief) ----------------------------
  // Precedence: session > character > appSettings. memberOverride is omitted
  // intentionally — these are runtime-feel toggles, not per-team-slot config.

  const bareMode = session?.bareMode ?? character?.bareMode ?? appSettings?.bareMode
  if (bareMode) {
    // `--bare` reproduction: ignore on-disk settings and any MCP discoveries
    // outside the explicit `mcpServers` map we already built.
    opts.settingSources = []
    opts.strictMcpConfig = true
  }

  const debugMode = session?.debugMode ?? character?.debugMode ?? appSettings?.debugMode
  if (debugMode) {
    // SDK has no `debug` option, so we lean on env vars the SDK + spawned
    // MCP/sub-processes both honour. Sidecar dispatcher merges this onto
    // `process.env` (see `sidecar/dispatch/anthropic.mjs:94`).
    opts.env = {
      ...(opts.env ?? {}),
      DEBUG: "*",
      CLAUDE_CODE_DEBUG: "1",
    }
  }

  const briefMode = session?.briefMode ?? character?.briefMode ?? appSettings?.briefMode
  if (briefMode) {
    const existing = opts.appendSystemPrompt?.trim() ?? ""
    opts.appendSystemPrompt = existing
      ? `${existing}\n\n${BRIEF_OUTPUT_SNIPPET}`
      : BRIEF_OUTPUT_SNIPPET
  }

  // --- Active /goal context (ADR-0013) -------------------------------------
  // When the resolving session has an active goal, append the goal's system
  // section (Codex-style <objective> wrap + injection warning) to
  // `appendSystemPrompt`. Inactive / paused / terminal goals are skipped so
  // the model only sees goal context while it's actually being driven.
  if (ctx.activeGoal && ctx.activeGoal.status === "active") {
    const { appendGoalContext } = await import("@/lib/goal/context-injector")
    opts.appendSystemPrompt = appendGoalContext({
      appendSystemPrompt: opts.appendSystemPrompt,
      activeGoal: ctx.activeGoal,
    })
  }

  // --- Active plan context (ADR-0045) --------------------------------------
  // When the resolving session has an executing plan, append the plan's
  // system section (current + remaining steps) so the in-session driver's
  // turns know their place in the plan. Only `executing` plans inject —
  // draft / awaiting_approval / paused / terminal plans are skipped.
  if (ctx.activePlan && ctx.activePlan.status === "executing") {
    const { appendPlanContext } = await import("@/lib/agent/plan/context-injector")
    opts.appendSystemPrompt = appendPlanContext({
      appendSystemPrompt: opts.appendSystemPrompt,
      activePlan: ctx.activePlan,
    })
  }

  // --- Inbox / connector suppression gate (ADR-0009) -----------------------
  // Stamps `opts.suppressedReason` so the connector runtime can short-circuit
  // the sidecar call (no streaming run, no outbound enqueue) and instead
  // append a deferred audit row. Direct chat sends never pass `inboxPolicy`,
  // so this branch is a no-op for the regular composer hook.
  //
  // Precedence (first hit wins):
  //   1. Manual mode override   — user has taken the wheel.
  //   2. Adapter mute           — operator killswitch.
  //   3. Adapter quiet hours    — wall-clock window in the adapter's tz.
  //
  // Why precedence matters: a muted adapter inside its quiet window should
  // surface as `"muted"` so the audit log is honest about the strongest
  // reason — quiet hours is a same-day-only gate while a mute is operator
  // intent, and the difference is what the troubleshooter wants to see.
  if (ctx.inboxPolicy) {
    const policy = ctx.inboxPolicy
    if (policy.forcedMode === "manual") {
      opts.suppressedReason = "manual_mode_override"
    } else if (policy.muted === true) {
      opts.suppressedReason = "muted"
    } else if (policy.quietHours) {
      const { from, to, tz } = policy.quietHours
      if (isInQuietHours(Date.now(), from, to, tz)) {
        opts.suppressedReason = "quiet_hours"
      }
    }
  }

  // --- Extended thinking budget --------------------------------------------
  // Precedence: session > character > app default. Only forwarded when > 0;
  // a falsy budget keeps the SDK at its default (no thinking pass).
  const thinkingBudget =
    session?.maxThinkingTokens ??
    character?.maxThinkingTokens ??
    appSettings?.defaultMaxThinkingTokens
  if (typeof thinkingBudget === "number" && thinkingBudget > 0) {
    opts.maxThinkingTokens = thinkingBudget
  }

  // --- Workflow-editor session branch (Phase C.6 → Workflow Copilot) ------
  // For sessions mounted inside the visual workflow editor's right
  // sidebar we replace the additive character / mode / twin / A2UI /
  // skill stack with a single coherent "Workflow Copilot" identity:
  //
  //   • opts.systemPrompt           ← Workflow Copilot prompt (verbatim,
  //                                   no character prelude)
  //   • opts.appendSystemPrompt     ← cleared, then set to the per-turn
  //                                   workflow snapshot block (no A2UI
  //                                   / skill / goal append)
  //   • opts.allowedTools           ← strict whitelist (wf_* + Read)
  //   • opts.disallowedTools        ← belt-and-suspenders disallow list
  //   • opts.mcpServers             ← cleared (only the synthetic
  //                                   cognia-plugin-tools server survives,
  //                                   and that lives on opts.pluginTools)
  //   • opts.agents                 ← the four specialist subagents
  //                                   remain attached so the Copilot can
  //                                   delegate refactor / debug / etc.
  //
  // We DON'T touch the resume/fork block below — that still applies so
  // sidecar restarts can recover the workflow chat seamlessly.
  if (session?.kind === "workflow-editor") {
    try {
      const { resolveAllSubagents } = await import("@/lib/claude/agents/subagents")
      opts.agents = {
        ...(opts.agents ?? {}),
        ...resolveAllSubagents({ context: "workflow-editor" }),
      }
    } catch (err) {
      console.warn("workflow-editor subagent registration failed:", err)
    }
    // Sessions for this surface are minted with id = `workflow:${workflowId}`.
    // Extract the workflow id and look up the registered editor store so we
    // can build a snapshot. If no editor is open (rare race during nav),
    // skip the snapshot block — the agent will discover the graph via its
    // first wf_read_graph tool call.
    const workflowId = session.id.startsWith("workflow:")
      ? session.id.slice("workflow:".length)
      : undefined
    let snapshot: string | null = null
    if (workflowId) {
      try {
        const { getEditorStore } = await import("@/lib/workflow/editor/store-registry")
        const store = getEditorStore(workflowId)
        if (store) {
          const s = store.getState()
          snapshot = buildWorkflowSnapshotBlock(workflowId, s)
        }
      } catch (err) {
        console.warn("workflow-editor snapshot block failed:", err)
      }
    }
    try {
      const {
        buildWorkflowCopilotPrompt,
        WORKFLOW_COPILOT_ALLOWED_TOOLS,
        WORKFLOW_COPILOT_DISALLOWED_TOOLS,
      } = await import("@/lib/claude/agents/workflow-copilot-prompt")
      // Overwrite — not union. The additive stack above has already run
      // (character prompt, skills, mode, A2UI capability prompt, goal,
      // twin runtime) but for this session kind we deliberately drop
      // every one of those layers in favour of the Workflow Copilot
      // identity.
      opts.systemPrompt = buildWorkflowCopilotPrompt(null)
      opts.appendSystemPrompt = snapshot ?? undefined
      opts.allowedTools = [...WORKFLOW_COPILOT_ALLOWED_TOOLS]
      opts.disallowedTools = [...WORKFLOW_COPILOT_DISALLOWED_TOOLS]
      // Scope the built-in Read tool to the copilot-templates directory
      // only. The IDENTITY section of the prompt promises Read access is
      // limited; without this clamp the SDK would otherwise inherit the
      // additive stack's referencedPaths (which can include any user-
      // @-referenced folder). Overwriting `additionalDirectories` is the
      // single source of truth: anything under `lib/workflow/copilot-
      // templates/` (relative to the sidecar's cwd) is readable, nothing
      // else is. In dev / packaged Tauri the sidecar cwd is the repo root,
      // so the relative path resolves consistently across platforms.
      opts.additionalDirectories = ["lib/workflow/copilot-templates"]
      // External MCP servers are character-scope; the Copilot operates
      // purely through the workflow-ai plugin tools (already populated on
      // `opts.pluginTools` above by `buildPluginToolsManifest()`).
      delete opts.mcpServers
    } catch (err) {
      console.warn("workflow-editor copilot prompt installation failed:", err)
    }
  } else if (session?.kind === "team") {
    // Team chat sessions union the 4 built-in workflow-* subagents with
    // every plugin-contributed subagent from the `subagent-registry`
    // overlay. Plugin subagent ids are namespaced as `<pluginId>:<id>`
    // so they can never collide with built-in dispatcher names.
    try {
      const { resolveAllSubagents } = await import("@/lib/claude/agents/subagents")
      opts.agents = {
        ...(opts.agents ?? {}),
        ...resolveAllSubagents({ context: "team" }),
      }
    } catch (err) {
      console.warn("team session subagent registration failed:", err)
    }
  } else {
    // Direct chat: expose the user's OWN subagents (plugin-registered +
    // imported/authored templates) so the model can delegate to them via the
    // Task tool — previously subagents were dormant outside workflow-editor /
    // team sessions. Empty-guarded: an empty map would otherwise advertise a
    // no-op agent surface on every turn.
    try {
      const { resolveAllSubagents } = await import("@/lib/claude/agents/subagents")
      const direct = resolveAllSubagents({ context: "direct" })
      if (Object.keys(direct).length > 0) {
        opts.agents = { ...(opts.agents ?? {}), ...direct }
      }
    } catch (err) {
      console.warn("direct-chat subagent registration failed:", err)
    }
  }

  // --- Cache-friendly dynamic tail (experimental) ---------------------------
  // Sections collected when `cacheOptimizationEnabled` is on (twin retrieved
  // chunks / style few-shot, memory recall) land at the very END of
  // `appendSystemPrompt`, after every session-stable section above. Skipped
  // for workflow-editor sessions — that path deliberately replaces the whole
  // prompt stack with the Copilot identity + snapshot.
  if (dynamicTailSections.length > 0 && session?.kind !== "workflow-editor") {
    const existing = opts.appendSystemPrompt?.trim() ?? ""
    const tail = dynamicTailSections.join("\n\n")
    opts.appendSystemPrompt = existing ? `${existing}\n\n${tail}` : tail
  }

  // --- Deterministic tool-list ordering ------------------------------------
  // allowedTools / disallowedTools are assembled via Set unions whose
  // insertion order depends on which sources contributed first this turn.
  // The lists are semantically sets, but they serialize into the request —
  // an unstable order silently breaks provider prompt-cache prefix matching
  // (DeepSeek / OpenAI automatic caching, Anthropic cache_control). Sort
  // once here so every turn serializes identically.
  if (opts.allowedTools) opts.allowedTools = [...opts.allowedTools].sort()
  if (opts.disallowedTools) opts.disallowedTools = [...opts.disallowedTools].sort()

  // --- Resume / fork continuity --------------------------------------------
  // The sidecar persists the SDK-issued `session_id` onto the ChatSession row
  // (see hooks/use-claude-chat.ts). Re-passing it as `resumeSessionId` on
  // every send is harmless — the sidecar only honours `resume` when it has to
  // start a fresh SDK Query (e.g. after a sidecar restart or app reload). When
  // an in-flight session already has streaming input wired up, options are
  // ignored. Skip on team sub-sessions and when the session is being forked.
  if (session?.forkedFromSdkSessionId) {
    // Fork: tell the SDK to branch from the parent's session id rather than
    // resume it. The sidecar dispatcher converts this to `forkSession: true`
    // and passes the parent id via `resume` (see `anthropic.mjs:92-93`).
    opts.forkFromSessionId = session.forkedFromSdkSessionId
  } else if (session?.sdkSessionId) {
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
