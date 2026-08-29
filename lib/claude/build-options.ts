// Pure helper that resolves the final SendOptions for a turn by merging:
//   1. App-wide defaults (settings store)
//   2. Character config (if session.characterId is set)
//   3. Skills attached to that character (and not disabled on the session)
//   4. Per-session overrides (which always win)
//
// Lives in its own module so it can be imported from both the direct-chat
// hook and the team-chat hook, and unit-tested in Phase 6 without React.

import { additionalDirsOf, allRootPaths } from "@/lib/workspace/roots"
import { resolveEffectiveCwd } from "@/lib/workspace/effective-cwd"
import { resolveSessionWorkspaceRoot } from "@/lib/task-workspace/session-execution-context"
import type { MarkdownAgentFile } from "@/lib/claude/agents/markdown-agents"
import type { RagEmbeddingProvider } from "@cognia/provider-embedding/embedding-catalog"
import type { BedrockConnectionSettings } from "@cognia/provider-types"
import type { IVectorStore } from "@cognia/vector/store"
import { RESTRICTED_MODE_DENIED_TOOLS } from "@/lib/workspace/restricted-tools"
import { mergeRulesets } from "@/lib/claude/permissions/ruleset"
import { deterministicRulesetSort } from "@/lib/claude/permissions/ruleset-edit"
import { resolveLspServers } from "@/lib/lsp/resolve-config"
import { readProjectLspFile } from "@/lib/lsp/project-file-reader"
import { resolveAccountEnv, resolveAccountId, resolveProxyEnv } from "@/lib/claude/env-resolver"
import { resolveSandboxEnabled, resolveSandboxSessionBinding } from "@/lib/sandbox/binding"
import { sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"
import {
  deriveExternalSessionPermission,
  type ExternalSessionPermissionSpec,
} from "@/lib/ai/agent/external/permission-cascade"
import { recordResolvedPermissionCeiling } from "@/lib/claude/agents/dispatch-context-registry"
import { DISPATCH_AGENT_TOOL_NAME, TASK_TOOL_NAME } from "@/lib/claude/agents/dispatch-agent-tool"
import { ASK_USER_TOOL_NAME } from "@/lib/claude/ask-user-tool"
import { listCharactersByIds, resolveCharacterById } from "@/lib/db/characters"
import {
  activeEffectiveSkillIds,
  listEnabledSkillsByIds,
  listSkillsByIds,
  recordSkillUsage,
  renderSkillsCatalog,
  renderSkillsSection,
} from "@/lib/db/skills"
import { builtinSkillId, getCatalogSkill } from "@/lib/skills/built-in-catalog"
import { selectSurfaceSkills, renderSurfaceSkillsSection } from "@/lib/skills/surface-activation"
import { recordPluginSkillUsage } from "@/lib/db/plugin-skill-usage"
import {
  buildMcpServerMapResolved,
  listEnabledMcpServers,
  resolveMcpDisallowedToolNames,
} from "@/lib/db/mcp-servers"
import { getTeam } from "@/lib/db/teams"
import type { ConversationOverrideRow, AdapterInstanceRow } from "@/lib/db/connector-types"
import { isInQuietHours } from "@/lib/connectors/outbound-runner"
import { isOcrToolAllowed } from "@/lib/claude/ocr-tool-gate"
import {
  adapterAllowsHostCapability,
  resolveImHostCapabilities,
} from "@/lib/connectors/permission-resolve"
import { resolveOutputStyleSnippet } from "@/lib/claude/output-styles"
import {
  buildPostCompactionRecovery,
  resolveCompaction,
  resolveCompactInstructions,
} from "@/lib/claude/compact-instructions"
import { getCompactionStrategy } from "@/lib/plugin/registries/compaction-strategy-registry"
import { loggers } from "@cognia/logging"
import { startRootTrace, toTraceparent } from "@/lib/agent-trace/trace-context"
import { providerNameFromId } from "@cognia/agent-trace/provider-name"
import type { SpanSurface } from "@/types/agent-trace/span"
import type { TraceContext } from "@/types/agent-trace/trace-context"
import type {
  AppSettings,
  Character,
  ChatSession,
  SendOptions,
  Skill,
  Team,
  TeamMember,
} from "@cognia/agent-config-types"
import type { AgentExecutionIdentity } from "@cognia/agent-config-types/agent-execution"
import type { Project } from "@/types"
import { defaultLifecycleFirer } from "@/lib/claude/hooks/lifecycle-firer"
import { resolveMemoryConfig } from "@/types/memory/memory"
import { resolveAgentMemoryPolicy } from "@/lib/memory/agent-policy"
import { resolveMemoryAgentNamespace } from "@/lib/memory/twin-namespace"
import { resolveProjectKnowledgeSettings } from "@/types/project-knowledge"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { ConnectorMode } from "@/types/connectors/policy"
import { type AgentModeConfig } from "@/types/agent/agent-mode"
import { buildAgentModeSessionUpdate } from "@/lib/agent/mode-session-update"
import { resolveTurnAgentMode } from "./turn-agent-mode"
import {
  resolveAgentEnvironment,
  resolveAgentExecutionPolicy,
  resolveAgentModel,
} from "@/lib/agent/agent-profile-policy"
import { loadAgentEnvSecret } from "@/lib/agent/agent-env-keyring"
import { namespacedA2UIToolNames } from "@/lib/a2ui/mcp-tool-schemas"
import { A2UI_SYSTEM_PROMPT } from "@/lib/ai/prompts/a2ui-prompts"
import { buildVisualOutputSection } from "@/lib/ai/prompts/visual-output-prompts"
import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
} from "@/lib/ai/provider-consumption"
import { isLocalProvider } from "@cognia/provider-core/providers/local-providers"
import { modelSupportsEffort } from "@/lib/ai/reasoning-capability"
import { isUltracodeLevel, resolveThinkingLevel } from "@/lib/ai/thinking-level"
import { resolveOpencodeVaultCredential } from "@/lib/subscription/opencode/chat-bridge"
import { resolveCodexVaultCredential } from "@/lib/subscription/codex/chat-bridge"
import {
  CODEX_CHATGPT_BASE_URL,
  isCodexChatProviderId,
  isOpencodeChatProviderId,
} from "@/types/subscription"
import { getBuiltInProviderDefaultModel } from "@cognia/provider-types/built-in-provider-catalog"
import { getModelConfig } from "@cognia/provider-types/provider"
import { getModelContextWindow } from "@/lib/claude/usage"
import { processPromptTemplateVariables } from "@/stores/agent/custom-mode-store/helpers"
import {
  ProviderRoutingEngine,
  RoutingNoCandidatesError,
  createMappingRegistry,
  scoreDifficulty,
  type RoutingEngineDeps,
} from "@cognia/provider-routing"
import {
  applyCircuitBreakerSettings,
  buildRoutingEngineDeps,
} from "@cognia/provider-routing/build-preview-engine"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"
import { estimateCJKTokenCount } from "@cognia/rag/cjk-tokenizer"
import { DEFAULT_SKILL_CATALOG_TOKEN_BUDGET } from "@/lib/skills/prompt-budget"
import { estimateFallbackTokens } from "@/lib/ai/tokens/fallback-estimator"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { PLAN_MODE_PROMPT, PLAN_MODE_STRUCTURED_STEPS_SNIPPET } from "./plan-mode-prompt"
import { resolveProviderAttemptOptions } from "./provider-attempt-options"
import type { AgentCompositionSelectionV1 } from "@cognia/agent-config-types/agent-composition"
import { resolveTurnCompositionSafely } from "./resolve-turn-composition-safely"
import {
  applySupportAgentSafety,
  buildSupportAgentContext,
  isSupportAgentId,
  isSupportDiagnosticsEnabled,
} from "@/lib/support-agent/context"

/**
 * Snippet appended to `appendSystemPrompt` when brief mode is on. Exported so
 * the ACP route can reuse it when threading `briefMode` into a `session/new`
 * payload — keeping a single source of truth for the wording.
 */
export const BRIEF_OUTPUT_SNIPPET =
  "Respond concisely. Skip preamble, headers, and bullet-list filler. Direct answers only — match length to the question."

/**
 * Snippet appended to `appendSystemPrompt` when the session is in plan mode
 * (`permissionMode === "plan"`). Re-exported from the shared single source
 * (`plan-mode-prompt.ts`) that the CLI's `PLAN_MODE_PROMPT_SECTION` also
 * re-exports — the two surfaces must not drift. The export name is kept for
 * the ACP route and tests.
 */
export const PLAN_MODE_SNIPPET = PLAN_MODE_PROMPT

type SummaryCredentials = NonNullable<
  NonNullable<NonNullable<SendOptions["compaction"]>["summary"]>["credentials"]
>

interface SummaryProviderResolution {
  model?: string
  protocol: string
  /** Built-in provider id backing `credentials`; see ResolvedCompaction.summary. */
  providerId: string
  credentials: SummaryCredentials
  protocolAdapterSpec?: SendOptions["protocolAdapterSpec"]
}

function buildProtocolAdapterSpec(
  protocol: string
): Promise<SendOptions["protocolAdapterSpec"] | undefined> {
  return (async () => {
    const { getProtocolAdapter } =
      await import("@cognia/provider-core/providers/protocol-adapter-registry")
    const adapterDef = getProtocolAdapter(protocol)
    if (!adapterDef) return undefined
    if (adapterDef.spec.kind === "code") {
      const sep = protocol.indexOf(":")
      return {
        kind: "code",
        pluginId: sep > 0 ? protocol.slice(0, sep) : protocol,
        adapterId: protocol,
      }
    }
    return adapterDef.spec
  })()
}

async function resolveSubscriptionBackedSummaryCredentials(
  providerId: string,
  resolved?: { apiKey?: string; baseURL?: string },
  accountId?: string | null
): Promise<SummaryCredentials | null> {
  if (isOpencodeChatProviderId(providerId) && !resolved?.apiKey) {
    const vaultCred = await resolveOpencodeVaultCredential(providerId, accountId)
    if (!vaultCred) return null
    return {
      apiKey: vaultCred.apiKey,
      baseURL: resolved?.baseURL ?? vaultCred.baseURL,
    }
  }

  if (isCodexChatProviderId(providerId)) {
    const vaultCred = await resolveCodexVaultCredential(providerId, accountId)
    if (!vaultCred) return null
    if (!resolved?.apiKey) {
      return {
        apiKey: vaultCred.apiKey,
        baseURL: vaultCred.baseURL,
        ...(vaultCred.headers ? { headers: vaultCred.headers } : {}),
      }
    }
    const configuredBase = resolved.baseURL?.replace(/\/+$/, "")
    const vaultBase = vaultCred.baseURL.replace(/\/+$/, "")
    const chatGptBase = CODEX_CHATGPT_BASE_URL.replace(/\/+$/, "")
    const configuredUsesChatGptBackend =
      configuredBase === chatGptBase || configuredBase === vaultBase
    return {
      apiKey: resolved.apiKey,
      baseURL: resolved.baseURL,
      ...(configuredUsesChatGptBackend && vaultCred.headers ? { headers: vaultCred.headers } : {}),
    }
  }

  return null
}

async function resolveSummaryProviderForCompaction(args: {
  providerId: string
  summaryModel?: string
  appSettings: AppSettings
}): Promise<SummaryProviderResolution | null> {
  const accountId = resolveAccountId(args.providerId, null, null, args.appSettings)
  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: args.appSettings.defaultProvider,
    providerSettings: args.appSettings.providerSettings as
      Record<string, import("@/lib/ai/provider-consumption").ProviderSettingsEntry> | undefined,
    customProviders: args.appSettings.customProviders as
      import("@/lib/ai/provider-consumption").RichCustomProviderEntry[] | undefined,
  })
  const r = resolveFeatureProvider(
    {
      featureId: "chat-compaction-summary",
      routeProfile: "general-text",
      selectionMode: "explicit-provider",
      providerId: args.providerId,
      fallbackMode: "none",
    },
    snapshot
  )

  if (r.kind === "resolved") {
    const vaultCredentials = await resolveSubscriptionBackedSummaryCredentials(
      args.providerId,
      { apiKey: r.apiKey, baseURL: r.baseURL },
      accountId
    )
    const credentials: SummaryCredentials = vaultCredentials ?? {
      apiKey: r.apiKey,
      baseURL: r.baseURL,
    }
    // A summary credential with no API key is only legitimate for a genuinely
    // keyless provider: a local inference engine (Ollama / LM Studio / …) or a
    // user-configured custom provider (self-hosted, base URL typed by hand). For
    // a cloud built-in (OpenRouter / DeepSeek / Groq / …) whose base URL was
    // merely auto-filled from the catalog, a missing key means the provider is
    // not fully configured — fall back to the main (authenticated) model instead
    // of firing an unauthenticated request that 401s at compaction time.
    const keylessAllowed = isLocalProvider(args.providerId) || r.isCustomProvider
    if (!credentials.apiKey && !keylessAllowed) return null
    if (!credentials.apiKey && !credentials.baseURL) return null
    if (r.apiFlavor) credentials.apiFlavor = r.apiFlavor
    const protocolAdapterSpec = await buildProtocolAdapterSpec(r.protocol)
    return {
      model: args.summaryModel ?? r.model,
      protocol: r.protocol,
      providerId: args.providerId,
      credentials,
      ...(protocolAdapterSpec ? { protocolAdapterSpec } : {}),
    }
  }

  if (r.nextAction === "enable_provider") return null

  if (isOpencodeChatProviderId(args.providerId) || isCodexChatProviderId(args.providerId)) {
    const credentials = await resolveSubscriptionBackedSummaryCredentials(
      args.providerId,
      undefined,
      accountId
    )
    if (!credentials) return null
    const protocolAdapterSpec = await buildProtocolAdapterSpec("openai")
    return {
      model: args.summaryModel ?? getBuiltInProviderDefaultModel(args.providerId),
      protocol: "openai",
      providerId: args.providerId,
      credentials,
      ...(protocolAdapterSpec ? { protocolAdapterSpec } : {}),
    }
  }

  return null
}

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
  /**
   * Which agent this turn belongs to, for lifecycle-hook scoping
   * (`HookGroup.agents`). Defaults to `"chat"` — override from the surfaces
   * that resolve options for a non-chat turn (team chat per-member sends).
   */
  agentKind?: import("@/lib/claude/hooks").HookAgentKind
  /** Receives the already-resolved execution spec stamped onto this send. */
  onResolvedExecutionSpec?: (
    spec: import("@cognia/agent-config-types/agent-execution").ResolvedAgentExecutionSpec
  ) => void
  /** Override the resolving character — used by team chat per-member sends. */
  character?: Character | null
  appSettings?: AppSettings | null
  /**
   * The active workspace (project). Its `rootDir` feeds the cwd resolution
   * chain (between the session override and the character default) and its
   * `additionalDirs` are unioned into `additionalDirectories` alongside any
   * @-referenced paths.
   *
   * This is the workspace THIS TURN runs in, which is the session's own
   * workspace — NOT necessarily the one active in the UI. Direct chat resolves
   * it via `resolveSessionWorkspace` (`lib/workspace/session-workspace.ts`);
   * team/connector/diagnostics paths pass `null` to opt out.
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
   * Workspace roots with an explicit Workspace Trust grant. Native Claude SDK
   * skills/plugins are local provider-visible content, so the sidecar enables
   * them only when this proof accompanies the send. That trust grant is the
   * explicit disclosure boundary; native file contents are not PII-rewritten.
   */
  trustedWorkspaceRoots?: string[]
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
   * Projected dispatcher id of the subagent the user `@`-mentioned for THIS
   * turn (resolved by `resolveTargetAgentId` from the composer text). When it
   * names an agent actually registered in `opts.agents`, the turn runs AS that
   * subagent (SDK-native `agent` field on the Anthropic path; synthetic overlay
   * on ai-sdk). An unknown / stale id is silently dropped — the SDK requires the
   * agent to be defined. Direct chat only; team/connector paths leave it unset.
   */
  targetAgentId?: string
  /** Active source-control namespace for branch-scoped learned memories. */
  memoryBranch?: string
  /** Workspace-relative active/referenced path for path-scoped learned memories. */
  memoryPath?: string
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
   * Caller identifier stamped on the M6 inject-log entry when twin injection
   * runs (e.g. "chat" / "team"). Defaults to "chat" when omitted. Purely
   * diagnostic — it only labels the Settings inject-log ring buffer.
   */
  twinInjectSource?: string
  /**
   * Optional hint for the routing engine's context-window pre-check: the
   * outgoing prompt text. A rough CJK-aware token estimate is derived from it
   * and alias entries whose window can't fit the input are deprioritized.
   * Absent → the check is skipped (no-info passthrough).
   */
  routingContextHint?: { promptText?: string }
  /**
   * Routing surface for non-chat callers that reuse the canonical send-option
   * builder. Defaults to chat; Agent execution sets this to agent so plans,
   * affinity, and traces stay attributed to the immutable Agent ticket.
   */
  routingSurface?: import("@cognia/provider-types/auto-router").RoutingSurface
  /** Semantic Agent model role. Normal chat/dispatch defaults to `execute`. */
  modelRole?: import("@cognia/agent-config-types").AgentModelRole
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
   * Optional project-scoped RAG dependencies (workspace knowledge base). When
   * supplied AND `projectKnowledgeUserMessage` is set AND the active workspace
   * (`activeProject`) has knowledge files AND project RAG is enabled,
   * `resolveSendOptions` invokes `applyProjectKnowledgeContext` and APPENDS a
   * "Project knowledge base" section — coexisting with, never replacing, the Twin
   * / Memory sections. Reuses the twin deps shape (built by
   * `tryBuildProjectKnowledgeDeps`, which shares the twin vector store). Undefined
   * → project knowledge injection skipped.
   */
  projectKnowledgeDeps?: TwinRuntimeDepsForBuild
  /**
   * The user's current message text for project-knowledge retrieval. Usually the
   * same value as `twinUserMessage`; kept separate so a caller can drive one
   * without the other. Ignored when `projectKnowledgeDeps` is missing.
   */
  projectKnowledgeUserMessage?: string
  /**
   * Per-message ephemeral skill ids unioned with the active character's
   * `skillIds`. The composer's SkillPicker drives this; the chat send hook
   * is expected to clear the store slice after dispatch. Disabled skills
   * and ids already on the character are de-duped at resolve time.
   */
  ephemeralSkillIds?: string[]
  /**
   * How resolved skills enter the system prompt:
   *   - `"full"` (default / absent) — each skill's whole markdown body is
   *     appended via `renderSkillsSection` (legacy behaviour).
   *   - `"name"` — only a name + description CATALOG is appended via
   *     `renderSkillsCatalog` (progressive disclosure); the caller is expected to
   *     expose a tool the agent calls to load a skill's full instructions on
   *     demand. The CLI sets this so a session with many enabled skills doesn't
   *     pay their full token weight every turn. Desktop callers leave it absent.
   */
  skillRenderMode?: "full" | "name" | "hybrid"
  /**
   * Active `/goal` for this session (ADR-0019). When set AND
   * `activeGoal.status === "active"`, the resolver appends a
   * `renderGoalSystemSection(activeGoal)` block to `opts.appendSystemPrompt`
   * — keeping `baseSystem` / character / skill / mode sections untouched.
   * The chat-send hook pulls this from Dexie via
   * `getGoalRuntime().getActiveGoalForSession()`; team chat passes `null` to
   * opt out.
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
   * `true` when a `/loop` run is driving this session's turns. Unlike
   * `activeGoal`, the loop has no per-turn Dexie row the resolver reads — the
   * loop driver (`lib/loop/turn-driver.ts`) sets this flag so the surface-aware
   * built-in skills (lib/skills/surface-activation.ts) treat a loop the same as
   * a goal (the `goal-loop` surface). Direct chat leaves it undefined.
   */
  activeLoop?: boolean
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
  /**
   * Pre-fetched connector rows threaded from the connector runtime so the
   * resolver skips re-reading the same immutable rows from Dexie within one
   * inbound ai-run. `imOverrideRow` feeds the per-channel provider/model
   * override + computer-use gate; `imAdapterRow` feeds the A2UI capability
   * matrix. `undefined` (the default, and what direct chat / other callers
   * pass) keeps the resolver's own dynamic-import Dexie read; `null` means
   * "looked up, none found" and also skips the read.
   */
  imOverrideRow?: ConversationOverrideRow | null
  imAdapterRow?: AdapterInstanceRow | null
  /**
   * Pre-resolved composition selection (ADR-0117 axes).
   *
   * Set by the connector runtime so an IM turn composes from its own Dexie
   * config stack. Without it `resolveTurnComposition` falls through to
   * `compositionForSession()`, which reads the localStorage-backed zustand
   * store — meaning every IM turn silently inherited whatever the desktop user
   * last picked in the composer chip. Direct chat leaves this undefined and
   * keeps that store read, which is correct there.
   */
  compositionSelection?: AgentCompositionSelectionV1
  /**
   * Pre-resolved MCP server list, injected by desktop-independent callers
   * (the standalone agent CLI) that cannot reach Dexie. When provided —
   * including an empty array — the resolver uses it verbatim instead of
   * calling `listEnabledMcpServers()`. `undefined` keeps the default Dexie
   * lookup, so the desktop path is unchanged.
   */
  preloadedMcpServers?: Awaited<ReturnType<typeof listEnabledMcpServers>> | null
  /**
   * Pre-resolved per-call environment, injected by desktop-independent callers
   * that cannot reach the Rust account/proxy resolvers (which require Tauri
   * IPC). When defined — including `null` for "no env" — the resolver skips
   * `resolveAccountEnv`/`resolveProxyEnv` and forwards this map as `opts.env`.
   * `undefined` keeps the default desktop resolution.
   */
  preloadedEnv?: Record<string, string> | null
  /**
   * Marks a LIVE, user-facing turn that must receive token-level partial
   * messages even though it injects `preloadedEnv` / `preloadedMcpServers`
   * (the standalone agent CLI's interactive TUI). Without it those preloaded
   * fields make `isInteractiveSend` false, so the native Anthropic SDK never
   * streams `stream_event` deltas — and a long single generation (e.g. writing
   * a large file) emits no events for >60s, starving the run-and-capture idle
   * watchdog into a spurious "stream idle for 60000ms" interrupt. Headless /
   * request-response callers (mobile companion API) leave this undefined so
   * they keep consuming only the final result. Connector / nested-dispatch are
   * still excluded independently via `conversationKey` / `dispatchContext`.
   */
  interactive?: boolean
  /**
   * Nested-dispatch context (depth-N subagents). Present ONLY when this build is
   * for a dispatched subagent run (set by `agent-executor`). When present, the
   * resolver (a) suppresses the SDK-native `opts.agents` injection so the child
   * never gets BOTH the uncontrolled SDK Task tool and our `dispatch_agent`, and
   * (b) exposes the `dispatch_agent` host tool only while `depth < maxDepth`.
   */
  dispatchContext?: import("@/lib/claude/agents/dispatch-context-registry").DispatchContext
  /**
   * True when this run is a dispatched subagent (set by `dispatchSubagent` →
   * `executeAgent`). A dispatched run WITHOUT a `dispatchContext` is a leaf
   * (its def never opted into nesting): `resolveDispatchAgentGate` withholds
   * `dispatch_agent` from it — including the plan-mode force-offer — instead
   * of treating it as top-level chat (CLI leaf parity).
   */
  isDispatchedSubagent?: boolean
  /**
   * Parent permission ceiling for a dispatched child run. When present,
   * `resolveSendOptions` intersects `allowedTools`, unions `disallowedTools`,
   * and clamps `permissionMode` against it as the FINAL step (after the plugin
   * `onBuildOptions` hook), so nothing downstream can re-widen a tool the parent
   * forbade. Set by `agent-executor` from `ExecuteAgentConfig.permissionCeiling`
   * and by the team sidecar path from the team→teammate cascade. Absent for
   * top-level chat (no parent ⇒ no ceiling).
   */
  permissionCeiling?: import("@/lib/ai/agent/external/permission-cascade").ExternalSessionPermissionSpec
  /**
   * Surface that owns this turn — drives the agent-trace root span's `surface`.
   * Defaults to "chat". Connector ai-runs pass "connector", workflow nodes
   * "workflow", team member sends "agent-team".
   */
  traceSurface?: SpanSurface
  /** Final per-run identity supplied by durable execution owners before minting. */
  executionIdentity?: Partial<AgentExecutionIdentity>
  /**
   * Pre-minted parent trace. When set (and `emitTrace`), `resolveSendOptions`
   * does NOT mint a new root span; it stamps these ids onto `SendOptions`
   * verbatim so this send nests under an existing turn (e.g. a team member
   * inheriting the team root).
   */
  parentTrace?: TraceContext
  /**
   * Opt IN to root-span minting. The resolver only mints a root span when this
   * is `true`, because the CALLER owns the span lifecycle — it must call
   * `endSpan(opts.spanId)` when the turn closes (the chat hook does this in its
   * result / error branches). Callers that cannot close the span (headless
   * runners, diagnostics dumps, eval targets) leave this unset so no span
   * leaks. The minted ids land on `SendOptions.{traceId,spanId}`.
   */
  emitTrace?: boolean
  /**
   * One-shot post-compaction recovery (ADR — compaction). Set by a send hook for
   * exactly the FIRST turn after a compaction boundary appeared in the transcript
   * (the hook derives this from `deriveContextPhases` and de-dupes per boundary).
   * When present AND compaction is enabled, the resolver appends
   * `buildPostCompactionRecovery(...)` to `appendSystemPrompt` so the model
   * re-orients on the authoritative summary and carries durable operational
   * instructions across the boundary. Absent on every other turn.
   */
  postCompaction?: {
    /** Phase number the recovery turn opens (for diagnostics / labels). */
    phaseNumber: number
    /** Durable operational instructions to re-assert (e.g. team coordination). */
    durableInstructions?: string
  }
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
  store: IVectorStore
  embedding: {
    provider: RagEmbeddingProvider
    model: string
    apiKey: string
    baseURL?: string
    /**
     * Amazon Bedrock connection settings. Unlike the other providers, Bedrock
     * is not configured by `apiKey` + `baseURL` alone — the auth mode decides
     * whether credentials come from a key, explicit IAM, or the ambient AWS
     * chain, and the endpoint derives from the region. `tryBuildTwinDeps`
     * already forwards this; the type just never carried it.
     */
    bedrock?: BedrockConnectionSettings
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
    /** Whole-pool scorer (LLM reranker). See `lib/twin/runtime/reranker.ts`. */
    batchScorer?: (
      query: string,
      candidates: readonly { id: string; content: string; score: number; sourceTitle?: string }[]
    ) => number[] | Promise<number[]>
  }
  /**
   * Optional LLM query-expansion (HyDE / step-back). Structural mirror of
   * `apply-twin-context:ApplyTwinContextDeps.expansion`; the ai-sdk model handle
   * is typed as `unknown` here so build-options stays decoupled from the twin
   * module (the `applyTwinContext` cast bridges it).
   */
  expansion?: { model: unknown; strategy: "hyde" | "stepback" }
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
/**
 * Plugin-manifest tools that semantic tool routing must never prune. These are
 * flow-control / capability-agnostic tools: the model calls them based on the
 * conversation state (pause-and-ask, delegate) rather than the prompt's topic,
 * so a low semantic similarity score is meaningless — and dropping `ask_user`
 * in particular leaves a later call with no relay (its timeout is disabled),
 * hanging the turn forever.
 */
const NEVER_PRUNE_TOOLS: ReadonlySet<string> = new Set([
  ASK_USER_TOOL_NAME,
  DISPATCH_AGENT_TOOL_NAME,
  TASK_TOOL_NAME,
])

/** Agent scheduler tools are opt-in per IM conversation; never globally offered. */
export { IM_SCHEDULER_TOOL_NAMES as SCHEDULER_AGENT_TOOL_NAMES } from "@/lib/connectors/im-permission-ceiling"
import { IM_SCHEDULER_TOOL_NAMES as SCHEDULER_AGENT_TOOL_NAMES } from "@/lib/connectors/im-permission-ceiling"

/**
 * The dispatchable-subagent list seeding the `dispatch_agent` enum + discovery.
 * `disabled` defs are already excluded by the resolver; `hidden` defs stay in
 * the enum (they hide from UI pickers only); policy-denied ids are dropped so
 * the model never sees them (OpenCode `permission.task` semantics).
 */
async function listDispatchAgentAvailable(
  rules?: import("@/lib/claude/permissions/ruleset").ToolRules
): Promise<Array<{ id: string; description: string }>> {
  try {
    const [{ resolveDispatchableSubagents }, { isSubagentDispatchAllowed }] = await Promise.all([
      import("@/lib/claude/agents/subagents"),
      import("@/lib/claude/agents/subagent-dispatch-policy"),
    ])
    return resolveDispatchableSubagents()
      .filter((x) => isSubagentDispatchAllowed(rules, x.id))
      .map((x) => ({ id: x.id, description: x.def.description }))
  } catch {
    return []
  }
}

/**
 * Decide whether — and at what depth — the `dispatch_agent` host tool is offered
 * on this build. Returns `undefined` (tool withheld) when nesting is off, there
 * are no dispatchable subagents, or the session isn't a nesting surface.
 *
 * `permissionMode` is the already-resolved mode: in `plan` mode the tool is
 * force-offered (Claude Code parity — plan mode dispatches read-only Explore/Plan
 * subagents to research before proposing), even when the user hasn't turned on
 * subagent nesting, because the dispatched child inherits the read-only `plan`
 * ceiling and cannot make edits.
 */
async function resolveDispatchAgentGate(
  ctx: BuildOptionsContext,
  permissionMode?: string
): Promise<
  | {
      enabled: boolean
      depth: number
      maxDepth: number
      available: Array<{ id: string; description: string }>
    }
  | undefined
> {
  const { session, appSettings, dispatchContext } = ctx
  const subagentRules = appSettings?.agentPermissions?.subagentRules
  // Nested subagent run: the manifest builder withholds the entry once
  // `depth >= maxDepth`, so expose with the run's own depth here.
  if (dispatchContext) {
    const available = await listDispatchAgentAvailable(subagentRules)
    if (available.length === 0) return undefined
    return {
      enabled: true,
      depth: dispatchContext.depth,
      maxDepth: dispatchContext.maxDepth,
      available,
    }
  }
  // A dispatched child WITHOUT a dispatchContext is a leaf (its def never set
  // `allowNesting`): never offer dispatch_agent — including the plan-mode
  // force-offer below, which is a top-level-only affordance. Otherwise a
  // plan-mode Explore/Plan child would be re-offered dispatch and could nest
  // unboundedly (the CLI enforces leaf children; this is the GUI parity).
  if (ctx.isDispatchedSubagent) return undefined
  // Top-level direct chat: offered when the user enabled nesting OR the session
  // is in plan mode (read-only research dispatch). Never on the workflow-editor /
  // team surfaces, which keep their SDK-native subagent surface.
  const nesting = appSettings?.subagentNesting
  const isNestingSurface = session?.kind !== "workflow-editor" && session?.kind !== "team"
  const planMode = permissionMode === "plan"
  if (isNestingSurface && (nesting?.enabled === true || planMode)) {
    const available = await listDispatchAgentAvailable(subagentRules)
    if (available.length === 0) return undefined
    return { enabled: true, depth: 0, maxDepth: nesting?.maxDepth ?? 2, available }
  }
  return undefined
}

/**
 * Tiny bounded-LRU set used by the IM prompt-fragment memos below. Evicts the
 * oldest key once `cap` is reached. Private to the resolver.
 */
function lruSet<V>(cache: Map<string, V>, key: string, value: V, cap: number): void {
  if (cache.size >= cap && !cache.has(key)) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

// Memo for the per-channel A2UI capability prompt. Its inputs
// (`lastKnownCapabilities` + `lastKnownSkillCapabilities`) change only when the
// adapter row is rewritten, which always bumps `updatedAt`
// (adapter-instances.ts:88) — so `${id}:${updatedAt}:${platform}` invalidates
// exactly on a capability change while reusing the assembled string across a
// conversation's turns. Bounded so many adapters can't grow it without limit.
const CAPABILITY_PROMPT_CACHE_CAP = 32
const capabilityPromptCache = new Map<string, string>()

// Memo for the built-in skills manifest. Its output is a pure function of
// (platform, channel capabilities [static per platform], registry [static],
// override allowlist/access tier). The override row bumps `updatedAt` when its
// `allowedBuiltInSkillIds` change, so the key captures every input. Manifest
// entries carry NO per-conversation data (manifest.ts:88), so sharing the result
// across conversations on the same platform/override is safe.
const BUILTIN_SKILLS_MANIFEST_CACHE_CAP = 32
const builtInSkillsManifestCache = new Map<
  string,
  Awaited<ReturnType<typeof import("@/lib/skills/built-in/manifest").buildBuiltInSkillManifest>>
>()

/** Test-only — clear the IM prompt-fragment memos between cases. */
export function _resetImPromptMemosForTest(): void {
  capabilityPromptCache.clear()
  builtInSkillsManifestCache.clear()
}

/**
 * Whether the team behind this dispatch session exposes any Employee Digital
 * Twin knowledge source (a member's bound `twinId` or a team-level
 * `knowledgeTwinIds`). Gates the `twin_knowledge_search` collaboration tool so
 * it is never offered as a dead capability. Best-effort — a twin-bound current
 * teammate is a sufficient signal even if the store lookup fails.
 */
async function teamHasKnowledgeTwins(
  sessionId: string,
  currentTwinId: string | undefined
): Promise<boolean> {
  if (currentTwinId) return true
  try {
    const { getTeamDispatchContext } = await import("@/lib/claude/agents/dispatch-context-registry")
    const teamId = getTeamDispatchContext(sessionId)?.teamId
    if (!teamId) return false
    const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
    const state = useAgentTeamStore.getState()
    if ((state.teams[teamId]?.config.knowledgeTwinIds?.length ?? 0) > 0) return true
    return Object.values(state.teammates).some(
      (t) => t.teamId === teamId && Boolean(t.config?.twinId)
    )
  } catch {
    return false
  }
}

/**
 * Whether this turn should surface the Pro-IDE-only editor write tools — and,
 * with them, their baked-in consent tier.
 *
 * Three conditions, all of them real: a project to act inside, a workspace
 * filesystem backend (the same gate the read tool uses), and a shell that can
 * host code-server at all. Never throws: a failure to answer means "do not
 * surface", because the write tools are an enhancement and no turn should fail
 * over their absence.
 */
async function proIdeWriteToolsAvailable(ctx: BuildOptionsContext): Promise<boolean> {
  if (!ctx.activeProject) return false
  try {
    const [{ hasWorkspaceFsBackend }, { hasCapability }] = await Promise.all([
      import("@/lib/files/workspace-backend"),
      import("@/lib/platform/capabilities"),
    ])
    return hasWorkspaceFsBackend() && hasCapability("pro-ide")
  } catch {
    return false
  }
}

export async function resolveSendOptions(ctx: BuildOptionsContext): Promise<SendOptions> {
  const { session, appSettings, memberOverride } = ctx
  // Which workspace's capability overlay this turn obeys. The session's own
  // workspace wins over the UI pointer for the same reason the cwd does: a
  // background turn in a conversation the user has navigated away from must
  // keep the skills and servers of the repo it is working in, not of whatever
  // is on screen. Only a turn with no workspace at all falls back.
  const capabilityScope = { projectId: session?.projectId ?? ctx.activeProject?.id ?? null }
  // Name the turn for lifecycle-hook scoping. Everything resolved here is a
  // chat-session turn; the surfaces that are NOT (teammate dispatch, plan
  // steps, dispatched subagents) overwrite `agentKind` on the options they
  // hand to `runAndCaptureAssistantReply`. Without a default, `agents: "chat"`
  // would match nothing — an unidentified turn never matches a narrowed hook.
  const opts: SendOptions = { agentKind: ctx.agentKind ?? "chat" }

  // --- Resolve the active character -----------------------------------------
  let character = ctx.character ?? null
  if (!character && session?.characterId) {
    // ADR-0030: resolveCharacterById falls through to the plugin-overlay
    // pack registry when the id is a synthetic `cognia-pack:` runtime id,
    // so a session bound to a plugin-contributed character keeps working
    // without a Dexie row.
    character = (await resolveCharacterById(session.characterId)) ?? null
  }
  const supportAgent = isSupportAgentId(character?.id)
  const agentExecutionPolicy = resolveAgentExecutionPolicy(
    character?.executionPolicy,
    session?.executionPolicy
  )
  if (agentExecutionPolicy.maxTurns !== undefined) {
    opts.maxTurns = agentExecutionPolicy.maxTurns
  }

  // --- Resolve skills: character.skillIds ∪ ephemeralSkillIds, minus session-disables.
  // Honour the per-skill `status` flag — disabled skills don't get appended,
  // even if the character references them or the user attached them ad-hoc.
  // Non-fatal: a missing/legacy row that has no status is treated as enabled.
  let skills: Skill[] = []
  const characterSkillIds = character?.skillIds ?? []
  const ephemeralIds = ctx.ephemeralSkillIds ?? []
  if (characterSkillIds.length || ephemeralIds.length) {
    // Shared resolution (character ∪ ephemeral − session-disabled, deduped)
    // so the send path and the chat UI never drift on the effective set.
    const wantedIds = activeEffectiveSkillIds({
      characterSkillIds,
      ephemeralSkillIds: ephemeralIds,
      disabledIds: session?.disabledSkillIds ?? [],
    })
    if (wantedIds.length) {
      skills = await listEnabledSkillsByIds(wantedIds, capabilityScope)
    }
  }
  // ADR-0106 controlled trial. The recorded skill is saved `disabled` on
  // purpose — enabling it is the user's separate act after the trial — so it
  // cannot come through the resolution above, which honours that flag. Loading
  // it by id here is what makes the trial actually exercise the skill instead
  // of opening an empty chat; it replaces the set rather than joining it, which
  // is the "nothing else can explain the result" property the trial is for.
  if (session?.trialSkillId) {
    skills = await listSkillsByIds([session.trialSkillId])
  }
  const explicitSkillIds = new Set(
    session?.trialSkillId ? [session.trialSkillId] : (ctx.ephemeralSkillIds ?? [])
  )
  const explicitSkills = skills.filter((skill) => explicitSkillIds.has(skill.id))
  const implicitSkills = skills.filter(
    (skill) => !explicitSkillIds.has(skill.id) && skill.invocationPolicy !== "explicit"
  )
  // An explicit-only character skill is intentionally absent from both the
  // catalog and the tool whitelist. An ephemeral attachment remains explicit.
  skills = [...implicitSkills, ...explicitSkills]
  // Bump usage counters for the skills that actually made it into the prompt.
  // Fire-and-forget: a failed write here shouldn't block the send.
  const immediatelyInjectedSkills =
    ctx.skillRenderMode === "hybrid" ? explicitSkills : ctx.skillRenderMode === "name" ? [] : skills
  if (immediatelyInjectedSkills.length > 0) {
    void recordSkillUsage(immediatelyInjectedSkills.map((s) => s.id)).catch(() => undefined)
  }

  // --- Agent Mode (built-in / custom / plugin) ----------------------------
  // Reads the active mode id from `useAgentRuntimeStore` unless ctx supplies
  // an explicit override. Modes are a *prompt modifier* — their systemPrompt
  // appends to the base prompt (under the same `---` separator as skills) and
  // their tools union into the allowedTools whitelist.
  // Resolved from THIS SESSION's composition (ADR-0117), not the app-wide
  // `modeId`. `preset` carries the prompt delta and tool set — including for
  // Minimal / Code / Creator, which have no mode record at all — while `mode`
  // stays the legacy record that owns the model / temperature overrides.
  const turnMode = resolveTurnAgentMode({
    explicitMode: ctx.agentMode,
    sessionId: session?.id,
  })
  const activeMode = turnMode.mode
  const activePreset = turnMode.preset

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
  if (ctx.imOverrideRow !== undefined) {
    // The connector runtime already fetched this row (bus Step 3) and threaded
    // it through — reuse it instead of a second Dexie read. `null` ⇒ no override.
    imOverrideRow = ctx.imOverrideRow ?? undefined
  } else if (session?.platformBinding?.adapterId && session.platformBinding.conversationKey) {
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

  // Bot-instance AI binding defaults (W1 multi-bot). Hoisted next to the
  // override read so the model/provider/effort chains and the capability
  // block below share ONE adapter-row read. Same threading contract as
  // `imOverrideRow`: `undefined` → resolver does its own best-effort Dexie
  // read for platform-bound sessions (covers desktop-inbox sends the bus
  // never saw); `null` → looked up, none found, skip.
  let imAdapterRow = ctx.imAdapterRow ?? undefined
  if (ctx.imAdapterRow === undefined && session?.platformBinding?.adapterId) {
    try {
      const { getAdapterInstance } = await import("@/lib/db/adapter-instances")
      imAdapterRow = await getAdapterInstance(session.platformBinding.adapterId)
    } catch {
      // Best-effort — a missing adapter row must not crash the send; the
      // chain simply skips the bot-default layer.
    }
  }
  // Empty strings saved by a blanked-out settings field must not shadow the
  // character / app defaults.
  const imDefaultModel = imAdapterRow?.defaultModel?.trim() || undefined
  const imDefaultProvider = imAdapterRow?.defaultProvider?.trim() || undefined

  // --- Model: IM channel override > per-session > member override > mode override > bot default > character > app default ------
  // The bot-instance default deliberately BEATS `character.model`: an
  // operator pinning a model on a bot expects that model even when the
  // persona declares one (D1). Explicit `/model` and per-session choices
  // still win. Alias-valued defaults resolve through the alias engine below
  // like every other source.
  const agentModel = resolveAgentModel(
    ctx.modelRole ?? "execute",
    character,
    appSettings?.defaultModel
  )
  let model: string | undefined =
    imModelOverride ??
    session?.model ??
    memberOverride?.modelOverride ??
    modeUpdate?.model ??
    imDefaultModel ??
    agentModel

  // --- Provider: IM channel override > per-session override > bot default > character > app default > "anthropic" -----
  // The sidecar uses `provider` to pick which dispatcher (`anthropic` vs the
  // generic `ai-sdk` runner) to invoke. Credentials travel inline so the
  // sidecar never reads keys from disk. Resolution is best-effort: when the
  // selected provider has no key configured we leave both fields off and
  // let the sidecar fall back to ANTHROPIC_API_KEY (legacy path) — that
  // best-effort semantic also covers a stale bot-default provider id.
  let providerId =
    imProviderOverride ??
    session?.providerOverride ??
    imDefaultProvider ??
    character?.providerId ??
    appSettings?.defaultProvider ??
    "anthropic"
  const requestedEffort =
    imOverrideRow?.reasoningOverride ??
    session?.effort ??
    session?.executionPolicy?.effort ??
    imAdapterRow?.defaultReasoning ??
    character?.executionPolicy?.effort ??
    appSettings?.defaultEffort

  // Rough text of the outgoing prompt (CJK-aware sizing happens later). Only the
  // text the caller handed us — history/system additions are not counted, which
  // keeps auto-routing + the token estimate conservative-but-cheap.
  const promptText = ctx.routingContextHint?.promptText ?? ctx.twinUserMessage

  // Concrete provider:model choices remain hard overrides, while still
  // entering the planner once so declared capabilities and data policy are
  // validated consistently with aliases and Auto.
  const enabledAliases = new Set(
    (appSettings?.modelMappings ?? [])
      .filter((mapping) => mapping.enabled !== false)
      .map((mapping) => mapping.alias.toLowerCase())
  )
  const autoRequested = Boolean(
    appSettings?.autoRouting?.enabled &&
    (model === "auto" || (!session?.model && appSettings.autoRouting.defaultSelection === "auto"))
  )
  const aliasRequested =
    !autoRequested && model && enabledAliases.has(model.toLowerCase()) ? model : undefined
  const manualRequested = Boolean(!autoRequested && !aliasRequested && model && providerId)

  if (appSettings && (autoRequested || aliasRequested || manualRequested)) {
    const registry = createMappingRegistry(appSettings.modelMappings ?? [])
    const routingConfig = appSettings.routingConfig ?? DEFAULT_ROUTING_CONFIG
    // Persisted breaker settings (global enable + defaults) and per-provider
    // circuit overrides (allowed_fails / cooldown_time) apply before the
    // engine consults breaker state. Idempotent merge.
    applyCircuitBreakerSettings(routingConfig)
    // Live-store-backed deps shared with the routing-tab preview panel —
    // health metrics, circuit breaker, today-spend mirror, rate window,
    // pricing, and the context-window resolver all live in
    // `lib/ai/routing/build-preview-engine.ts`.
    const deps: RoutingEngineDeps = buildRoutingEngineDeps(appSettings)
    // Rough token estimate of the outgoing prompt (CJK-aware). Uses the hoisted
    // `promptText` (also feeds auto-routing above). History/system additions are
    // not counted, keeping the check conservative-but-cheap (no awaits).
    const estimatedInputTokens =
      promptText && promptText.length > 0 ? estimateCJKTokenCount(promptText) : undefined
    const engine = new ProviderRoutingEngine(registry, routingConfig, deps)
    const manualFallbackModel = autoRequested && model !== "auto" ? model : undefined
    const manualFallbackProvider = providerId
    let plan: import("@cognia/provider-types/auto-router").RoutingPlan | undefined
    try {
      plan = await engine.planRoute({
        surface: ctx.routingSurface ?? "chat",
        selection: autoRequested
          ? { kind: "auto" }
          : aliasRequested
            ? { kind: "alias", alias: aliasRequested }
            : { kind: "manual", providerId, modelId: model! },
        estimatedInputTokens,
        promptText,
        candidateAliases: appSettings.autoRouting?.candidateAliases,
        thresholds: appSettings.autoRouting?.thresholds,
        requirements: manualRequested
          ? undefined
          : {
              tools: Boolean(
                character?.allowedTools?.length ||
                activePreset?.defaultToolSet?.length ||
                skills.some((skill) => (skill.allowedTools?.length ?? 0) > 0)
              ),
              reasoning: Boolean(requestedEffort),
              streaming: appSettings.streamPartialMessages !== false,
            },
        sessionId: session?.id,
        strategy: routingConfig.strategy,
        dataPolicy: appSettings.autoRouting?.dataPolicy,
        shadowMode: appSettings.autoRouting?.shadowMode,
      })
    } catch (err) {
      if (err instanceof RoutingNoCandidatesError && manualFallbackModel) {
        model = manualFallbackModel
        providerId = manualFallbackProvider
        delete opts.autoRouting
      } else {
        throw err
      }
    }
    if (plan) {
      const selected = plan.selected
      const selectedAlias = appSettings.modelMappings?.find(
        (mapping) =>
          mapping.enabled !== false &&
          mapping.providers.some(
            (candidate) =>
              candidate.providerId === selected.providerId && candidate.modelId === selected.modelId
          )
      )?.alias
      const fallbackEntries = plan.orderedCandidates.slice(1).map((candidate) => ({
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        ...(candidate.weight !== undefined ? { weight: candidate.weight } : {}),
        ...(candidate.conditions ? { conditions: candidate.conditions } : {}),
      }))
      model = selected.modelId
      providerId = selected.providerId
      opts.routingPlan = plan
      if (autoRequested) {
        opts.autoRouting = {
          score: scoreDifficulty(promptText ?? ""),
          tier: selectedAlias ?? plan.classification?.complexity ?? "auto",
        }
      }
      if (!manualRequested) {
        opts.aliasResolution = {
          alias: aliasRequested ?? selectedAlias ?? "auto",
          resolvedTo: { providerId: selected.providerId, modelId: selected.modelId },
          fallbackEntries,
          // Flatten the strongly-typed ModelMappingParameterDefaults into the
          // opaque map the SendOptions wire shape carries. The renderer + Rust
          // struct treat this as metadata only; the sidecar ignores it.
          parameterDefaults: plan.parameterDefaults as Record<string, unknown> | undefined,
          // Error-class routing metadata: the renderer retry path acts on
          // these without a registry lookup.
          ...(plan.specialFallbacks ? { specialFallbacks: plan.specialFallbacks } : {}),
          ...(plan.retryPolicy ? { retryPolicy: plan.retryPolicy } : {}),
        }
      }
      opts.routingDecision = {
        strategy: plan.strategy,
        reason: plan.reasonCodes.join(", "),
        ...(plan.overBudgetWarning ? { overBudgetWarning: plan.overBudgetWarning } : {}),
      }
      // Activate the Claude Agent SDK's NATIVE in-turn model fallback. When the
      // alias resolved to Anthropic and the chain has a sibling Anthropic model,
      // hand it to the SDK so a mid-turn overload / 5xx retries against that
      // model WITHOUT a renderer round-trip. The renderer-side
      // `attemptRoutingFallback` still covers cross-provider + cross-request
      // failover; this is purely the cheap same-provider in-turn path. Only the
      // Anthropic dispatcher reads `fallbackModel`; the ai-sdk path ignores it,
      // so we skip non-Anthropic resolutions to keep the wire shape honest.
      if (selected.providerId === "anthropic") {
        const sibling = fallbackEntries.find(
          (entry) => entry.providerId === "anthropic" && entry.modelId !== selected.modelId
        )
        if (sibling) opts.fallbackModel = sibling.modelId
      }
    }
  }

  const accountId = resolveAccountId(
    providerId,
    session ?? null,
    character ?? null,
    appSettings ?? null
  )
  // Validate and resolve the selected account before provider-specific bridge
  // credentials. This guarantees stale/mismatched explicit references surface
  // as SubscriptionAccountResolutionError instead of a generic bridge error.
  let accountEnv: Record<string, string>
  let proxyEnv: Record<string, string>
  if (ctx.preloadedEnv !== undefined) {
    accountEnv = ctx.preloadedEnv ?? {}
    proxyEnv = {}
  } else {
    ;[accountEnv, proxyEnv] = await Promise.all([
      resolveAccountEnv(providerId, accountId),
      resolveProxyEnv(session?.id ?? null),
    ])
  }

  if (model) opts.model = model
  if (providerId) {
    opts.provider = providerId
    if (appSettings) {
      const attemptOptions = await resolveProviderAttemptOptions(providerId, appSettings, accountId)
      opts.providerCredentials = attemptOptions.providerCredentials
      opts.protocolAdapterSpec = attemptOptions.protocolAdapterSpec
      opts.modelParams = attemptOptions.modelParams
      if (!opts.model && attemptOptions.defaultModel) opts.model = attemptOptions.defaultModel
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
  const cacheOptimizationEnabled = appSettings?.cacheOptimizationEnabled !== false
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
      const { applyTwinContext, recordTwinInject } = await import("@/lib/twin/runtime")
      const twinStartedAt = Date.now()
      const result = await applyTwinContext({
        character,
        userMessage: ctx.twinUserMessage,
        precomputedQueryEmbedding: ctx.precomputedQueryEmbedding,
        deps: ctx.twinDeps as Parameters<typeof applyTwinContext>[0]["deps"],
      })
      const twinPromptBlocked = Boolean(
        result.applied &&
        !hasNoLeakingPiiDeep(
          result.applied.cacheSegments ?? { systemPrompt: result.applied.systemPrompt }
        )
      )
      if (result.applied && !twinPromptBlocked) {
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
        !twinPromptBlocked &&
        (result.retrievedChunks.length > 0 ||
          result.selectedStyleSamples.length > 0 ||
          result.degraded)
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
          ...(result.citations ? { citations: result.citations } : {}),
        }
      }
      // Record the call in the M6 inject-log ring buffer so the Settings
      // "Twin injection log" card can confirm this turn used the twin profile.
      // Done last (after prompt assembly) so a logging slip can never undo the
      // injected prompt; diagnostic-only and never blocks the send.
      await recordTwinInject({
        ts: Date.now(),
        twinId: character.twinId,
        source: ctx.twinInjectSource ?? "chat",
        applied: Boolean(result.applied && !twinPromptBlocked),
        degraded: twinPromptBlocked || (result.degraded ?? false),
        degradedReason: twinPromptBlocked ? "prompt-pii-blocked" : (result.degradedReason ?? null),
        chunkCount: result.retrievedChunks?.length ?? 0,
        styleSampleCount: result.selectedStyleSamples?.length ?? 0,
        tokensApprox:
          result.applied && !twinPromptBlocked
            ? estimateFallbackTokens(result.applied.systemPrompt ?? baseSystem)
            : 0,
        durationMs: Date.now() - twinStartedAt,
        chunkIds: result.retrievedChunks.map(({ chunk }) => chunk.id),
        chunkScores: result.retrievedChunks.map((chunk) => chunk.score),
        styleSampleIds: result.selectedStyleSamples.map((sample) => sample.id),
        ...(ctx.session?.id ? { sessionId: ctx.session.id } : {}),
      })
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
    const memoryPolicy = resolveAgentMemoryPolicy({
      config: memoryConfig,
      session: session ?? undefined,
      agentPolicy: character?.memoryPolicy,
    })
    await import("@/lib/db/memory-governance")
      .then(({ appendMemoryAuditEvent }) =>
        appendMemoryAuditEvent({
          action: memoryPolicy.canRecall ? "recall-allowed" : "recall-denied",
          sessionId: session?.id,
          reason: memoryPolicy.recallReason,
        })
      )
      .catch(() => undefined)
    if (memoryPolicy.canRecall) {
      try {
        const { applyMemoryContext } = await import("@/lib/memory/runtime/apply-memory-context")
        const twinChunkTexts =
          opts.twinContext?.retrievedChunks.map((c) => c.chunk.contentRedacted) ?? []
        const readableScopes = new Set(memoryPolicy.readableScopes)
        const scopedMemoryDeps = {
          ...ctx.memoryDeps,
          loadCandidates: async (
            reader?: Parameters<NonNullable<typeof ctx.memoryDeps>["loadCandidates"]>[0]
          ) =>
            (await ctx.memoryDeps!.loadCandidates(reader)).filter((memory) =>
              readableScopes.has(memory.scope)
            ),
          loadProcedural: async (
            reader?: Parameters<NonNullable<typeof ctx.memoryDeps>["loadProcedural"]>[0]
          ) =>
            (await ctx.memoryDeps!.loadProcedural(reader)).filter((memory) =>
              readableScopes.has(memory.scope)
            ),
        }
        const result = await applyMemoryContext({
          userMessage: ctx.memoryUserMessage,
          reader: {
            characterId: character?.id,
            projectId: session?.projectId ?? ctx.activeProject?.id,
            agentId: resolveMemoryAgentNamespace({
              targetAgentId: ctx.targetAgentId,
              twinId: character?.twinId,
              characterId: character?.id,
            }),
            branch: ctx.memoryBranch,
            path: ctx.memoryPath,
          },
          topK: memoryConfig.retrievalTopK,
          relevanceFloor: memoryConfig.relevanceFloor,
          maxTokens: memoryConfig.recallTokenBudget,
          twinChunkTexts,
          enableQueryExpansion: memoryConfig.enableQueryExpansion,
          recencyHalfLifeDays: memoryConfig.decayHalfLifeDays,
          // Reuse the turn's query embedding (memory's vector backend shares the
          // twin embedding model via resolveMemoryBackend) — no re-embed.
          precomputedQueryEmbedding: ctx.precomputedQueryEmbedding,
          deps: scopedMemoryDeps,
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
              evidenceState: m.evidenceState,
              reviewStatus: m.reviewStatus,
            })),
            proceduralCount: result.proceduralCount,
            withheldCount: result.withheldCount,
            budget: result.budget,
            degraded: result.degraded,
          }
        }
      } catch {
        // Memory runtime failure is non-fatal — keep the prompt as-is.
      }
    }
  }

  // --- Project knowledge base injection (project-scoped RAG) ---------------
  // When `projectKnowledgeDeps` + `projectKnowledgeUserMessage` are supplied and
  // the active workspace has knowledge files (and project RAG is enabled),
  // retrieve the most relevant chunks and APPEND a "Project knowledge base"
  // section. Coexists with the Twin (persona) + Memory (user facts) sections —
  // it never replaces `baseSystem`. The runtime never throws; failures degrade
  // silently. Query-dependent, so it rides the dynamic tail under cache
  // optimization (like memory) to stay out of the cacheable prefix.
  let projectKnowledgeSection = ""
  if (
    ctx.projectKnowledgeDeps &&
    ctx.projectKnowledgeUserMessage &&
    ctx.projectKnowledgeUserMessage.trim() &&
    ctx.activeProject &&
    (ctx.activeProject.knowledgeBase?.length ?? 0) > 0
  ) {
    const knowledgeSettings = resolveProjectKnowledgeSettings(ctx.activeProject.knowledgeSettings)
    if (knowledgeSettings.enableProjectRag) {
      try {
        const { applyProjectKnowledgeContext } =
          await import("@/lib/project-knowledge/runtime/apply-project-context")
        const fileNames: Record<string, string> = {}
        for (const f of ctx.activeProject.knowledgeBase ?? []) fileNames[f.id] = f.name
        const result = await applyProjectKnowledgeContext({
          projectId: ctx.activeProject.id,
          userMessage: ctx.projectKnowledgeUserMessage,
          topK: knowledgeSettings.ragTopK,
          precomputedQueryEmbedding: ctx.precomputedQueryEmbedding,
          fileNames,
          deps: ctx.projectKnowledgeDeps as Parameters<
            typeof applyProjectKnowledgeContext
          >[0]["deps"],
        })
        if (result.systemPromptSection) {
          if (cacheOptimizationEnabled) {
            dynamicTailSections.push(result.systemPromptSection)
          } else {
            projectKnowledgeSection = result.systemPromptSection
          }
        }
        if (result.retrievedChunks.length > 0 || result.degraded) {
          opts.projectKnowledgeContext = {
            retrievedChunks: result.retrievedChunks,
            degraded: result.degraded,
          }
        }
      } catch {
        // Project-knowledge runtime failure is non-fatal — keep the prompt as-is.
      }
    }
  }

  // --- Reusable Agent Knowledge Base injection -----------------------------
  // Bound libraries are independent of Project/Twin ownership and are queried
  // in parallel. The shared vector backend is reused, while each library keeps
  // its own collection and failure boundary.
  let agentKnowledgeSection = ""
  if (
    (character?.knowledgeBaseIds?.length ?? 0) > 0 &&
    ctx.projectKnowledgeDeps?.vectorBackend &&
    ctx.projectKnowledgeUserMessage?.trim()
  ) {
    try {
      const { applyAgentKnowledgeContextFromDb } =
        await import("@/lib/knowledge-base/runtime/apply-agent-knowledge-context")
      const result = await applyAgentKnowledgeContextFromDb({
        knowledgeBaseIds: character?.knowledgeBaseIds ?? [],
        userMessage: ctx.projectKnowledgeUserMessage,
        topKPerBase: 5,
        tokenBudget: 2_000,
        precomputedQueryEmbedding: ctx.precomputedQueryEmbedding,
        runtimeDeps: ctx.projectKnowledgeDeps as Parameters<
          typeof applyAgentKnowledgeContextFromDb
        >[0]["runtimeDeps"],
      })
      if (result.systemPromptSection) {
        if (cacheOptimizationEnabled) dynamicTailSections.push(result.systemPromptSection)
        else agentKnowledgeSection = result.systemPromptSection
      }
      if (result.retrievedChunks.length > 0 || result.degraded) {
        opts.agentKnowledgeContext = {
          retrievedChunks: result.retrievedChunks,
          citations: result.citations,
          failures: result.failures,
          budget: result.budget,
          degraded: result.degraded,
        }
      }
    } catch {
      // Reusable Knowledge Base retrieval is best-effort and never blocks send.
    }
  }

  // --- Working directory ---------------------------------------------------
  // Shared chain (see lib/workspace/effective-cwd.ts): per-session override →
  // active workspace root → character default → app default. Resolved here
  // (ahead of the system-prompt assembly) because project instruction discovery
  // below keys off it. The composer / settings UI resolve through the same
  // helper so what the user sees always matches what the send uses.
  const cwd = resolveEffectiveCwd({
    sessionWorkingDir: session?.workingDir,
    // The durable execution binding wins over the workspace root: a
    // `managedWorktree` session is leased into a bundle alias, and everything
    // resolved from `cwd` below — instruction discovery, the sandbox placement
    // — must see that alias rather than the source checkout the agent is not
    // writing to. Undefined until a binding exists, so a brand-new managed
    // session's first turn still resolves through the workspace root.
    executionWorkspaceRoot: session?.executionContext
      ? resolveSessionWorkspaceRoot(session.executionContext)
      : undefined,
    activeProject: ctx.activeProject,
    characterWorkingDir: character?.workingDir,
    defaultWorkingDir: appSettings?.defaultWorkingDir,
  })
  if (cwd) opts.cwd = cwd

  // --- Project instruction files (CLAUDE.md / AGENTS.md / AGENT.md) --------
  // Discover on-disk instruction files across the active workspace's roots
  // (layered up-tree walk + @import expansion) and the `.cognia/agents/*.md`
  // markdown subagents. The section joins the stable prompt prefix below; the
  // discovered subagents merge into `opts.agents` in the session-kind branch
  // further down. Skipped for `--bare` (no on-disk auto-discovery, Claude Code
  // parity) and for workflow-editor sessions (whole prompt is overwritten).
  // Best-effort: a failure never blocks the send.
  let instructionSection = ""
  let projectMarkdownAgentFiles: MarkdownAgentFile[] = []
  const skipDiscovery = session?.bareMode ?? character?.bareMode ?? appSettings?.bareMode
  if (!skipDiscovery && session?.kind !== "workflow-editor") {
    try {
      const { loadProjectInstructions } = await import("@/lib/claude/instructions/load")
      const instructionsConfig = character?.instructionsOverride ?? appSettings?.instructions
      const resolved = await loadProjectInstructions({
        cwd,
        roots: ctx.activeProject ? allRootPaths(ctx.activeProject) : [],
        config: instructionsConfig,
      })
      instructionSection = resolved.section
      projectMarkdownAgentFiles = resolved.markdownAgentFiles
    } catch (err) {
      console.warn("project instruction load failed:", err)
    }
  }

  // The skills block is the one part of the system prompt that grows with the
  // user's library rather than with the turn, so it gets a ceiling. Bounded
  // and NAMED: a block that shrank silently is indistinguishable from skills
  // the user forgot to enable, which is why this reports the level it reached.
  const skillBudget = {
    maxTokens: DEFAULT_SKILL_CATALOG_TOKEN_BUDGET,
    onDegrade: (report: { block: string; level: string; omitted: string[]; tokens: number }) => {
      loggers.app.warn("skills block exceeded its prompt budget", {
        ...report,
        maxTokens: DEFAULT_SKILL_CATALOG_TOKEN_BUDGET,
        omittedCount: report.omitted.length,
      })
    },
  }

  // Name-only mode (CLI progressive disclosure) renders a compact catalog
  // instead of every skill's full body — the agent pulls a skill's instructions
  // on demand via the caller's load tool. Absent / "full" keeps the legacy
  // whole-body append, so desktop behaviour is unchanged.
  let skillSection = ""
  if (ctx.skillRenderMode === "name") {
    skillSection = renderSkillsCatalog(skills, skillBudget)
  } else if (ctx.skillRenderMode === "hybrid") {
    const [{ listResourcesForSkill }, runtime, tools] = await Promise.all([
      import("@/lib/db/skill-resources"),
      import("@/lib/skills/runtime-loader"),
      import("@/lib/claude/skill-builtin-tools"),
    ])
    const resourcesById = new Map(
      await Promise.all(
        skills.map(async (skill) => [skill.id, await listResourcesForSkill(skill.id)] as const)
      )
    )
    const explicitSection = explicitSkills
      .map((skill) => runtime.renderSkillWithResources(skill, resourcesById.get(skill.id) ?? []))
      .join("\n\n")
    const catalogSection = renderSkillsCatalog(implicitSkills, skillBudget)
    skillSection = [explicitSection, catalogSection].filter(Boolean).join("\n\n")
    if (session?.id && skills.length > 0) {
      runtime.registerSkillLoadContext(session.id, {
        skills,
        explicitSkillIds: explicitSkills.map((skill) => skill.id),
      })
      opts.pluginTools = [
        ...(opts.pluginTools ?? []),
        ...tools.buildProgressiveSkillManifestEntries(
          skills,
          [...resourcesById.values()].some((resources) => resources.length > 0)
        ),
      ]
    } else if (session?.id) {
      runtime.clearSkillLoadContext(session.id)
    }
  } else {
    skillSection = renderSkillsSection(skills, skillBudget)
  }
  // Substitute agent-mode prompt template variables ({{date}} / {{tools_list}} /
  // {{mode_name}} / …) the custom-mode editor advertises — without this the
  // literal `{{…}}` tokens are sent to the model verbatim.
  // Read off the preset, not the mode record: `presetFromAgentMode` maps
  // `systemPrompt`/`tools` onto `systemPromptDelta`/`defaultToolSet` 1:1, so
  // this is identical for every mode-backed preset — and it is the only way
  // Minimal / Code / Creator, which have no mode record, contribute at all.
  const rawModeSection = activePreset?.systemPromptDelta?.trim() || ""
  const modeSection = rawModeSection
    ? processPromptTemplateVariables(rawModeSection, {
        modeName: activePreset?.name,
        modeDescription: activePreset?.description,
        tools: activePreset?.defaultToolSet ? [...activePreset.defaultToolSet] : undefined,
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
      const resolvedPlugin = await resolveSkillsForCharacter(
        character.pluginSkillIds,
        capabilityScope
      )
      // Anthropic-managed ("container") skills cannot be delivered through the
      // Claude Agent SDK: no `query()` option attaches uploaded skill_ids
      // (verified against sdk 0.3.x — see `skills-bridge.ts`). Rather than
      // silently drop them (the old `opts.containerSkillIds` was ignored by the
      // SDK), surface a clear warning so users aren't misled. `inline` /
      // `local-folder` plugin skills still work — they fold into the prompt via
      // `renderResolvedSkillsSection` below.
      const containerSkillIds = extractContainerSkillIds(resolvedPlugin)
      if (containerSkillIds.length > 0) {
        console.warn(
          `[cognia] ${containerSkillIds.length} Anthropic-managed (container) skill(s) are ` +
            `selected but cannot be attached — the Claude Agent SDK exposes no option to ` +
            `attach uploaded skill_ids, so these skills will not run: ` +
            containerSkillIds.map((s) => s.skill_id).join(", ")
        )
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
    instructionSection,
    memorySection,
    projectKnowledgeSection,
    agentKnowledgeSection,
    modeSection,
    skillSection,
    pluginSkillSection,
  ]
    .filter((p) => p && p.trim().length > 0)
    .join("\n\n---\n\n")
  if (systemPrompt) opts.systemPrompt = systemPrompt

  // Light up the `InstructionsLoaded` lifecycle hook (ADR-0040 follow-up): the
  // system prompt + instruction sections have just been assembled. Fire-and-
  // forget + observational — never awaited, so it adds no latency to this hot
  // path and never blocks a send. No-ops on web / when no hook is configured.
  void defaultLifecycleFirer(
    "InstructionsLoaded",
    {
      agentId: "build-options",
      // Carries the same identity this send was just resolved with, so an
      // `agents`-narrowed InstructionsLoaded hook scopes like the rest.
      agentKind: opts.agentKind as import("@/lib/claude/hooks").HookAgentKind,
      sessionId: ctx.session?.id ?? "session",
    },
    { payload: { hasSystemPrompt: Boolean(systemPrompt) } }
  )

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
  // `turnMode.requestedAuthority` sits where the legacy `plan` / `build` mode
  // ids used to: those are now axis values on the composition rather than mode
  // records, so without this rung selecting Plan would stop being read-only.
  // It is deliberately NOT the fully resolved authority — see
  // `resolveTurnAgentMode`, which withholds a preset's mere *recommendation*
  // so a preset can never silently shadow the character or the app default.
  const permissionMode =
    session?.permissionMode ??
    turnMode.requestedAuthority ??
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
  //
  // Two storage layers merge here: the legacy Bash-only `commandRules` and
  // the per-tool `toolRules` (multi-tool generalization, edited in Settings →
  // Agent → Permissions). toolRules wins on conflicts (later argument). The
  // result is key-sorted so the serialized SendOptions stay byte-identical
  // across turns (provider prompt-cache prefix matching).
  //
  // The Pro IDE editor tools carry a baked-in tier (`editor-tool-rules`) as the
  // LOWEST layer, so `save_editor_buffers` asks by default while the four
  // viewport-only tools do not — and an explicit user rule still overrides
  // either way. It is a genuine exception to "only explicit rules are sent":
  // without it every one of the five would prompt on every call, since a
  // non-shell tool with no rule falls through to a human approval.
  //
  // Gated on the same condition that surfaces the tools, not merely on desktop:
  // rules for tools this turn never offers are inert payload, and emitting them
  // unconditionally would also break the "no rules configured → no ruleset at
  // all" invariant that keeps SendOptions byte-identical across turns for the
  // provider prompt cache.
  // Whether this send has an artifact dock on the other end. An IM-bound
  // session does not: a chart or canvas artifact would arrive as raw JSON.
  // Hoisted here because the SAME answer gates three things — the routing
  // prompt (ADR-0139), the artifact tool manifest, and the consent tier below.
  // The routing prompt advertising a chart artifact while the tool that makes
  // one is absent is the exact mismatch this file used to ship.
  const artifactsChannelAvailable = !session?.platformBinding?.adapterId
  const artifactAuthoringEnabled =
    artifactsChannelAvailable && appSettings?.artifacts?.agentAuthoring !== false

  const editorWriteToolsSurfaced = await proIdeWriteToolsAvailable(ctx)
  const commandRules = appSettings?.agentPermissions?.commandRules
  const toolRules = appSettings?.agentPermissions?.toolRules
  const { buildEditorToolRuleset } = await import("@/lib/claude/permissions/editor-tool-rules")
  const { buildArtifactToolRuleset } = await import("@/lib/claude/permissions/artifact-tool-rules")
  const mergedRuleset = mergeRulesets(
    editorWriteToolsSurfaced ? buildEditorToolRuleset() : undefined,
    artifactAuthoringEnabled ? buildArtifactToolRuleset() : undefined,
    commandRules && Object.keys(commandRules).length > 0 ? { Bash: commandRules } : undefined,
    toolRules
  )
  // Fold in what the user REFUSED in this conversation. A refusal becomes an
  // explicit `deny`, which `canUseTool` honours ahead of `alwaysAllowTools` —
  // so a later widening cannot resurrect something already turned down. If the
  // session refused more than the memory can track it fails closed here: every
  // auto-approval is stripped and the session asks about everything, rather
  // than pretending a refusal it can no longer hold is still in force.
  const { applySessionDenials } = await import("@/lib/claude/permissions/session-denials")
  const sessionPermissions = applySessionDenials(session?.id, {
    ruleset: mergedRuleset,
    ...(appSettings?.alwaysAllowTools && appSettings.alwaysAllowTools.length > 0
      ? { alwaysAllowTools: [...appSettings.alwaysAllowTools].sort() }
      : {}),
  })

  if (Object.keys(sessionPermissions.ruleset).length > 0) {
    opts.permissionRuleset = deterministicRulesetSort(sessionPermissions.ruleset)
  }

  // Session-global "Allow always" list — honored directly in the sidecar gates
  // so an always-allowed tool skips the redundant `permission_request`
  // round-trip (previously only the renderer's `allowListRef` short-circuited).
  // Sorted for prompt-cache stability.
  if (sessionPermissions.alwaysAllowTools && sessionPermissions.alwaysAllowTools.length > 0) {
    opts.alwaysAllowTools = sessionPermissions.alwaysAllowTools
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
  for (const t of activePreset?.defaultToolSet ?? []) allowed.add(t)
  if (
    imOverrideRow?.allowScheduleTools === true &&
    adapterAllowsHostCapability(imAdapterRow, "schedule_tools")
  ) {
    for (const tool of SCHEDULER_AGENT_TOOL_NAMES) allowed.add(tool)
  }
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
  // The IM scopes' own switch, conversation over bot. `undefined` at both means
  // "whatever this channel supports", i.e. the channel-capability default
  // computed below — which is the behaviour that used to be unconditional.
  const imA2uiPreference = imOverrideRow?.a2uiEnabled ?? imAdapterRow?.a2uiEnabled
  let connectorCapabilityPrompt: string | null = null
  if (session?.platformBinding?.adapterId) {
    try {
      // Reuse the adapter row hoisted next to the imOverrideRow read (one
      // read serves the model/provider/effort chains AND this capability
      // block, whether threaded from the bus or fetched here).
      const adapterRow = imAdapterRow
      const matrix = adapterRow?.lastKnownCapabilities
      if (adapterRow && matrix && Object.keys(matrix).length > 0) {
        const capCacheKey = `${adapterRow.id}:${adapterRow.updatedAt}:${session.platformBinding.platform}`
        const cachedPrompt = capabilityPromptCache.get(capCacheKey)
        if (cachedPrompt !== undefined) {
          connectorCapabilityPrompt = cachedPrompt
        } else {
          const { buildCapabilityPromptSection } =
            await import("@/lib/connectors/a2ui-bridge/capability-evaluator")
          // ADR-0026 — also pass the cached built-in skill capabilities so
          // the prompt declares which lark.* (and future) skill families
          // this channel can serve. Intersected against the per-channel
          // allowlist below.
          connectorCapabilityPrompt = buildCapabilityPromptSection(
            session.platformBinding.platform,
            matrix,
            adapterRow.lastKnownSkillCapabilities
          )
          lruSet(
            capabilityPromptCache,
            capCacheKey,
            connectorCapabilityPrompt,
            CAPABILITY_PROMPT_CACHE_CAP
          )
        }
      }
    } catch {
      // Best-effort — missing adapter row / capability matrix shouldn't
      // crash the send; just skip the prompt injection.
    }
  }
  const a2uiEnabled = imA2uiPreference ?? (baseA2uiEnabled || connectorCapabilityPrompt !== null)
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
      // Lazily loaded together — resolving the projection pulls in every
      // adapter's capability const, and a desktop turn with no IM binding
      // should not pay for that at module load.
      const { capabilityFingerprint, effectiveCapabilities, effectiveCapabilitiesForRow } =
        await import("@/lib/connectors/effective-capabilities")
      // Memo key: every input that shapes the manifest. Platform + isImSession
      // gate the platform/access/requires filters; the override's `updatedAt`
      // bumps whenever its `allowedBuiltInSkillIds` change.
      //
      // Channel capabilities used to be static per platform and were left out
      // of the key on that basis. They are per-INSTANCE now — a Slack grant
      // without `files:write` hides the upload skills — so the key carries
      // `capabilityFingerprint`, or two bots on the same platform would share
      // one tool list and the second would inherit the first's permissions.
      const capabilityKey =
        session?.platformBinding?.adapterId && imAdapterRow
          ? capabilityFingerprint({
              platform: imAdapterRow.type,
              settings: imAdapterRow.settings,
              implMetadata: imAdapterRow.implMetadata,
              transportMode: imAdapterRow.transportMode,
            })
          : "none"
      const skillsCacheKey = `${session?.platformBinding?.platform ?? "none"}:${Boolean(
        session?.platformBinding?.adapterId
      )}:${imOverrideRow?.id ?? "none"}:${imOverrideRow?.updatedAt ?? 0}:${capabilityKey}`
      const cachedManifest = builtInSkillsManifestCache.get(skillsCacheKey)
      if (cachedManifest !== undefined) {
        builtInSkillsManifest = cachedManifest
      } else {
        // Side-effect import so every family's registerBuiltInSkill() runs
        // before the manifest builder walks the registry.
        await import("@/lib/skills/built-in")
        const { buildBuiltInSkillManifest } = await import("@/lib/skills/built-in/manifest")
        // Resolve what the bound channel can ACTUALLY serve, so the manifest's
        // `requires` filter hides skills that would fail (a skill needing
        // `rich-card.lark` for its HITL confirm card; an upload skill on a
        // Slack grant without `files:write`). Instance-level, from the stored
        // row — no live adapter build needed. Desktop (no binding) leaves this
        // undefined; the filter no-ops there. Without the row (a lookup that
        // failed) the projection falls back to the platform table, which is
        // what this call site used unconditionally before.
        let channelCapabilities:
          readonly import("@/types/connectors/capability").Capability[] | undefined
        if (session?.platformBinding?.adapterId) {
          channelCapabilities = imAdapterRow
            ? effectiveCapabilitiesForRow(imAdapterRow).capabilities
            : effectiveCapabilities({ platform: session.platformBinding.platform }).capabilities
        }
        builtInSkillsManifest = buildBuiltInSkillManifest({
          imBinding: session?.platformBinding?.adapterId
            ? {
                adapterId: session.platformBinding.adapterId,
                platform: session.platformBinding.platform,
                conversationKey: session.platformBinding.conversationKey ?? "",
              }
            : undefined,
          imOverrideRow: imOverrideRow ?? undefined,
          imAdapterRow: imAdapterRow ?? undefined,
          channelCapabilities,
        })
        lruSet(
          builtInSkillsManifestCache,
          skillsCacheKey,
          builtInSkillsManifest,
          BUILTIN_SKILLS_MANIFEST_CACHE_CAP
        )
      }
      // plugin.conversion is activated by its prompt skill (or the Skill
      // self-loader) and is appended through its own desktop/workspace gate
      // below. A character's broad enableBuiltInSkills switch must not expose
      // filesystem write tools that the user did not select.
      builtInSkillsManifest = builtInSkillsManifest.filter(
        (entry) => !entry.skillId.startsWith("plugin.conversion.")
      )
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
  // Gated on `a2uiEnabled`: this section tells the model which A2UI component
  // kinds degrade on this channel. Appending it to a turn that has no A2UI
  // tools describes an ability the model does not have.
  if (connectorCapabilityPrompt && a2uiEnabled) {
    const existing = opts.appendSystemPrompt?.trim() ?? ""
    opts.appendSystemPrompt = existing
      ? `${existing}\n\n${connectorCapabilityPrompt}`
      : connectorCapabilityPrompt
  }

  // ADR-0139 — which surface a picture should be. Resident rather than a skill:
  // "chart artifact, mermaid fence, A2UI or canvas?" has to be answered BEFORE
  // the model knows a skill exists, and a skill is only read once something
  // thinks to load one. The per-surface contracts stay in the skills; only the
  // routing is always on, and it is a short decision table.
  //
  // `artifacts` is false for an IM-bound session: there is no dock there, so a
  // fenced chart or canvas artifact would reach the reader as raw JSON.
  //
  // Hoisted because the SAME answer has to gate the artifact tool manifest
  // below. The routing prompt advertising a chart artifact while the tool that
  // makes one is absent is the exact mismatch this file used to ship.
  const visualOutputSection = buildVisualOutputSection({
    artifacts: artifactsChannelAvailable,
    a2ui: a2uiEnabled,
  })
  if (visualOutputSection) {
    const existing = opts.appendSystemPrompt?.trim() ?? ""
    opts.appendSystemPrompt = existing
      ? `${existing}\n\n${visualOutputSection}`
      : visualOutputSection
  }

  // --- MCP server subset ---------------------------------------------------
  // Resolution order:
  //   1. member override mcpServerIds (team chat only)
  //   2. character.mcpServerIds (if defined) → intersect with enabled
  //   3. team.mcpServerIds      (if team session, neither override nor char)
  //   4. fall back to all enabled servers
  try {
    // CLI / headless callers inject `preloadedMcpServers` (incl. `[]`) so the
    // resolver never touches Dexie; desktop leaves it undefined → Dexie lookup.
    const enabled = supportAgent
      ? []
      : (ctx.preloadedMcpServers ?? (await listEnabledMcpServers(capabilityScope)))
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
      const denied = new Set(opts.disallowedTools ?? [])
      // Async because glob deny rules expand against the capability cache —
      // a pattern the user saved has to keep covering tools the server grew
      // after they saved it.
      for (const tool of await resolveMcpDisallowedToolNames(chosen)) denied.add(tool)
      if (denied.size > 0) opts.disallowedTools = [...denied]

      // Desktop injects send-time OAuth bearer headers for remote (sse/http)
      // servers from the keyring; web / CLI stay header-only (no keyring).
      const { isTauri } = await import("@/lib/tauri")
      if (isTauri()) {
        // Inject the endpoint/scope-partitioned token and refresh near-expiry
        // credentials before handing a static header to the Anthropic/AI SDK
        // relays. The governed renderer runtime additionally handles explicit
        // 401s through its reconnect-once credential resolver.
        const [{ buildMcpServerMapWithAuth }, { mcpOAuthLoadEntry, mcpOAuthRefresh }] =
          await Promise.all([import("@/lib/db/mcp-servers"), import("@/lib/mcp/oauth-tauri")])
        opts.mcpServers = await buildMcpServerMapWithAuth(chosen, {
          loadEntry: (serverId, legacyName) => {
            const server = chosen.find((candidate) => candidate.id === serverId)
            return mcpOAuthLoadEntry(
              serverId,
              legacyName,
              server ? { transport: server.transport, config: server.config } : undefined
            )
          },
          refresh: (serverName) => {
            const server = chosen.find((candidate) => candidate.name === serverName)
            return server
              ? mcpOAuthRefresh(server.id, {
                  transport: server.transport,
                  config: server.config,
                })
              : Promise.resolve(undefined)
          },
        })
      } else {
        opts.mcpServers = await buildMcpServerMapResolved(chosen)
      }
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
    if (!supportAgent && lspEnabled && opts.cwd) {
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
  // path doesn't surface the Computer Use app-session tools to the model
  // when the character — or an IM-session
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
  const imHostCapabilities = resolveImHostCapabilities({
    adapter: imAdapterRow,
    override: imOverrideRow,
    characterComputerUseEnabled: character?.enableComputerUse,
  })
  const allowImComputerUse = imHostCapabilities.computer_use
  const computerUseAllowedForChat =
    character?.enableComputerUse === true && (!imSession || allowImComputerUse)

  // Agent browser tools (ADR-0055) drive the embedded preview webview, which
  // only exists in the desktop shell. Opt-in per character; never surfaced on
  // IM-bound sessions (no embedded webview there).
  const browserAllowedForChat = character?.enableBrowserTools === true && !imSession

  // OCR tool (`cognia-ocr` / `ocr.extract`, ADR-0024) is low-risk and
  // default-allowed everywhere (incl. IM); see `isOcrToolAllowed`.
  const ocrAllowedForChat =
    isOcrToolAllowed({
      character,
      imSession,
      allowOcrOverride: imOverrideRow?.allowOcr,
    }) &&
    (!imSession || imHostCapabilities.ocr)

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
  // contributes the app-session state/query/action tools. Filter
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
      // Nested dispatch — surface the `dispatch_agent` tool when (a) this build
      // is for a dispatched subagent below its depth cap, or (b) it's a
      // top-level direct chat and the user enabled nesting. Withheld otherwise
      // (default off → zero change). The cap-reached withholding is the depth-N
      // generalization of Claude Code dropping the Agent tool from subagents.
      const dispatchAgentGate = await resolveDispatchAgentGate(ctx, opts.permissionMode)
      let manifest = buildPluginToolsManifest({
        exposeDockToAgents,
        ...(dispatchAgentGate ? { dispatchAgent: dispatchAgentGate } : {}),
      })
      if (!computerUseAllowedForChat) {
        manifest = manifest.filter((entry) => entry.pluginId !== "cognia-computer-use")
      }
      if (!ocrAllowedForChat) {
        manifest = manifest.filter((entry) => entry.pluginId !== "cognia-ocr")
      }
      if (!browserAllowedForChat) {
        manifest = manifest.filter((entry) => entry.pluginId !== "cognia-browser-tools")
      }
      // Always drop the plugin's duplicate web_search/web_fetch. The promoted
      // tools are appended later only when web access resolves on; otherwise a
      // stale plugin registration would bypass the master switch.
      // The plugin's own web_download / web_research survive.
      manifest = manifest.filter(
        (entry) =>
          !(
            entry.pluginId === "cognia-web-tools" &&
            (entry.name === "web_search" || entry.name === "web_fetch")
          )
      )
      if (appSettings?.webTools?.enabled === false) {
        manifest = manifest.filter((entry) => entry.pluginId !== "cognia-deep-research")
      }
      // The capability-filtered manifest BEFORE semantic pruning. The ultracode
      // tier below re-attaches workflow entries from it, so that tier's tool
      // guarantee holds even when pruning would have dropped them for being a
      // poor semantic match for this particular prompt.
      const unprunedManifest = manifest
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
            const { pruneToolsSemantica } =
              await import("@cognia/provider-routing/semantic-tool-router")
            // Flow-control tools (`ask_user`, `dispatch_agent`/`Task`) are never
            // pruned: they are capability-agnostic — the model invokes `ask_user`
            // to pause and ask, and `dispatch_agent` to delegate, regardless of
            // the prompt's topic, so a low semantic score is meaningless. Worse,
            // dropping `ask_user` from the manifest means a later `ask_user` call
            // has no relay (its timeout is disabled) and the turn hangs forever.
            // Hold them aside, prune only the rest, then re-attach.
            const exempt = manifest.filter((entry) => NEVER_PRUNE_TOOLS.has(entry.name))
            const prunable = manifest.filter((entry) => !NEVER_PRUNE_TOOLS.has(entry.name))
            const pruned = await pruneToolsSemantica({
              query: semanticQuery,
              candidates: prunable.map((entry) => ({
                name: entry.name,
                description: entry.description,
                pluginId: entry.pluginId,
              })),
              settings: semanticSettings,
            })
            if (pruned) {
              const keep = new Set(pruned.kept.map((candidate) => candidate.name))
              manifest = [...exempt, ...prunable.filter((entry) => keep.has(entry.name))]
              loggers.app.info("semantic tool routing pruned plugin tools", {
                kept: manifest.length,
                pruned: pruned.prunedCount,
                exempt: exempt.length,
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
      // Graph-bodied skills (`kind:"workflow"`) instruct the model to call the
      // shared typed runner — that tool must therefore BE in the session
      // whenever such a skill is active, even when the `cognia-workflow-ai`
      // plugin is disabled (its registration normally provides it) or when
      // semantic pruning would have dropped it. Appended AFTER pruning so it
      // can't be pruned away; execution falls back to
      // `lib/workflow/publish/run-workflow-typed-tool.ts` via
      // `plugin-tool-ipc.ts` when the plugin isn't there to resolve it.
      if (skills.some((s) => s.kind === "workflow")) {
        const {
          WORKFLOW_RUNNER_TOOL_NAME,
          WORKFLOW_RUNNER_TOOL_DEFINITION,
          WORKFLOW_AI_PLUGIN_ID,
        } = await import("@/lib/workflow/publish/runner-tool")
        if (!combined.some((entry) => entry.name === WORKFLOW_RUNNER_TOOL_NAME)) {
          combined.push({
            name: WORKFLOW_RUNNER_TOOL_NAME,
            description: WORKFLOW_RUNNER_TOOL_DEFINITION.description,
            jsonSchema: WORKFLOW_RUNNER_TOOL_DEFINITION.parametersSchema,
            pluginId: WORKFLOW_AI_PLUGIN_ID,
          })
        }
      }
      // `ultracode` is the composite top thinking tier: `"xhigh"` effort (which
      // the tier persists as `ChatSession.effort`, so the effort chain below
      // needs no special case) PLUS the dynamic-workflow `wf_*` suite. The CLI
      // expresses that second half through its `config.pluginTools` gate; this
      // is the desktop/web equivalent.
      //
      // Two steps, both appended AFTER pruning so neither can be pruned away:
      // re-attach the workflow plugin's own entries when it IS enabled, and
      // fall back to the shared typed runner when it is not — the same seam,
      // and the same `plugin-tool-ipc.ts` executor, as the graph-bodied-skills
      // branch above. Choosing the tier is the opt-in; nothing here overrides a
      // per-character `disablePluginTools` (we are already inside that guard).
      if (isUltracodeLevel(resolveThinkingLevel(session))) {
        const {
          WORKFLOW_RUNNER_TOOL_NAME,
          WORKFLOW_RUNNER_TOOL_DEFINITION,
          WORKFLOW_AI_PLUGIN_ID,
        } = await import("@/lib/workflow/publish/runner-tool")
        const present = new Set(combined.map((entry) => entry.name))
        for (const entry of unprunedManifest) {
          if (entry.pluginId !== WORKFLOW_AI_PLUGIN_ID || present.has(entry.name)) continue
          present.add(entry.name)
          combined.push(entry)
        }
        if (!present.has(WORKFLOW_RUNNER_TOOL_NAME)) {
          combined.push({
            name: WORKFLOW_RUNNER_TOOL_NAME,
            description: WORKFLOW_RUNNER_TOOL_DEFINITION.description,
            jsonSchema: WORKFLOW_RUNNER_TOOL_DEFINITION.parametersSchema,
            pluginId: WORKFLOW_AI_PLUGIN_ID,
          })
        }
      }
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

  // First-class web tools — appended OUTSIDE the disablePluginTools gate and
  // AFTER semantic pruning so they are available whenever the turn's resolved
  // web access routes through Cognia. They round-trip through the same
  // plugin_tool_exec wire and resolve host-side in plugin-tool-ipc.
  //
  // WHICH implementation serves this turn is `lib/chat/web-access.ts`'s call,
  // not this file's: the composer's web control reads the same resolution, and
  // the two answering differently is exactly what this replaced. Native-first
  // (a subscription's SDK WebSearch/WebFetch costs no key and returns
  // citations); Cognia's provider-backed tools otherwise; and when there is
  // neither a native nor a configured provider, `web_search` is NOT surfaced —
  // it could only throw "no providers enabled" — while `web_fetch`, which
  // needs no key, still is.
  const { isStandaloneChatMode } = await import("@/lib/runtime/standalone-mode")
  const { resolveWebAccess, anthropicNativeWebSearch, externalAgentNativeWebSearch } =
    await import("@/lib/chat/web-access")
  // The OTHER runtime that can bring its own web search. Whether it does is a
  // property of the binary the user installed, not of the wire protocol, so the
  // only layer that can answer is the capability matrix — the user's own
  // declaration (`ExternalAgentConfig.declaredCapabilities`) or a live
  // observation. Every protocol row ships `unknown`, which is not usable, so an
  // undeclared agent keeps getting Cognia's pair: the safe direction to be
  // wrong in. Best-effort by construction — off the desktop, or before the
  // manager has a profile, this is simply `false`.
  const externalNativeWebSearch = await (async () => {
    try {
      const { useAgentRuntimeStore } = await import("@/stores/agent/agent-runtime-store")
      const runtimeState = useAgentRuntimeStore.getState()
      if (runtimeState.runtime !== "external" || !runtimeState.externalAgentId) return false
      const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      return externalAgentNativeWebSearch(
        getExternalAgentManager().getAgentCapabilityProfile(runtimeState.externalAgentId)
      )
    } catch {
      return false
    }
  })()
  // The legacy explicit opt-in. Its documented behaviour — pre-approve the two
  // natives into `allowedTools` and clear them from `disallowedTools` — is kept
  // verbatim for anyone who set it, and ONLY for them.
  const explicitNativeOptIn = appSettings?.webTools?.nativeOnAnthropic === true
  // Has anything already narrowed this turn's tool surface — a character's
  // allow-list, a skill's, the session's tool filter?
  //
  // It decides whether the natives can serve, because they are governed by that
  // list and the host-routed tools are not. Reaching for the natives on a
  // narrowed turn would mean either silently widening the list (and escaping a
  // filter that was applied further up this function) or leaving the turn with
  // no web at all, where today it still has the host-routed pair. Route those
  // turns through Cognia and both problems disappear.
  const surfaceNarrowed = (opts.allowedTools?.length ?? 0) > 0
  const webAccess = resolveWebAccess({
    ...(appSettings?.webTools ? { webTools: appSettings.webTools } : {}),
    nativeAvailable:
      (anthropicNativeWebSearch(providerId, isStandaloneChatMode()) &&
        (explicitNativeOptIn || !surfaceNarrowed)) ||
      // An external agent's own search is not governed by `allowedTools` — that
      // list filters the SDK's tools, and this runtime is not the SDK — so the
      // narrowing carve-out above does not apply to it.
      externalNativeWebSearch,
    ...(appSettings?.searchProviders ? { searchProviders: appSettings.searchProviders } : {}),
    ...(appSettings?.defaultSearchProvider
      ? { defaultSearchProvider: appSettings.defaultSearchProvider }
      : {}),
    ...(appSettings?.searchEnabled !== undefined
      ? { searchEnabled: appSettings.searchEnabled }
      : {}),
  })
  if (webAccess.search === "cognia" || webAccess.fetch === "cognia") {
    try {
      const { buildWebBuiltinManifestEntries } = await import("@/lib/claude/web-builtin-tools")
      opts.pluginTools = [
        ...(opts.pluginTools ?? []),
        ...buildWebBuiltinManifestEntries({
          search: webAccess.search === "cognia",
          fetch: webAccess.fetch === "cognia",
        }),
      ]
    } catch (err) {
      loggers.app.warn("failed to append web built-in tools", { error: String(err) })
    }
  }
  if (
    webAccess.reason === "disabled" &&
    anthropicNativeWebSearch(providerId, isStandaloneChatMode())
  ) {
    const denied = new Set(opts.disallowedTools ?? [])
    denied.add("WebSearch")
    denied.add("WebFetch")
    opts.disallowedTools = [...denied]
  }
  // Reaching native BY DEFAULT writes nothing: on an unnarrowed turn the SDK
  // already exposes WebSearch / WebFetch, and naming them in `allowedTools`
  // would convert "no filtering" into "these two and nothing else" — which a
  // parent permission ceiling then intersects down to the empty set.
  //
  // The legacy opt-in keeps its documented widening. It carries that same
  // empty-allow-list hazard, but it is a choice someone made explicitly and
  // narrowing it here would change behaviour nobody asked to change.
  //
  // Scoped to the SDK's natives: `WebSearch` / `WebFetch` are Agent-SDK tool
  // names, so pre-approving them for a turn that reads `native` because an
  // EXTERNAL agent brings its own search would name two tools that runtime has
  // never heard of — and, on an otherwise unfiltered turn, narrow it to them.
  if (
    webAccess.mode === "native" &&
    explicitNativeOptIn &&
    anthropicNativeWebSearch(providerId, isStandaloneChatMode())
  ) {
    const allow = new Set(opts.allowedTools ?? [])
    allow.add("WebSearch")
    allow.add("WebFetch")
    opts.allowedTools = [...allow]
    if (opts.disallowedTools?.length) {
      opts.disallowedTools = opts.disallowedTools.filter(
        (name) => name !== "WebSearch" && name !== "WebFetch"
      )
    }
  }

  // First-class editor context tool — read_active_editor (Pro IDE → agent).
  // Appended OUTSIDE the disablePluginTools gate when a workspace filesystem
  // backend exists (desktop), and resolved host-side in plugin-tool-ipc where the
  // renderer transport + PII gate live. On web/mobile there is no backend, so it
  // is not surfaced at all.
  try {
    const { hasWorkspaceFsBackend } = await import("@/lib/files/workspace-backend")
    if (ctx.activeProject && hasWorkspaceFsBackend()) {
      const { buildEditorBuiltinManifestEntries, buildEditorWriteManifestEntries } =
        await import("@/lib/claude/editor-builtin-tools")
      opts.pluginTools = [...(opts.pluginTools ?? []), ...buildEditorBuiltinManifestEntries()]
      // The write tools are Pro-IDE-only (native diff view, undo-able external
      // edit, explorer reveal), so they ride the same flag the consent tier was
      // gated on above — one source of truth, so the tools and their rules can
      // never be surfaced apart from each other.
      if (editorWriteToolsSurfaced) {
        opts.pluginTools = [...opts.pluginTools, ...buildEditorWriteManifestEntries()]
      }
    }
  } catch (err) {
    loggers.app.warn("failed to append editor built-in tool", { error: String(err) })
  }

  // Plugin conversion is a prompt-skill-backed capability, not a global
  // plugin-tool toggle. Preload its two typed tools when the skill is active,
  // or when the opt-in Skill self-loader may activate it during the turn.
  // The tools are desktop-only, require a confined workspace cwd/backend, and
  // remain available even when third-party plugin tools are disabled.
  const pluginConversionRequested =
    skills.some((skill) => skill.canonicalId === "builtin:plugin-conversion") ||
    appSettings?.selfInvokeTools?.skill === true
  if (pluginConversionRequested && !imSession && opts.cwd) {
    try {
      const { hasWorkspaceFsBackend } = await import("@/lib/files/workspace-backend")
      if (hasWorkspaceFsBackend()) {
        // Side-effect import registers the family before the manifest walk.
        await import("@/lib/skills/built-in")
        const { buildBuiltInSkillManifest } = await import("@/lib/skills/built-in/manifest")
        const conversionEntries = buildBuiltInSkillManifest({})
          .filter((entry) => entry.skillId.startsWith("plugin.conversion."))
          .map((entry) => ({
            name: entry.name,
            description: entry.description,
            jsonSchema: entry.jsonSchema,
            pluginId: entry.pluginId,
          }))
        const existing = new Set((opts.pluginTools ?? []).map((entry) => entry.name))
        opts.pluginTools = [
          ...(opts.pluginTools ?? []),
          ...conversionEntries.filter((entry) => !existing.has(entry.name)),
        ]
      }
    } catch (err) {
      loggers.app.warn("failed to append plugin conversion tools", { error: String(err) })
    }
  }

  // Agent self-invocation tools (Skill / SlashCommand). Opt-in (default off).
  // Like the web tools they are appended OUTSIDE the disablePluginTools gate and
  // round-trip through the same plugin_tool_exec wire, resolving host-side in
  // plugin-tool-ipc. Both are Claude Code parity surfaces.
  if (appSettings?.selfInvokeTools?.skill === true) {
    try {
      const { buildSkillManifestEntries } = await import("@/lib/claude/skill-builtin-tools")
      opts.pluginTools = [...(opts.pluginTools ?? []), ...buildSkillManifestEntries()]
    } catch (err) {
      loggers.app.warn("failed to append Skill built-in tool", { error: String(err) })
    }
  }

  // Artifact / Canvas authoring. On by default — the routing prompt above
  // already tells the model to reach for a chart artifact, and before these
  // tools existed the only way to make one was to hope the fence detector
  // lifted a code block at turn end.
  //
  // Withheld for an IM-bound session for the same reason the routing prompt
  // withholds the option: there is no dock on the other end.
  if (artifactAuthoringEnabled) {
    try {
      const { buildArtifactManifestEntries, buildCanvasManifestEntries } =
        await import("@/lib/claude/artifact-builtin-tools")
      const { isNativeMobile } = await import("@/lib/platform/detect")
      const entries = [...buildArtifactManifestEntries()]
      // Canvas is a desktop/web surface: the mobile shell has no editor guild
      // to open a document in, so offering `canvas_open` there would advertise a
      // destination that does not exist.
      if (!isNativeMobile()) entries.push(...buildCanvasManifestEntries())
      const existing = new Set((opts.pluginTools ?? []).map((entry) => entry.name))
      opts.pluginTools = [
        ...(opts.pluginTools ?? []),
        ...entries.filter((entry) => !existing.has(entry.name)),
      ]
    } catch (err) {
      loggers.app.warn("failed to append artifact built-in tools", { error: String(err) })
    }
  }
  if (appSettings?.selfInvokeTools?.slashCommand === true) {
    try {
      const { buildSlashCommandManifestEntries } = await import("@/lib/claude/slash-builtin-tools")
      const { listSlashCommands } = await import("@/lib/slash-commands/registry")
      const summaries = listSlashCommands().map((c) => ({
        name: c.name,
        description: c.description,
      }))
      opts.pluginTools = [
        ...(opts.pluginTools ?? []),
        ...buildSlashCommandManifestEntries(summaries),
      ]
    } catch (err) {
      loggers.app.warn("failed to append SlashCommand built-in tool", { error: String(err) })
    }
  }
  // User-started sidechat handoff. Native mobile has no sidechat host, so do
  // not advertise a tool that could only create an unreachable embedded row.
  if (appSettings?.selfInvokeTools?.spawnTask === true) {
    try {
      const { isNativeMobile } = await import("@/lib/platform/detect")
      if (!isNativeMobile()) {
        const { buildSpawnTaskManifestEntries } =
          await import("@/lib/claude/spawn-task-builtin-tools")
        opts.pluginTools = [...(opts.pluginTools ?? []), ...buildSpawnTaskManifestEntries()]
      }
    } catch (err) {
      loggers.app.warn("failed to append spawn_task built-in tool", { error: String(err) })
    }
  }
  if (appSettings?.selfInvokeTools?.sessionMessaging === true) {
    try {
      const { buildSessionPeerManifestEntries } =
        await import("@/lib/claude/session-peer-builtin-tools")
      opts.pluginTools = [...(opts.pluginTools ?? []), ...buildSessionPeerManifestEntries()]
    } catch (err) {
      loggers.app.warn("failed to append session messaging built-in tools", {
        error: String(err),
      })
    }
  }
  // Project-scoped vector memory (vector_search / vector_add_document /
  // vector_delete_document). Opt-in, and only manifested when the tools can
  // actually run: they need the native sqlite-vec store (desktop) AND a linked
  // project to scope collections to. Advertising them without both would hand
  // the model three tools that can only ever return an error.
  if (appSettings?.selfInvokeTools?.vector === true) {
    try {
      const vectorProjectId = session?.projectId ?? ctx.activeProject?.id
      const { isTauri } = await import("@/lib/tauri")
      if (vectorProjectId && isTauri()) {
        const { buildVectorManifestEntries } = await import("@/lib/claude/vector-builtin-tools")
        opts.pluginTools = [...(opts.pluginTools ?? []), ...buildVectorManifestEntries()]
      }
    } catch (err) {
      loggers.app.warn("failed to append vector built-in tools", { error: String(err) })
    }
  }
  // Team-collaboration tools — only on a team dispatch session, opt-in. Lets a
  // teammate message peers / publish-read the blackboard / open-vote consensus /
  // delegate during its turn (the cognia analogue of Claude Code SendMessage).
  if (session?.kind === "team" && appSettings?.selfInvokeTools?.teamCollaboration === true) {
    try {
      const { buildTeamCollabManifestEntries, TEAM_MESSAGING_PROTOCOL } =
        await import("@/lib/claude/team-builtin-tools")
      // Only offer `twin_knowledge_search` when the team actually has a knowledge
      // source (a member's bound twin, or a team-level knowledgeTwinId) — never a
      // dead capability. Resolved from the per-session team-dispatch context.
      const includeTwinKnowledgeSearch = await teamHasKnowledgeTwins(session.id, character?.twinId)
      opts.pluginTools = [
        ...(opts.pluginTools ?? []),
        ...buildTeamCollabManifestEntries({ includeTwinKnowledgeSearch }),
      ]
      const existingTeamPrompt = opts.appendSystemPrompt?.trim() ?? ""
      opts.appendSystemPrompt = existingTeamPrompt
        ? `${existingTeamPrompt}\n\n${TEAM_MESSAGING_PROTOCOL}`
        : TEAM_MESSAGING_PROTOCOL
    } catch (err) {
      loggers.app.warn("failed to append team-collaboration built-in tools", {
        error: String(err),
      })
    }
  }

  // Bounded session working state is a core chat capability, not a third-party
  // plugin. Surface it for every persisted session through the existing
  // plugin-tool relay even when optional plugin tools are disabled.
  if (session?.id) {
    try {
      const { buildWorkingSetManifestEntries, WORKING_SET_TOOL_NAME } =
        await import("@/lib/claude/working-set-tool")
      if (!(opts.pluginTools ?? []).some((entry) => entry.name === WORKING_SET_TOOL_NAME)) {
        opts.pluginTools = [...(opts.pluginTools ?? []), ...buildWorkingSetManifestEntries()]
      }
      const guidance =
        "Use working_set to keep bounded facts, decisions, open questions, resource references, and subtask handles durable and user-visible; never store reasoning or secrets."
      const existing = opts.appendSystemPrompt?.trim() ?? ""
      opts.appendSystemPrompt = existing ? `${existing}\n\n${guidance}` : guidance
    } catch (err) {
      loggers.app.warn("failed to append working_set core tool", { error: String(err) })
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
  const sandboxEnabled = resolveSandboxEnabled({
    session: { sandboxEnabled: session?.sandboxEnabled },
    character: { sandboxEnabled: character?.sandboxEnabled },
    appSettings: { sandboxDefaultEnabled: appSettings?.sandboxDefaultEnabled },
  })
  const sandboxBinding = resolveSandboxSessionBinding({
    session: {
      sandboxTier: session?.sandboxTier,
      computerUseTarget: session?.computerUseTarget,
    },
    character: {
      sandboxTier: character?.sandboxTier,
      computerUseTarget: character?.computerUseTarget,
    },
    appSettings: { sandboxTier: appSettings?.sandboxTier },
  })
  const resolvedSandboxPolicy = character?.sandboxPolicy ?? appSettings?.sandboxPolicy ?? null
  const computerUseNeedsConfine =
    computerUseAllowedForChat && sandboxBinding.computerTarget === "bound"
  if (session?.id && (sandboxEnabled || computerUseAllowedForChat)) {
    const bindInput = {
      sessionId: session.id,
      binding: sandboxBinding,
      policy: sandboxEnabled ? resolvedSandboxPolicy : null,
      confine:
        sandboxEnabled || computerUseNeedsConfine
          ? {
              writable: resolvedSandboxPolicy?.writableRoots ?? [],
              readable: resolvedSandboxPolicy?.readableRoots ?? [],
              network: resolvedSandboxPolicy?.network ?? "off",
              networkHosts: resolvedSandboxPolicy?.networkAllowlist ?? [],
            }
          : null,
      sandboxEnabled,
      computerUseEnabled: computerUseAllowedForChat,
      // The microVM tier claims an EXISTING remote workspace by its handle
      // path, so this only binds when `cwd` IS such a handle — an Agent Team
      // teammate cloned into E2B. For an ordinary chat `cwd` (a local
      // directory) the claim misses and the bind refuses, which is correct:
      // there is nothing to isolate into. The refusal names the requirement
      // (see `buildMicrovmExec.preflight`) and, per the catch below, the shell
      // tier then declines rather than running here.
      workspaceRoot: opts.cwd,
    }
    try {
      opts.sandboxRuntimeRef = await sandboxSessionRuntime.bindSession(bindInput)
    } catch (err) {
      // An unusable placement must not take the whole send down with it. The
      // binding can be refused by state the user changed elsewhere — a deleted
      // sandbox connection, a character still pinned to the withdrawn
      // `cua-desktop` tier, a microVM preflight that cannot claim a workspace
      // — and none of those should leave the session unable to send anything
      // at all with no UI affordance to recover.
      //
      // What it must NOT do is answer "I could not isolate this" with "then run
      // it here, unrestricted". `bindUnplacedSession` records the placement the
      // session asked for: the resolved ceiling still clamps every surface that
      // legitimately runs on this host, and the surfaces that were supposed to
      // leave it (a non-`os` shell tier, a bound GUI target) refuse at call
      // time instead of silently landing on the user's own machine.
      loggers.app.warn("unusable sandbox binding", {
        sessionId: session.id,
        shellTier: sandboxBinding.shellTier,
        computerTarget: sandboxBinding.computerTarget,
        error: String(err),
      })
      opts.sandboxRuntimeRef = sandboxSessionRuntime.bindUnplacedSession(bindInput, err)
    }
  } else if (session?.id) {
    // Same invariant as the catch above, for the same reason: `releaseSession`
    // rethrows a provider that refused to close, and a send must not be
    // impossible because an E2B teardown is timing out. The runtime keeps the
    // records it could not release and retries them on the next bind.
    try {
      await sandboxSessionRuntime.releaseSession(session.id)
    } catch (err) {
      loggers.app.warn("sandbox runtime release failed", {
        sessionId: session.id,
        error: String(err),
      })
    }
    delete opts.sandboxRuntimeRef
  }
  if (sandboxEnabled) {
    const disallowed = new Set(opts.disallowedTools ?? [])
    // SDK builtins AND the sidecar coreFiles mutators — either would bypass
    // the sandbox (bare names = ai-sdk path, namespaced = Anthropic hatch).
    // `start_process` / `shell_execute_advanced` are the process-execution
    // escape hatches (ADR-0028 Phase 4): they spawn real host processes
    // unconfined, so they are disallowed too — the model uses `sandbox_bash`
    // for shell work in a sandboxed session.
    for (const t of [
      "Bash",
      "Edit",
      "Write",
      "bash",
      "edit",
      "write",
      "multi_edit",
      "start_process",
      "shell_execute_advanced",
      "mcp__cognia-tools__bash",
      "mcp__cognia-tools__edit",
      "mcp__cognia-tools__write",
      "mcp__cognia-tools__multi_edit",
      "mcp__cognia-tools__start_process",
      "mcp__cognia-tools__shell_execute_advanced",
    ]) {
      disallowed.add(t)
    }
    opts.disallowedTools = [...disallowed]
    if (Array.isArray(opts.anthropicTools)) {
      opts.anthropicTools = opts.anthropicTools.filter(
        (t) => t.name !== "text_editor" && t.name !== "str_replace_based_edit_tool"
      )
    }
    const sandboxHint =
      "Filesystem-mutating and shell tools are sandboxed in this session. Use " +
      "`sandbox_bash` / `sandbox_edit` / `sandbox_write` / `sandbox_text_editor` " +
      "(from cognia-sandboxed-tools) instead of the SDK builtins; they accept the " +
      "same shape plus an explicit writable/readable scope. The unsandboxed Bash / " +
      "Edit / Write are not available in this session."
    const existing = opts.appendSystemPrompt?.trim() ?? ""
    opts.appendSystemPrompt = existing ? `${existing}\n\n${sandboxHint}` : sandboxHint
  }

  // --- Workspace confinement (ADR-0028 "lite") ------------------------------
  // The always-on, cross-platform middle layer: when the heavy OS sandbox is
  // NOT active, confine the sidecar built-in file/bash tools to the active
  // workspace roots. Out-of-root mutator calls escalate to approval; credential
  // paths hard-deny (enforced in the sidecar canUseTool gates via
  // `sendOptions.confinement`). Mutually exclusive with `sandboxEnabled` — that
  // path already swaps in the `sandbox_*` tools and enforces at the OS level, so
  // stacking both would double-confine. Rootless sessions (no active project)
  // carry no policy and behave exactly as before.
  const confinementEnabled =
    !sandboxEnabled &&
    Boolean(ctx.activeProject) &&
    (session?.workspaceConfinementEnabled ??
      character?.workspaceConfinementEnabled ??
      appSettings?.workspaceConfinementEnabled ??
      true)
  if (confinementEnabled) {
    const roots = new Set<string>()
    if (opts.cwd) roots.add(opts.cwd)
    for (const dir of opts.additionalDirectories ?? []) {
      if (dir) roots.add(dir)
    }
    if (roots.size > 0) {
      opts.confinement = { enabled: true, roots: [...roots] }
    }
  }

  // --- IM-session core-tool safeguard ---------------------------------------
  // G6 parity for the coreFiles suite: an inbound Telegram/Slack/Discord/Lark
  // message must not mutate the host filesystem or run shell commands. The
  // per-conversation `allowComputerUse` opt-in (the existing "this chat may
  // drive my machine" switch) lifts the deny. Read-only core tools stay
  // available so IM agents can still inspect the workspace.
  if (imSession && !allowImComputerUse) {
    const denied = new Set(opts.disallowedTools ?? [])
    // Same derived set as Restricted Mode. Previously this was a hand-written
    // 8-entry literal covering 4 logical tools, which left `directory_delete`,
    // `shell_execute_advanced`, `terminal_repl_spawn`, `apply_patch` and every
    // other approval-gated mutator reachable from an inbound IM message.
    for (const t of RESTRICTED_MODE_DENIED_TOOLS) denied.add(t)
    opts.disallowedTools = [...denied]
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
  if (!supportAgent && agentExecutionPolicy.envBindings?.length) {
    const agentEnv = await resolveAgentEnvironment(
      agentExecutionPolicy.envBindings,
      loadAgentEnvSecret
    )
    opts.env = { ...(opts.env ?? {}), ...agentEnv }
  }

  // Standalone callers use their preloaded env; desktop callers resolved and
  // validated account/proxy env before provider bridge credentials above.
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

  // Plan mode: reinforce "ask questions as plain text, submit the final plan
  // via the exit-plan tool" so the approval flow keys off the structured tool
  // signal — not a misclassified clarifying question.
  if (opts.permissionMode === "plan") {
    const existing = opts.appendSystemPrompt?.trim() ?? ""
    // Enhanced plan mode: the submitted plan is reviewed in the interactive
    // step editor, so ask for a machine-parsable `## Steps` list too.
    const planSnippet =
      appSettings?.planSettings?.interactiveHtmlView === true
        ? `${PLAN_MODE_SNIPPET}\n\n${PLAN_MODE_STRUCTURED_STEPS_SNIPPET}`
        : PLAN_MODE_SNIPPET
    opts.appendSystemPrompt = existing ? `${existing}\n\n${planSnippet}` : planSnippet
  }

  // ADR-0045 §3.2 — plan authoring tools (`create_plan` / `update_plan`).
  // Carried as an explicit opt-OUT only: the sidecar defaults them on, so the
  // send spec stays quiet unless the user disabled the feature.
  if (appSettings?.planSettings?.agentAuthoring === false) {
    opts.planTools = false
  }

  // Output style — Claude Code parity. Composes with brief mode (both append).
  const outputStyle = session?.outputStyle ?? character?.outputStyle ?? appSettings?.outputStyle
  const customOutputStyle =
    session?.customOutputStyle ?? character?.customOutputStyle ?? appSettings?.customOutputStyle
  const outputStyleSnippet = resolveOutputStyleSnippet(outputStyle, customOutputStyle)
  if (outputStyleSnippet) {
    const existing = opts.appendSystemPrompt?.trim() ?? ""
    opts.appendSystemPrompt = existing ? `${existing}\n\n${outputStyleSnippet}` : outputStyleSnippet
  }

  // --- Conversation compaction (context-compression maturation) ------------
  // Resolve compaction config session ← character ← appSettings and serialise
  // it onto `opts.compaction` for the sidecar (absent ≡ sidecar defaults). The
  // active strategy (built-in default, or a plugin-contributed
  // `compaction-strategy` looked up in the overlay registry) supplies the
  // summary prompt + optional threshold overrides; the user `focus` (compact
  // instructions) layers on top. When compaction is enabled, also append the
  // built-in compaction/memory instruction fragment so the live agent keeps
  // durable notes ahead of a compaction boundary. The generic (AI-SDK) path
  // honours every field; the Anthropic path only reads `focus`.
  {
    opts.compactionCheckpointContext = {
      selectedSkills: skills.map((skill) => ({
        id: skill.id,
        version: skill.version ?? skill.syncFingerprint ?? skill.marketplaceHash ?? "unknown",
      })),
      policyVersions: [
        {
          id: "workspace-trust",
          version: ctx.workspaceRestricted ? "restricted-v1" : "trusted-v1",
        },
      ],
    }
    const appComp = appSettings?.compaction
    const strategy = appComp?.strategyId ? getCompactionStrategy(appComp.strategyId) : undefined
    const draft = resolveCompaction({
      appComp,
      charOv: character?.compactionOverride,
      sessOv: session?.compactionOverride,
      strategy,
    })
    // `summaryProvider`/`summaryModel` are draft-only — strip them before the
    // wire type and resolve the cheap-model credentials here (async/registry).
    const { summaryProvider, summaryModel, ...resolved } = draft

    // Cheap-model summary (generic path): when a distinct, configured provider is
    // requested, resolve its credentials with the same machinery as the main
    // turn; when only a model is requested, reuse the turn's provider with the
    // model overridden. Never fail the turn — on any miss, omit `summary` and the
    // sidecar reuses the main model.
    if (resolved.enabled && appSettings) {
      try {
        if (summaryProvider && summaryProvider !== providerId) {
          const summary = await resolveSummaryProviderForCompaction({
            providerId: summaryProvider,
            summaryModel,
            appSettings,
          })
          if (summary) {
            resolved.summary = {
              model: summary.model,
              protocol: summary.protocol,
              // Travels WITH `credentials`: the sidecar keys the OpenAI endpoint
              // family off the id, which a relay preset's host can't reveal.
              providerId: summary.providerId,
              credentials: summary.credentials,
              ...(summary.protocolAdapterSpec
                ? { protocolAdapterSpec: summary.protocolAdapterSpec }
                : {}),
            }
          }
        } else if (summaryModel) {
          resolved.summary = { model: summaryModel }
        }
      } catch (err) {
        console.warn("compaction summary provider resolution failed:", err)
      }
    }

    // Pin the AUTHORITATIVE window so the sidecar's generic compaction trigger
    // stops re-deriving it from its conservative regex table (which floors every
    // `deepseek*` id at 128k — auto-compacting a real 1M deepseek-v4 at ~107k).
    // Catalog `contextLength` first (covers deepseek-v4 = 1M), regex table as the
    // floor for ids the catalog doesn't carry.
    if (resolved.enabled && opts.model) {
      const catalogWindow = getModelConfig(providerId, opts.model)?.contextLength
      const window =
        typeof catalogWindow === "number" && catalogWindow > 0
          ? catalogWindow
          : getModelContextWindow(opts.model)
      if (window > 0) resolved.contextWindow = window
    }

    opts.compaction = resolved

    if (resolved.enabled) {
      const snippet = resolveCompactInstructions(resolved.focus)
      const existing = opts.appendSystemPrompt?.trim() ?? ""
      opts.appendSystemPrompt = existing ? `${existing}\n\n${snippet}` : snippet

      // One-shot post-compaction recovery: re-inject durable instructions on the
      // FIRST turn after a boundary so the model treats the new summary as
      // authoritative and keeps operational directives in force.
      if (ctx.postCompaction) {
        const recovery = buildPostCompactionRecovery({
          durableInstructions: ctx.postCompaction.durableInstructions,
        })
        const base = opts.appendSystemPrompt?.trim() ?? ""
        opts.appendSystemPrompt = base ? `${base}\n\n${recovery}` : recovery
      }
    }
  }

  // --- Surface-aware built-in skills ---------------------------------------
  // Auto-inject the function-guidance skill for whichever agent surface this
  // turn is running on (IM auto-reply, computer-use, agent-team, digital-twin,
  // goal/loop). The signals are facts already computed above; the catalog +
  // selection live in lib/skills/. Workflow-editor is handled in its own prompt
  // block below (that path clears appendSystemPrompt), so it's excluded here.
  // Gated by `surfaceSkillsEnabled` (default on). Skills the user already
  // enabled (present in `skills`) are skipped to avoid a duplicate section.
  if ((appSettings?.surfaceSkillsEnabled ?? true) && session?.kind !== "workflow-editor") {
    const picked = selectSurfaceSkills({
      imBound: imSession,
      computerUse: computerUseAllowedForChat,
      agentTeam: session?.kind === "team",
      digitalTwin: twinReplacedBase,
      goalLoop: ctx.activeGoal?.status === "active" || ctx.activeLoop === true,
    })
    const alreadyEnabled = new Set(skills.map((s) => s.id))
    const fresh = picked.filter((e) => !alreadyEnabled.has(builtinSkillId(e)))
    const section = renderSurfaceSkillsSection(fresh)
    if (section) {
      const existing = opts.appendSystemPrompt?.trim() ?? ""
      opts.appendSystemPrompt = existing ? `${existing}\n\n${section}` : section
      // Union any tools the activated surface skills declare into the
      // allowlist (already finalized above) — mirrors how chat & plugin
      // skills widen it. Skills can only widen, never narrow.
      const surfaceTools = fresh.flatMap((e) => e.allowedTools ?? [])
      if (surfaceTools.length > 0) {
        opts.allowedTools = [...new Set([...(opts.allowedTools ?? []), ...surfaceTools])]
      }
      void recordSkillUsage(fresh.map((e) => builtinSkillId(e))).catch(() => undefined)
    }
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
    // Forward the goal's per-turn USD ceiling as the SDK's hard budget cap so a
    // runaway turn halts (subtype `error_max_budget_usd`) instead of burning
    // cost until the renderer-side turn/token budget catches it post-turn.
    const goalBudget = ctx.activeGoal.config?.maxBudgetUsd
    if (typeof goalBudget === "number" && goalBudget > 0) {
      opts.maxBudgetUsd = goalBudget
    }
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

  // --- Reasoning effort ("thinking level") ---------------------------------
  // Precedence: IM `/reasoning` override > session > app default. The IM
  // override sits at the top (same placement as `imModelOverride` over the
  // model chain) so a `/reasoning high` on a Telegram channel beats the
  // session/app default. Forwarded to the SDK as `output_config.effort`
  // (modern thinking-depth control on Opus 4.5+, Sonnet 4.6, Fable 5). Only set
  // when present AND the resolved model actually honours effort — Haiku / old
  // Sonnet (and non-reasoning models on the ai-sdk path) reject it with a 400.
  // This is the same `modelSupportsEffort` gate the CLI applies; the
  // desktop/web path previously forwarded it unconditionally, so a thinking
  // level chosen on a capable model then carried onto Haiku broke the next
  // turn. When no model is resolved here the sidecar picks its own
  // (effort-capable) default, so we can't judge capability and forward as
  // before. When a model IS resolved, gate on it.
  // Bot-instance default effort slots below the per-session choice and above
  // the app default (same W1 layering as model/provider); the
  // `modelSupportsEffort` gate below covers a bot default set on a
  // non-reasoning model.
  const effort = requestedEffort
  // Carried ungated for the external-agent rail, which never runs `opts.model`
  // and folds effort onto its own agent's ladder (see `SendOptions.requestedEffort`).
  if (effort) opts.requestedEffort = effort
  if (effort && (!opts.model || modelSupportsEffort(opts.provider, opts.model))) {
    opts.effort = effort
  } else if (effort && opts.model) {
    // User asked for a reasoning level the resolved model can't honour, so it
    // was dropped above (a capable→Haiku model switch is the common cause).
    // Flag it so the chat hook can surface a once-per-model advisory toast —
    // otherwise the setting vanishes with zero feedback.
    opts.droppedCapabilityWarning = {
      capability: "effort",
      model: opts.model,
      provider: opts.provider,
    }
  }

  // --- Token-level streaming (includePartialMessages) ----------------------
  // Request the SDK's partial-message stream so the renderer can paint
  // assistant text token-by-token. Only on INTERACTIVE sends: connector
  // (`conversationKey`), nested-dispatch (`dispatchContext`), and headless /
  // request-response (`preloadedEnv` / `preloadedMcpServers` provided) paths
  // consume only the final result, so partial events there are wasted IPC
  // volume. Gated by `AppSettings.streamPartialMessages` (default on). The SDK
  // simply omits partials when a thinking budget is active, so this is a no-op
  // (graceful whole-message fallback) in that case rather than a conflict.
  //
  // EXCEPTION: the standalone agent CLI's interactive TUI sets `ctx.interactive`
  // — it injects `preloadedEnv`/`preloadedMcpServers` (it can't reach Dexie /
  // Tauri) but IS a live turn. It must get partials so the deltas keep feeding
  // the idle watchdog; otherwise a long single generation (large file write)
  // streams nothing for >60s and trips the spurious "stream idle" interrupt.
  const isInteractiveSend =
    !ctx.conversationKey &&
    !ctx.dispatchContext &&
    (ctx.interactive === true ||
      (ctx.preloadedEnv === undefined && ctx.preloadedMcpServers === undefined))
  if (isInteractiveSend && (appSettings?.streamPartialMessages ?? true)) {
    opts.includePartialMessages = true
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
    // Forward subagent text/thinking so the SDK-subagent bridge can render rich
    // nested logs in the chat tree (default off in the SDK).
    opts.forwardSubagentText = true
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
      // Surface-aware skill for this surface: the generic append path above is
      // skipped for workflow-editor sessions (and cleared here), so inject the
      // `workflow-authoring` guidance alongside the per-turn snapshot. Gated by
      // the same `surfaceSkillsEnabled` toggle.
      const workflowSkill =
        (appSettings?.surfaceSkillsEnabled ?? true)
          ? getCatalogSkill("workflow-authoring")
          : undefined
      const workflowSkillSection = workflowSkill
        ? `## ${workflowSkill.name}\n\n${workflowSkill.content.trim()}`
        : ""
      opts.appendSystemPrompt =
        [workflowSkillSection, snapshot ?? ""].filter(Boolean).join("\n\n") || undefined
      if (workflowSkill) {
        void recordSkillUsage([builtinSkillId(workflowSkill)]).catch(() => undefined)
      }
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
    // Forward subagent text/thinking so the SDK-subagent bridge renders rich logs.
    opts.forwardSubagentText = true
    try {
      const { resolveAllSubagents } = await import("@/lib/claude/agents/subagents")
      opts.agents = {
        ...(opts.agents ?? {}),
        ...resolveAllSubagents({ context: "team" }),
      }
    } catch (err) {
      console.warn("team session subagent registration failed:", err)
    }
  } else if (ctx.dispatchContext) {
    // Nested subagent run — deliberately DO NOT inject SDK-native agents. The
    // child gets the controlled `dispatch_agent` host tool instead (gated by
    // depth in the plugin-tools manifest), so it never holds BOTH the
    // uncontrolled SDK Task tool and our depth-tracked path at once.
  } else {
    // Direct chat: expose the user's OWN subagents (plugin-registered +
    // imported/authored templates) so the model can delegate to them via the
    // Task tool — previously subagents were dormant outside workflow-editor /
    // team sessions. Empty-guarded: an empty map would otherwise advertise a
    // no-op agent surface on every turn.
    //
    // gap8: forward subagent text/thinking frames so the inline card can show
    // the child's narrated reasoning stream. The renderer only surfaces it in
    // `detailed` display mode, so simplified/standard stay uncluttered. NOT set
    // on the `dispatchContext` branch above — nested children run via the host
    // `dispatch_agent` tool, not SDK-native Task, so no such frames fire there.
    opts.forwardSubagentText = true
    try {
      const { resolveAllSubagents, workflowEditorSubagents } =
        await import("@/lib/claude/agents/subagents")
      // Include the 4 host built-ins so they are `@`-mentionable in general
      // chat (they back the picker via `resolveDispatchableSubagents`); union
      // with the user's own plugin + template subagents. Keys align across the
      // picker, the send-time resolver, and this map, so a picked `@handle`
      // routes to a registered agent.
      //
      // NOTE: this re-walks the same registry + template sources the
      // `dispatch_agent` gate already walked (`resolveDispatchableSubagents`,
      // ~750 lines up). The two produce DIFFERENT shapes (SDK `AgentDefinition`
      // map here vs dispatchable `PluginSubagentDef[]` there), and both sources
      // are small in-memory collections, so the duplicate walk is negligible and
      // deliberately not deduped — threading a shared snapshot across the gate↔
      // branch distance in this function would cost more in fragility than it saves.
      const direct = { ...workflowEditorSubagents(), ...resolveAllSubagents({ context: "direct" }) }
      if (Object.keys(direct).length > 0) {
        opts.agents = { ...(opts.agents ?? {}), ...direct }
      }
    } catch (err) {
      console.warn("direct-chat subagent registration failed:", err)
    }
  }

  // --- Project markdown subagents (.cognia/agents/*.md) --------------------
  // Merge the project-discovered markdown agents AFTER the registry/template
  // subagents so a project's `.cognia/agents/foo.md` wins on id collision. The
  // list is empty for workflow-editor sessions (discovery is skipped above), so
  // this branch is a no-op there.
  if (projectMarkdownAgentFiles.length > 0 && !ctx.dispatchContext) {
    try {
      const { buildMarkdownAgents, markdownAgentsToSdkMap } =
        await import("@/lib/claude/agents/markdown-agents")
      const { agents } = buildMarkdownAgents(projectMarkdownAgentFiles)
      const sdkMap = markdownAgentsToSdkMap(agents)
      if (Object.keys(sdkMap).length > 0) {
        opts.agents = { ...(opts.agents ?? {}), ...sdkMap }
      }
    } catch (err) {
      console.warn("project markdown subagent registration failed:", err)
    }
  }

  // --- @agent single-turn routing ------------------------------------------
  // The user `@`-mentioned a subagent for this turn. Run the turn AS that agent
  // (SDK-native `agent` field; ai-sdk applies a synthetic overlay) — but ONLY
  // when the id is actually registered in `opts.agents` above. An unknown /
  // stale id is silently dropped (the SDK errors on an undefined agent). This is
  // the single membership gate that keeps the picked handle, the parsed id, and
  // the registered agent map in agreement.
  if (ctx.targetAgentId && opts.agents?.[ctx.targetAgentId]) {
    opts.agent = ctx.targetAgentId
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
    // Surface the tail separately so the ai-sdk dispatcher can split the
    // stable/dynamic boundary for its cacheControl breakpoint. `appendSystemPrompt`
    // still carries the full text, so the native Anthropic path is unaffected.
    opts.dynamicSystemPrompt = tail
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

  // --- Conversation-branching seed -----------------------------------------
  // A freshly-branched session (see `lib/chat/branch-session.ts`) carries a
  // one-shot `branchSeed`: the pre-branch transcript (mid-conversation direct
  // branch) or an LLM summary (summary branch). Injected as `appendSystemPrompt`
  // so the new SDK conversation starts with the truncated context — the model
  // only sees content up to the branch point. The hook clears the seed right
  // after the first send (`clearBranchSeed`) so later turns don't re-inject it.
  // Tail direct branches use SDK fork instead and never set a seed.
  //
  // The seed and an SDK fork are two ways of re-establishing the SAME
  // pre-branch context, and `buildChildRow` sets exactly one. Applying both
  // would send it twice — once as a system prompt and once as the forked
  // conversation — inflating every first turn and letting the model see the
  // branch point described two different ways. Unreachable today, but the two
  // fields are set in one function and read in two places, so pin the
  // invariant here rather than rediscovering it from a token bill.
  if (session?.branchSeed?.content && session.forkedFromSdkSessionId) {
    loggers.chat.warn("branch-seed-and-fork-both-set", {
      sessionId: session.id,
      branchKind: session.branchSeed.kind,
    })
  }
  if (session?.branchSeed?.content && !session.sdkSessionId && !session.forkedFromSdkSessionId) {
    const label =
      session.branchSeed.kind === "summary"
        ? "Summary of the conversation this thread was branched from:"
        : "Context from the conversation this thread was branched from:"
    const seedBlock = `${label}\n\n${session.branchSeed.content}`
    const existing = opts.appendSystemPrompt?.trim() ?? ""
    opts.appendSystemPrompt = existing ? `${existing}\n\n${seedBlock}` : seedBlock
  }

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

  // Plugin `onBuildOptions` transform pipeline (ADR-0026 §4 §B), the final,
  // lowest-precedence option tweak. The dispatcher shallow-merges each enabled
  // plugin's returned partial in priority order; when no plugin registers the
  // hook it returns the input unchanged. Dormant until now — the merge logic
  // existed in `PluginEventHooks.dispatchBuildOptions` but nothing invoked it.
  if (session?.id) {
    const patched = await getPluginEventHooks().dispatchBuildOptions({
      sessionId: session.id,
      model: opts.model ?? "",
      systemPrompt: opts.systemPrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      allowedTools: opts.allowedTools,
    })
    if (patched.model) opts.model = patched.model
    if (patched.systemPrompt !== undefined) opts.systemPrompt = patched.systemPrompt
    if (patched.appendSystemPrompt !== undefined)
      opts.appendSystemPrompt = patched.appendSystemPrompt
    if (patched.allowedTools !== undefined) opts.allowedTools = patched.allowedTools
  }

  // --- Parent permission ceiling (fail-closed, FINAL clamp) ----------------
  // When this build is for a dispatched child, clamp the resolved tool surface
  // against the parent's ceiling: allow-lists intersect, deny-lists union,
  // permission mode clamps down. Runs AFTER the plugin `onBuildOptions` hook so
  // a plugin (or any earlier layer) can never re-open a tool the parent forbade.
  // `deriveExternalSessionPermission` semantics: a parent with no allow-list
  // imposes no ceiling; a child that declares no allow-list under a restricted
  // parent inherits the parent's whitelist (cannot widen to "all").
  if (ctx.permissionCeiling) {
    const child: ExternalSessionPermissionSpec = {
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
      // `auto` is a Claude-Agent-SDK-only mode (model-classifier approval); the
      // external/ACP permission cascade (`AcpPermissionMode`) has no equivalent,
      // so it never enters the ceiling spec. The other five modes map 1:1.
      ...(opts.permissionMode && opts.permissionMode !== "auto"
        ? { permissionMode: opts.permissionMode }
        : {}),
    }
    const merged = deriveExternalSessionPermission(ctx.permissionCeiling, child)
    if (merged.allowedTools) opts.allowedTools = [...merged.allowedTools].sort()
    else delete opts.allowedTools
    if (merged.disallowedTools) opts.disallowedTools = [...merged.disallowedTools].sort()
    else delete opts.disallowedTools
    // Every `AcpPermissionMode` (incl. `dontAsk`) is a valid SendOptions mode:
    // the AI-SDK gate enforces dontAsk (deny-without-prompt) and the Anthropic
    // SDK enforces it natively, so a dontAsk parent ceiling must clamp the
    // child's mode like any other.
    if (merged.permissionMode) {
      opts.permissionMode = merged.permissionMode
    }
  }

  // Deposit the ceiling this session ACTUALLY resolved to (post-clamp), keyed by
  // session id, so a subagent it dispatches inherits the true ceiling and the
  // cascade stays monotonic across nesting depth.
  if (session?.id) {
    recordResolvedPermissionCeiling(session.id, {
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
      // See note above: `auto` has no external/ACP equivalent.
      ...(opts.permissionMode && opts.permissionMode !== "auto"
        ? { permissionMode: opts.permissionMode }
        : {}),
    })
  }

  // --- Agent-trace root span (telemetry correlation) ------------------------
  // Mint the turn's ROOT span as the FINAL step so the whole turn (provider
  // call + tool + sub-agent spans) hangs off one traceId. Opt-in via
  // `emitTrace` because the CALLER owns `endSpan` — see the field doc.
  // `SendOptions.{traceId,spanId}` ARE the on-the-wire TraceContext that
  // downstream child spans read (never the tab-global `logContext`). A caller
  // that already stamped a trace, or supplies `parentTrace`, is respected. A
  // suppressed turn (quiet hours / muted / manual mode) never calls the model,
  // so it gets no span — the caller short-circuits before any `endSpan`.
  if (ctx.emitTrace && !opts.traceId && !opts.suppressedReason) {
    if (ctx.parentTrace) {
      opts.traceId = ctx.parentTrace.traceId
      opts.spanId = ctx.parentTrace.rootSpanId
      opts.traceparent = toTraceparent(ctx.parentTrace)
    } else {
      const promptPreview = ctx.routingContextHint?.promptText
      const { ctx: traceCtx } = startRootTrace({
        operationName: "invoke_agent",
        // The root is the agent invocation, not the LLM call, but it should
        // still name the provider that actually served the turn — reporting
        // every root as "anthropic" mis-attributed provider rollups built from
        // root spans. `metadata.providerId` keeps the raw id.
        providerName: providerNameFromId(providerId),
        sessionId: session?.id ?? "",
        surface: ctx.traceSurface ?? "chat",
        requestModel: opts.model,
        agentId: character?.id,
        inputPreview: promptPreview || undefined,
        metadata: {
          providerId,
          ...(ctx.conversationKey ? { conversationKey: ctx.conversationKey } : {}),
        },
      })
      opts.traceId = traceCtx.traceId
      opts.spanId = traceCtx.rootSpanId
      opts.traceparent = toTraceparent(traceCtx)
    }
  }

  // ADR-0090: stamp the frozen execution spec onto the outgoing SendOptions.
  // `execution` is the secret-free wire shape the sidecar's dispatch routes on
  // (runtime adapter instead of the provider-id branch); the legacy
  // `provider`/proxy fields stay untouched so an older sidecar still routes. A
  // stamping failure must not break the send — dispatch falls back to the
  // provider branch and counts it as `legacy_dispatch` telemetry.
  //
  // Whether a `gateway` route is actually reachable is still a flag decision:
  // `gatewayAgentRouteTickets` is what makes `resolveAgentExecutionSpec` return
  // `gatewayEligible` at all, and it is the flag the Settings → Gateway → Route
  // tickets switch writes. Stamping unconditionally is what lets that switch
  // mean something on a default install.
  try {
    const { getAgentExecutionFlags } = await import("@/lib/ai/agent/execution/feature-flags")
    const { resolveAgentExecutionSpec, sendSpecFromResolved } =
      await import("@/lib/ai/agent/execution/resolve-agent-execution-spec")
    const { isTauri } = await import("@/lib/tauri")
    const { spec } = resolveAgentExecutionSpec({
      surface: "chat",
      environment: { isTauri: isTauri(), isHeadlessHost: false },
      flags: getAgentExecutionFlags(),
      // Chat sessions are agent sessions by definition; the legacy
      // provider id still drives the runtime mapping.
      policy: { executionKind: "agent" },
      legacy: { providerId: opts.provider, modelId: opts.model },
      identity:
        session?.id || ctx.executionIdentity
          ? { ...(session?.id ? { sessionId: session.id } : {}), ...ctx.executionIdentity }
          : undefined,
    })
    // A gateway route is only real once a ticket exists: without one
    // `sendSpecFromResolved` degrades to `direct`, which is why the route
    // ticket panel could never list anything. Minting is best-effort — a
    // refusal falls back to the direct shape rather than failing the send.
    const minted =
      spec.route.kind === "gateway" && session?.id
        ? await (
            await import("@/lib/gateway/mint-session-ticket")
          ).mintSessionRouteTicket({
            sessionId: session.id,
            executionFingerprint: spec.executionFingerprint,
            model: opts.model ?? spec.modelBindings.primary,
            routePolicy: spec.route.routePolicy,
          })
        : undefined
    // ADR-0117: resolve the turn's composition and ride it on the same wire
    // spec. The sidecar reads `composition.toolPresentation` to decide which
    // tool surface to register, so this is what makes Code mode reachable at
    // all — and what makes an unsandboxed host resolve down to `native`
    // before the sidecar ever sees the request. Best-effort like the rest of
    // this block: a failure leaves `composition` absent, which the sidecar
    // treats as `native`.
    const composition = await resolveTurnCompositionSafely({
      sessionId: session?.id,
      systemPrompt: opts.systemPrompt ?? opts.appendSystemPrompt,
      toolNames: opts.allowedTools,
      executionFingerprint: spec.executionFingerprint,
      selection: ctx.compositionSelection,
    })

    if (minted) {
      opts.execution = sendSpecFromResolved(
        spec,
        {
          endpoint: minted.endpoint,
          ticketId: minted.ticketId,
        },
        composition
      )
      // The shape `sidecar/dispatch/subprocess-env.mjs:validateRouteEnv`
      // enforces: the base URL must be the ticket endpoint, and the secret
      // rides the env overlay rather than the (secret-free) wire spec.
      opts.env = {
        ...opts.env,
        ANTHROPIC_BASE_URL: minted.endpoint,
        ANTHROPIC_API_KEY: minted.secret,
      }
    } else {
      opts.execution = sendSpecFromResolved(spec, undefined, composition)
    }
    if (spec.runtimeAdapter === "claude-agent-sdk") {
      const { claudeSdkRolloutOptions } = await import("./claude-sdk-rollout")
      const rollout = claudeSdkRolloutOptions(getAgentExecutionFlags())
      if (rollout) opts.claudeAgentSdk = { ...opts.claudeAgentSdk, ...rollout }
    }
    ctx.onResolvedExecutionSpec?.(spec)
  } catch {
    // Never fail the send over spec stamping.
  }

  // Trust proof is host-owned and stamped after plugin option transforms, so a
  // plugin cannot mint or widen the authority used to load provider-visible
  // local SDK skills/plugins.
  if (ctx.trustedWorkspaceRoots?.length) {
    opts.trustedWorkspaceRoots = [...new Set(ctx.trustedWorkspaceRoots)]
  } else {
    delete opts.trustedWorkspaceRoots
  }

  if (supportAgent) {
    const supportContext = await buildSupportAgentContext({
      locale: appSettings?.language,
      userText: ctx.routingContextHint?.promptText ?? ctx.twinUserMessage,
      diagnosticsEnabled: isSupportDiagnosticsEnabled(),
    })
    const safe = applySupportAgentSafety({
      ...opts,
      systemPrompt: `${character?.systemPrompt ?? ""}\n\n${supportContext}`.trim(),
      appendSystemPrompt: undefined,
      dynamicSystemPrompt: undefined,
    }) as SendOptions
    for (const key of Object.keys(opts) as Array<keyof SendOptions>) delete opts[key]
    Object.assign(opts, safe)
    delete opts.appendSystemPrompt
    delete opts.dynamicSystemPrompt
  }

  if (opts.claudeAgentSdk) {
    const { validateClaudeAgentSdkOptions } =
      await import("@cognia/agent-config-types/claude-agent-sdk-options")
    const validation = validateClaudeAgentSdkOptions(opts.claudeAgentSdk, {
      resume: opts.resumeSessionId,
      forkSession: opts.forkFromSessionId !== undefined,
      permissionMode: opts.permissionMode,
      bypassConfirmed: opts.bypassPermissionsConfirmed === true,
    })
    if (!validation.ok) {
      throw new Error(`invalid claudeAgentSdk options: ${validation.errors.join("; ")}`)
    }
    for (const warning of validation.warnings) {
      loggers.app.warn("Claude Agent SDK option warning", { warning })
    }
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
