// Shared types between the Tauri sidecar (which speaks Claude Agent SDK) and
// the React UI (which speaks AI SDK Elements / `ai` UIMessage parts).
//
// The shapes of `event` payloads from the sidecar mirror @anthropic-ai/claude-agent-sdk's
// SDKMessage; we re-declare a *narrow* subset here so the UI layer doesn't take
// a hard dependency on a Node-only package.

import type { UIMessage } from "ai"
import type {
  SearchProviderType,
  SearchProviderSettings,
  SearchType,
  SearchDepth,
  SearchRecency,
  SafeSearchLevel,
  SourceVerificationSettings,
  SearchUsageEntry,
  CustomSearchSource,
} from "@/lib/search/types"
import type { PetSettings } from "@/types/pet"
import type { ModelMapping, ModelMappingEntry, RoutingConfig } from "@/types/provider/model-mapping"
import type { RoutingStrategy } from "@/types/provider/auto-router"

// ---- Outbound (UI → Tauri → sidecar) -------------------------------------

/**
 * Per-category toggles for the in-process `cognia-tools` MCP server hosted
 * inside the sidecar. The sidecar reads this blob, builds the corresponding
 * MCP server, and merges it into `options.mcpServers` before the SDK sees
 * the call. This is a sidecar-protocol field — NOT an SDK-recognised option
 * — so the sidecar strips it from the `options` it actually passes to
 * `query()`. See `lib/settings/builtin-tools.ts` for the mapping from each
 * id to concrete tools.
 */
export interface BuiltinToolsConfig {
  /** Advanced FS ops the SDK's Read/Write/Glob/Grep don't cover (hash, diff, content_search, …). */
  fileExtras: boolean
  /** Structured git_* tools backed by the local `git` CLI. */
  git: boolean
  /** list/get/search/start/terminate processes. Off by default — high-risk. */
  process: boolean
  /** list_env, get_env, system_info. Read-only with secret redaction. */
  environment: boolean
  /** Allowlist-gated single-program shell. Off by default — overlaps SDK Bash. */
  shellAdvanced: boolean
  /**
   * Interactive PTY sessions in the SDK sidecar via `node-pty` (lazy
   * require — falls back to a clean error when the native binding is
   * unavailable). Off by default. Wave 1 — orthogonal to the dock-relay
   * path (`settings.terminal.exposeDockToAgents`); REPL gives the agent
   * a *private* persistent shell, the dock-relay shares the user's.
   */
  terminalRepl?: boolean
  /**
   * LSP code-intelligence tools (goto_definition / find_references / hover /
   * document_symbols / diagnostics) plus the diagnostics-after-edit feedback
   * loop. Off by default — language servers spawn lazily on first use
   * (desktop only; reuses the vscode-ext-host LSP host). See `sidecar/lsp/*`.
   */
  lsp?: boolean
}

/** Default values when the user hasn't customised the toggles. Mirrors `lib/db/settings.ts`. */
export const DEFAULT_BUILTIN_TOOLS: BuiltinToolsConfig = {
  fileExtras: true,
  git: true,
  process: false,
  environment: true,
  shellAdvanced: false,
  terminalRepl: false,
  lsp: false,
}

export interface SendOptions {
  cwd?: string
  model?: string
  fallbackModel?: string
  /** Replaces the SDK's default system prompt entirely. Mutually exclusive with `appendSystemPrompt`. */
  systemPrompt?: string
  /** Appended to the SDK's default system prompt. Mutually exclusive with `systemPrompt`. */
  appendSystemPrompt?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  additionalDirectories?: string[]
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan"
  env?: Record<string, string>
  /** Per-name MCP server configs forwarded to the SDK. */
  mcpServers?: Record<string, Record<string, unknown>>
  /** Hard cap on agentic turns inside a single SDK invocation (1..=100). */
  maxTurns?: number
  /** Forward partial-message stream events (only meaningful in streaming mode). */
  includePartialMessages?: boolean
  /** Which on-disk settings the SDK loads — subset of "user" | "project" | "local". */
  settingSources?: Array<"user" | "project" | "local">
  /** Dynamic subagent definitions keyed by name. */
  agents?: Record<string, Record<string, unknown>>
  /** Only use mcpServers from this blob; ignore on-disk discoveries. */
  strictMcpConfig?: boolean
  /** SDK effort level. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
  /**
   * Token budget for the SDK's extended-thinking pass. Positive values turn on
   * the SDK's `thinking` block; `undefined` (or `0`) leaves the SDK's default
   * in place. SDK note: streaming partial events are not emitted when this is
   * set, so leave `includePartialMessages` off when budgeting thinking.
   */
  maxThinkingTokens?: number
  /** Resume an existing SDK session by id. Mutually exclusive with `forkFromSessionId`. */
  resumeSessionId?: string
  /** Fork a new branch from an existing SDK session id. */
  forkFromSessionId?: string
  /**
   * Per-category toggles for the sidecar's built-in `cognia-tools` MCP
   * server. Sidecar-protocol field — the sidecar strips it before calling
   * the SDK. See {@link BuiltinToolsConfig}.
   */
  builtinTools?: BuiltinToolsConfig

  /**
   * Plugin tool manifest for the SDK sidecar runtime — bridges plugin
   * `.tools[]` contributions (which already feed ai-sdk via
   * `lib/plugin/bridge/tools-bridge.ts`) into the SDK sidecar via a
   * synthetic `cognia-plugin-tools` MCP server. Set by
   * `lib/claude/build-options.ts:resolveSendOptions` when the plugin
   * store reports enabled plugins with `tools` capability.
   *
   * Sidecar-protocol field — stripped from the SDK `options` blob before
   * `query()` is called. The sidecar synthesizes an in-process MCP server
   * from this manifest and proxies tool invocations back to the renderer
   * via `plugin_tool_exec` events on stdout.
   */
  pluginTools?: Array<{
    name: string
    description: string
    jsonSchema: object
    pluginId: string
  }>

  /**
   * Anthropic `container.skill_id` entries forwarded to the sidecar.
   * Sourced from plugin-contributed skills with
   * `source.kind === "anthropic-managed"` via
   * `lib/claude/skills-bridge.ts:extractContainerSkillIds`. The Anthropic
   * API caps a single request at 8 container skills. Added in M4 of the
   * plugin-first Computer Use plan.
   */
  containerSkillIds?: Array<{ skill_id: string; version?: string }>

  /**
   * Anthropic native tool descriptors (`computer_20251124`, `bash_20250124`,
   * `text_editor_20250728`) sourced from the
   * `native-anthropic-tool-registry`. Populated by `resolveSendOptions`
   * when the character has `enableComputerUse === true`. The sidecar
   * appends them to the SDK's `tools` array and routes `tool_use`
   * messages from the model back to the renderer via Tauri commands
   * named by `executeIpc.invoke` (e.g., `plugin_computer_use_execute`).
   *
   * Each descriptor mirrors the Anthropic Tools API shape — the sidecar
   * passes them through verbatim with only the `executeIpc` field
   * stripped (it's a renderer-side dispatch hint, not part of the API
   * contract).
   */
  anthropicTools?: Array<{
    /** Tool name surfaced to the model (e.g., `"computer"`). */
    name: string
    /** Anthropic native-tool type tag (e.g., `"computer_20251124"`). */
    type: string
    /** Optional per-tool beta header override (rare). */
    betaHeader?: string
    displayWidthPx?: number
    displayHeightPx?: number
    displayNumber?: number
    enableZoom?: boolean
    /** Tauri command name the sidecar invokes for each tool_use. */
    executeIpc: { invoke: string }
    permissionPolicy?: "always-ask" | "session-allow" | "preauth"
    /**
     * ADR-0020 W1 — when set, the Rust permission gate treats this turn's
     * dispatch for this tool as if the effective `Tier` were `forceTier`,
     * regardless of the persisted `AutomationSettings.perSurface.computerUse.tier`.
     * Populated by `applyComputerUseTools` from
     * `Character.computerUseSettings.requireConsent === true` (sets
     * `forceTier: "perCall"`). The sidecar forwards this as
     * `ctx.forceTier` on every dispatch invoke; the Rust `command_body!`
     * upgrades an `Allow` decision to `RequireConsent` when this is set.
     */
    forceTier?: "off" | "whitelist" | "perCall"
  }>

  /**
   * ADR-0020 W1 — propagates `Character.computerUseSettings.chatConsentMode`
   * to the dispatcher so Wave 3's session-grant store and the
   * `auto` mode dedup logic can read it. `undefined` is treated as
   * `"always-ask"` (the safe default that preserves today's behaviour).
   */
  computerUseConsentMode?: "always-ask" | "session-grant" | "auto"

  /**
   * ADR-0020 W3 — chat-modal suppression list. The sidecar's
   * `canUseTool` callback resolves `{ behavior: "allow" }` immediately
   * for any tool whose name appears here, skipping the renderer-side
   * `permission_request` event. Populated by `applyComputerUseTools`
   * from per-session grants when `chatConsentMode === "session-grant"`.
   *
   * SAFETY: the Rust permission gate runs independently on every
   * `desktop.*` call. Suppressing the chat modal does not bypass the
   * Rust-side check — it only spares the operator from a redundant
   * second prompt when both gates would have asked.
   */
  suppressApprovalForTools?: string[]

  /**
   * OpenCode-style glob permission ruleset consulted by the sidecar
   * `canUseTool` before emitting a `permission_request`. A resolved
   * `tool → glob → allow|ask|deny` map (see
   * `lib/claude/permissions/ruleset.ts`). `allow` runs without prompting,
   * `deny` rejects the tool call, `ask` falls through to the existing
   * round-trip. Assembled by `resolveSendOptions` from the baked-in
   * defaults + permission mode + character + `agentPermissions.commandRules`.
   * The fine-grained layer that augments the coarse allow/deny tool union.
   */
  permissionRuleset?: import("@/lib/claude/permissions/ruleset").Ruleset

  /**
   * Extra HTTP headers the sidecar should merge into the Anthropic
   * request. Populated by `resolveSendOptions` from
   * `computeAnthropicBetaHeaders` when at least one Anthropic native
   * tool is attached — `anthropic-beta: computer-use-2025-11-24` is the
   * canonical example. Multiple beta tokens are joined with commas; the
   * sidecar treats this map as authoritative and does not de-dup.
   */
  appendHeaders?: Record<string, string>

  /**
   * Runtime tool-search (deferred loading) switch. Sidecar-protocol field —
   * consumed by `sidecar/dispatch/anthropic.mjs`, not forwarded to `query()`
   * verbatim. When `true`, the dispatcher leaves the bundled CLI's default
   * tool-search behaviour in place (MCP tools defer behind tool search) and
   * marks only {@link alwaysLoadServers} / {@link alwaysLoadTools} as
   * `alwaysLoad`. When `false`/unset, every in-process server is marked
   * `alwaysLoad` so tools stay resident (legacy behaviour). Resolved from
   * {@link AppSettings.toolSearchRuntime} / {@link Character.toolSearchRuntimeOverride}.
   */
  toolSearchEnabled?: boolean
  /** MCP server names to keep always-resident when tool search is on. */
  alwaysLoadServers?: string[]
  /** Bare tool names to keep always-resident when tool search is on. */
  alwaysLoadTools?: string[]

  // ---- Convenience modes (sidecar-protocol fields) -------------------------
  // The dispatcher in `sidecar/dispatch/anthropic.mjs` strips these three
  // fields before calling `query()`. Translation to real SDK options happens
  // in `resolveSendOptions` (lib/claude/build-options.ts).
  //
  // Why these are distinct from the SDK options they expand to: surfacing them
  // as a single boolean each gives the UI one switch per intent — users don't
  // have to know that "bare" means `settingSources: [] + strictMcpConfig: true`.

  /**
   * Reproduces the `claude --bare` CLI flag for the SDK path: skip auto-loading
   * of on-disk settings (CLAUDE.md, hooks, plugins, MCP discoveries).
   * `resolveSendOptions` translates this to `settingSources: []` +
   * `strictMcpConfig: true`.
   */
  bareMode?: boolean
  /**
   * Mirrors `claude --debug`: turn on verbose logging in the SDK + any
   * spawned MCP / sub-process. `resolveSendOptions` translates this to
   * `env: { DEBUG: "*", CLAUDE_CODE_DEBUG: "1" }`.
   */
  debugMode?: boolean
  /**
   * Cognia-specific "brief output" pseudo-flag (no Claude Code CLI equivalent).
   * `resolveSendOptions` appends a concise-output snippet to
   * `appendSystemPrompt` so the model favours short answers.
   */
  briefMode?: boolean

  // ---- Provider routing (added in the multi-provider port) -----------------

  /**
   * Provider id this turn should execute against. When omitted, the sidecar
   * defaults to `"anthropic"` (back-compat with the original Anthropic-only
   * sidecar). Other ids dispatch to `@ai-sdk/<provider>` runners (P2).
   *
   * Built-in ids: `"anthropic" | "openai" | "google" | "mistral" | "cohere" |
   * "openrouter"`. Custom provider ids (from `AppSettings.customProviders`)
   * are also accepted and dispatch via the `protocol` field on
   * `providerCredentials`.
   */
  provider?: string

  /**
   * Per-call credential override. Set by `resolveSendOptions` from the
   * user's persisted provider settings so the sidecar doesn't read
   * keys from disk. Travels with the request and is wiped from logs.
   */
  providerCredentials?: {
    apiKey?: string
    baseURL?: string
    /**
     * AI SDK protocol to use when the provider id isn't a built-in.
     * Custom OpenAI-compatible endpoints set `"openai"`; CLIProxyAPI and
     * native Gemini set `"google"`; etc.
     */
    protocol?: "openai" | "anthropic" | "google" | "mistral" | "cohere"
  }

  /**
   * When the caller passed a model alias (e.g., `"fast"`), the routing
   * engine resolves it via the model-mapping registry and stamps the
   * resolution onto the SendOptions for downstream introspection +
   * fallback retries on the renderer side. The sidecar treats the resolved
   * `provider`/`model` fields as authoritative and ignores this metadata.
   */
  aliasResolution?: {
    alias: string
    resolvedTo: { providerId: string; modelId: string }
    fallbackEntries: ModelMappingEntry[]
    parameterDefaults?: Record<string, unknown>
  }

  /**
   * Records which routing strategy made the decision and a human-readable
   * reason. Surfaced in the message metadata badge for debugging /
   * transparency. Optional — set only when an alias was resolved or an
   * auto-router decision was made; direct provider:model selection leaves
   * this undefined.
   */
  routingDecision?: {
    strategy: RoutingStrategy
    reason: string
  }

  /**
   * Inbox / connector-driven gate. Set by `resolveSendOptions` when the
   * caller passed a `conversationOverride` whose `trigger.quietHours`
   * window covers `now`, when the conversation is muted, or when the
   * conversation has been forced into manual mode by the user. The
   * connector runtime checks this AFTER `resolveSendOptions` returns and
   * short-circuits the ai-run capture (no sidecar call, no outbound
   * enqueue) — instead it appends an `inbound.deferred_quiet_hours`
   * (or matching) audit row.
   *
   * Sidecar-protocol metadata only — the sidecar ignores it (mirrors
   * `aliasResolution` / `routingDecision`). Direct chat sends never set
   * it; this field is exclusively for the inbox context input.
   */
  suppressedReason?: "quiet_hours" | "muted" | "manual_mode_override"

  /**
   * Twin runtime metadata: the chunks + style samples actually used when
   * `applyTwinContext` ran during `resolveSendOptions`. The chat hook reads
   * this and persists a Twin-RAG `SourcesPart` on the assistant message so
   * the user can see what shaped the reply. Sidecar-protocol metadata —
   * stripped before the SDK call (no behavioural impact).
   */
  twinContext?: {
    twinId: string
    retrievedChunks: Array<{
      chunk: { vectorDocId: string; content: string; sourceId: string }
      score: number
      sourceTitle?: string
    }>
    selectedStyleSamples: Array<{
      id: string
      contextLabel: string
      summary: string
      tone: string[]
    }>
    degraded: boolean
  }

  /**
   * Long-term memory context injected this turn (ADR — autonomous memory).
   * Set by `resolveSendOptions` when `applyMemoryContext` recalled any
   * semantic/episodic memory. Mirrors `twinContext` — stashed so the chat hook
   * can render a "Memory" SourcesPart on the assistant message (transparency).
   * Stripped before the SDK call (no behavioural impact). `degraded` is true
   * when the memory runtime failed and fell back to no context.
   */
  memoryContext?: {
    retrievedMemories: Array<{
      id: string
      type: import("@/types/memory/memory").MemoryType
      text: string
      score: number
    }>
    proceduralCount: number
    degraded: boolean
  }

  /**
   * Agent-trace correlation identifiers — set by the chat hook before the
   * sidecar call so downstream events (tool spans, sub-agent spans,
   * connector callbacks) can attach to the same trace. Both are W3C-style
   * lower-case hex (`traceId` = 32 chars / 16 bytes, `spanId` = 16 chars /
   * 8 bytes). Sidecar-protocol metadata: the sidecar passes them through
   * untouched and does not depend on them for correctness.
   */
  traceId?: string
  spanId?: string
}

/**
 * A user-turn payload. Either a plain string (back-compat) or a list of
 * content blocks for multimodal input (text + images).
 */
export type SendContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image"
      source: {
        type: "base64"
        media_type: string
        data: string
      }
    }

export type SendContent = string | SendContentBlock[]

export type ApprovalDecision = "allow" | "allow_always" | "deny"

// ---- Inbound (sidecar → Tauri → UI) --------------------------------------

export interface ReadyEvent {
  type: "ready"
  /** Resolved version of `@anthropic-ai/claude-agent-sdk` inside the sidecar. */
  sdkVersion?: string
  /** Sidecar package version (sidecar/package.json). */
  sidecarVersion?: string
}

export interface SidecarExitedEvent {
  type: "sidecar_exited"
}

export interface LogEvent {
  type: "log"
  level: "info" | "warn" | "error"
  message: string
}

export interface SessionEndedEvent {
  type: "session_ended"
  sessionId: string
  result?: SDKResultMessage
  error?: string
}

/**
 * Sidecar emits this once per session, on the first SDK message that carries a
 * `session_id`. The frontend persists `sdkSessionId` on the matching ChatSession
 * row so future sends can pass `resumeSessionId` and continue the conversation
 * after a sidecar restart or app reload.
 */
export interface SdkSessionIdEvent {
  type: "sdk_session_id"
  sessionId: string
  sdkSessionId: string
}

export interface PermissionRequestEvent {
  type: "permission_request"
  sessionId: string
  requestId: string
  toolUseID: string
  toolName: string
  input: Record<string, unknown>
  title?: string
  displayName?: string
  description?: string
  blockedPath?: string
  decisionReason?: string
  suggestions?: unknown[]
}

export interface SDKEventEnvelope {
  type: "event"
  sessionId: string
  event: SDKMessage
}

/**
 * Emitted by `sidecar/fetch-interceptor.mjs` once per response on
 * `api.anthropic.com`. Carries the verbatim `anthropic-ratelimit-*` headers
 * (lowercased keys) the renderer's usage-collector parses into a snapshot.
 *
 * Not session-scoped — the interceptor sees raw HTTP, not session state.
 */
export interface UsageHeadersEvent {
  type: "usage_headers"
  headers: Record<string, string>
}

export type ClaudeEvent =
  | ReadyEvent
  | SidecarExitedEvent
  | LogEvent
  | SessionEndedEvent
  | SdkSessionIdEvent
  | PermissionRequestEvent
  | SDKEventEnvelope
  | UsageHeadersEvent

// ---- Narrow subset of SDKMessage we care about ---------------------------
// Full type lives in @anthropic-ai/claude-agent-sdk. We mirror only the bits
// we need for rendering. Anything else is `unknown`.

export interface BetaTextBlock {
  type: "text"
  text: string
  citations?: unknown
}

export interface BetaThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
}

export interface BetaToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface BetaToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | Array<{ type: "text"; text: string } | Record<string, unknown>>
  is_error?: boolean
}

export type BetaContentBlock =
  | BetaTextBlock
  | BetaThinkingBlock
  | BetaToolUseBlock
  | BetaToolResultBlock
  | { type: string; [k: string]: unknown }

export interface BetaMessage {
  id: string
  role: "assistant" | "user"
  content: BetaContentBlock[]
  stop_reason?: string | null
  model?: string
  usage?: Record<string, unknown>
}

export interface SDKAssistantMessage {
  type: "assistant"
  message: BetaMessage
  parent_tool_use_id: string | null
  uuid: string
  session_id: string
  error?: string
}

export interface SDKUserMessage {
  type: "user"
  message: { role: "user"; content: BetaContentBlock[] | string }
  parent_tool_use_id: string | null
  uuid: string
  session_id: string
}

export interface SDKResultMessage {
  type: "result"
  subtype: "success" | string
  duration_ms: number
  is_error: boolean
  result?: string
  total_cost_usd?: number
  uuid: string
  session_id: string
}

export interface SDKSystemMessage {
  type: "system"
  subtype: string
  uuid: string
  session_id: string
  [k: string]: unknown
}

export interface SDKPartialAssistantMessage {
  type: "stream_event"
  event: {
    type: string
    index?: number
    delta?: { type: string; text?: string; thinking?: string; partial_json?: string }
    content_block?: BetaContentBlock
    [k: string]: unknown
  }
  parent_tool_use_id: string | null
  uuid: string
  session_id: string
}

export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | { type: string; session_id: string; [k: string]: unknown }

// ---- Persistence shapes --------------------------------------------------

/** Distinguishes 1:1 character chats from multi-character team chats. */
/**
 * Discriminator on `ChatSession` that controls how `resolveSendOptions`
 * builds the SDK invocation:
 *   • `"direct"` — single character session (Phase 1 / legacy)
 *   • `"team"`   — multi-character team session (loads team config)
 *   • `"workflow-editor"` — chat panel inside the visual workflow editor
 *     (Phase C, ADR-0026 follow-up). Loads the cognia-workflow-ai plugin
 *     tools + the four workflow subagents + a system prompt block
 *     summarising the currently-open workflow.
 */
export type SessionKind = "direct" | "team" | "workflow-editor"

export interface ChatSession {
  id: string
  title: string
  /**
   * True while the title is auto-derived (instant first-message truncation
   * or the LLM-generated upgrade). A manual rename sets this to `false`,
   * permanently opting the session out of further auto-title generation.
   * Undefined on legacy rows is treated as auto.
   */
  titleAuto?: boolean
  /** Missing means "direct" (back-compat with v2 sessions). */
  kind?: SessionKind
  /** Direct sessions: the persona driving replies. */
  characterId?: string
  /** Team sessions: the team whose members reply. */
  teamId?: string
  /** Skills the user has temporarily disabled for this session only. */
  disabledSkillIds?: string[]
  pinned?: boolean
  /** Per-session overrides — take precedence over the character/app defaults. */
  model?: string
  /**
   * Per-session provider override. When set, this beats `Character.providerId`
   * and `AppSettings.defaultProvider` in `resolveSendOptions`. Written by the
   * composer's model-picker (P3) so a user can switch providers mid-session
   * without touching settings.
   */
  providerOverride?: string
  /**
   * Per-session account override (ADR-0028). Picks which `ProviderVault::accounts[]`
   * entry supplies the OAuth / API key, `CLAUDE_CONFIG_DIR`, base URL, and proxy
   * for this conversation. Precedence chain: `session.accountId →
   * character.accountIdOverride → settings.defaultAccountId →
   * ActiveAccountState.get(provider).active_account_id` (today's single-active
   * pointer is the final fallback). Undefined here = inherit from character or
   * the global active pointer, preserving today's behaviour for legacy rows.
   */
  accountId?: string
  /**
   * Sandbox enablement for this session (ADR-0028 Phase 4.5). When true,
   * `resolveSendOptions` adds the SDK builtin `Bash` / `Edit` / `Write` to
   * `disallowedTools`, filters native `text_editor` out of
   * `anthropicTools`, and surfaces the four `sandbox_*` MCP plugin tools so
   * the model picks them up instead. Precedence: session → character →
   * appSettings.sandboxDefaultEnabled. Undefined falls through.
   */
  sandboxEnabled?: boolean
  /**
   * ADR-0020 remote-target — per-session override of the computer-use GUI
   * execution target. `"local"` forces the host even if the character defaults
   * to a sandbox; `{ connectionId }` targets a specific cua sandbox;
   * `undefined` inherits the character. Precedence: session → character →
   * local (`lib/automation/sandbox-target.ts`).
   */
  computerUseTarget?: import("@/lib/automation/sandbox-target").ComputerUseTargetSetting
  systemPrompt?: string
  /**
   * Identity of the system-prompt preset this session was last configured
   * from. Written by the chat-header preset switcher (and the new active-
   * preset pill) and by `createSession`'s default-preset auto-apply path.
   * The pill uses it as the source of truth for "which preset is active",
   * falling back to a `preset.content === systemPrompt` heuristic when
   * unset (legacy sessions). Not indexed — adding optional non-indexed
   * fields doesn't require a Dexie store version bump.
   */
  activePresetId?: string
  workingDir?: string
  /**
   * Per-session override for the SDK permission mode. Toggled live via the
   * composer's Shift+Tab cycle. Wins over both the character and app default.
   */
  permissionMode?: SendOptions["permissionMode"]
  /** Free-form shared notes injected into every team member's transcript. */
  scratchpad?: string
  /**
   * SDK-issued conversation id, captured on the first event that carries a
   * `session_id`. Used to drive `SendOptions.resumeSessionId` so the
   * conversation survives sidecar restarts and app reloads.
   */
  sdkSessionId?: string
  /**
   * When forking, the SDK session id this branch was created from. The next
   * send on a session whose `forkedFromSdkSessionId` is set populates
   * `SendOptions.forkFromSessionId` (see `lib/claude/build-options.ts`) so the
   * SDK starts a fork instead of resuming. Cleared by the sidecar once the
   * fork completes (a fresh `sdkSessionId` is captured).
   */
  forkedFromSdkSessionId?: string
  /** Per-session override for `--bare` (skip on-disk auto-discovery). */
  bareMode?: boolean
  /** Per-session override for `--debug` (verbose logging). */
  debugMode?: boolean
  /** Per-session override for cognia-next's brief-output mode. */
  briefMode?: boolean
  /**
   * Per-session extended-thinking budget. Highest precedence — wins over both
   * the character and the app default. `undefined` falls through.
   */
  maxThinkingTokens?: number
  /** Set when this session is bound to an external IM platform conversation. */
  platformBinding?: import("@/types/connectors/binding").PlatformBinding
  /**
   * Per-session tool/MCP filter. Highest precedence — replaces the character
   * ({@link Character.toolFilter}) and global ({@link AppSettings.toolFilter})
   * filter for this conversation only. See {@link ToolFilterConfig}.
   */
  toolFilter?: ToolFilterConfig
  createdAt: number
  updatedAt: number
}

/**
 * Where the message originated. User messages have no senderId. Assistant
 * messages in team sessions carry the speaking character's id; in direct
 * sessions senderId is undefined (the session's character is implicit).
 */
export type MessageSenderKind = "user" | "assistant" | "system"

export interface StoredMessage {
  id: string
  sessionId: string
  role: UIMessage["role"]
  parts: UIMessage["parts"]
  /** Character id for team-session assistant messages; undefined otherwise. */
  senderId?: string
  senderKind?: MessageSenderKind
  /**
   * Denormalized copy of `metadata.platformMessage.messageId` (v49). Indexed
   * so `ConnectorBus.applyMessageEdit` / `applyMessageDelete` can locate the
   * target message in O(log n) instead of scanning every row. The v49
   * upgrade hook backfills this from existing metadata; new rows MUST keep
   * the field in sync with the metadata when both are present. Undefined
   * on assistant-side messages that never round-tripped through a
   * connector.
   */
  platformMessageId?: string
  /** Carries `usage` / `cost` info attached to the result-bearing assistant message. */
  metadata?: Record<string, unknown> & {
    /** Set on inbound messages from a platform connector. */
    platformMessage?: {
      messageId: string
      platform: import("@/types/connectors/platform-kind").PlatformKind
      sender: import("@/types/connectors/event").PlatformIdentity
    }
    /**
     * Set on inbound messages whose adapter recognised platform-native
     * rich content (Block Kit, Lark card, Discord embeds, Telegram
     * inline keyboard, OneBot CQ segments). The Inbox detail pane
     * renders this through the InboundA2UIRenderer to surface buttons
     * / cards / lists / images as structured UI rather than plaintext.
     */
    inboundA2UI?: import("@/lib/connectors/adapters/_shared/inbound-a2ui-types").InboundA2UIBlock
    /** Set on outbound (assistant) messages once enqueued. */
    outboundJobId?: string
    /**
     * Optional model-generated short label for the conversation-timeline
     * minimap, cached on the turn's user message so it's generated at most
     * once. Only populated when the timeline label-summary setting is on.
     */
    minimapLabel?: string
  }
  createdAt: number
}

/**
 * Shared shape for a renderer-side "background utility model" — the cheap
 * model used for non-chat helper tasks (conversation-title generation,
 * timeline label summaries). `enabled` gates the feature; `providerOverride`
 * / `model` are optional and fall back through the session/app defaults
 * (see `lib/ai/generation/utility-client.ts`).
 */
export interface UtilityModelConfig {
  enabled?: boolean
  providerOverride?: string
  model?: string
}

/** Conversation-timeline minimap preferences (see `components/chat/minimap`). */
export interface ConversationTimelineSettings {
  /** Master toggle for the right-edge timeline minimap. Defaults to on. */
  enabled?: boolean
  /** Persisted expand/collapse state of the minimap rail. Defaults to off. */
  expanded?: boolean
  /** Optional LLM-generated node labels (off by default — costs one call/turn). */
  labelSummary?: UtilityModelConfig
}

export type AppTheme = "light" | "dark" | "system"
export type AppFontScale = "xs" | "sm" | "md" | "lg" | "xl"
export type AppLanguage = "en" | "zh-CN"

/**
 * Filtering mode for the unified tool/MCP filter (Codex / Hermes-style
 * allow-deny lists over the catalog in `lib/tools/tool-catalog.ts`).
 *  - `"all"`   — no filtering; every otherwise-granted tool/server passes (default).
 *  - `"allow"` — ONLY the listed `tools` / `mcpServerIds` are permitted.
 *  - `"deny"`  — everything EXCEPT the listed `tools` / `mcpServerIds`.
 */
export type ToolFilterMode = "all" | "allow" | "deny"

/**
 * Configurable tool + MCP filter. Applied by `resolveSendOptions` AFTER the
 * existing allow/deny union, layered global (AppSettings) → character →
 * session (later scopes replace earlier ones when set). A `deny` entry always
 * wins over an `allow`. `tools` hold SDK-namespaced ids
 * (`mcp__<server>__<tool>`); `mcpServerIds` hold MCP server ids.
 */
export interface ToolFilterConfig {
  mode: ToolFilterMode
  tools?: string[]
  mcpServerIds?: string[]
}

/**
 * Runtime tool-search (deferred loading) policy. Maps to the
 * claude-agent-sdk `alwaysLoad` semantics (see ADR / sdk.d.ts): when
 * `enabled`, the bundled CLI defers MCP-server tools behind tool search and
 * only the `alwaysLoad*` set stays resident in the prompt. When disabled,
 * `resolveSendOptions` marks every in-process server `alwaysLoad` to reproduce
 * the legacy "everything resident" behaviour.
 */
export interface ToolSearchRuntimeConfig {
  enabled: boolean
  /** MCP server names kept always-resident (never deferred). */
  alwaysLoadServers?: string[]
  /** Bare tool names kept always-resident. */
  alwaysLoadTools?: string[]
}

export interface AppSettings {
  id: "singleton"
  /**
   * Epoch ms of the last write, bumped by `lib/db/settings.ts:saveSettings`.
   * Drives the companion sync cursor for the settings singleton: the desktop
   * sync source emits the row only when `updatedAt` postdates the phone's
   * cursor, so settings changes propagate to paired phones (pre-v61 the row
   * had no `updatedAt` and only ever synced once, on the first pull).
   */
  updatedAt?: number
  /**
   * OCR subsystem preferences (default provider, cloud fallback, per-provider
   * config, cache TTL, platform overrides, wizard dismissal). Merged forward
   * by `lib/db/settings.ts:getSettings()` so older installs pick up new
   * defaults without a schema migration. Defaults to `DEFAULT_OCR_SETTINGS`
   * from `lib/ocr/types.ts`.
   */
  ocrSettings?: import("@/lib/ocr/types").UserOcrSettings
  defaultModel?: string
  defaultSystemPrompt?: string
  defaultWorkingDir?: string
  /**
   * Id of the active workspace (project). Persists the `useProjectStore`
   * active-workspace pointer across restarts; hydrated on boot by the project
   * store's `load()`. `null`/undefined means no workspace is active.
   */
  activeProjectId?: string | null
  /**
   * Workspace Trust configuration (VS Code-style). When `enabled`, an active
   * workspace whose roots aren't all trusted runs in Restricted Mode (disk/host
   * tools denied). `promptOnSwitch` opts into an eager trust dialog on switch;
   * the default is lazy (prompt on first side-effecting send). Bypassed on Web
   * (no real local FS). Default: `{ enabled: true, promptOnSwitch: false }`.
   */
  workspaceTrust?: {
    enabled: boolean
    promptOnSwitch: boolean
  }
  permissionMode?: SendOptions["permissionMode"]
  /**
   * App-wide default for the SDK's extended-thinking budget. `undefined` or
   * `0` keeps thinking off. Overridden per-character (`Character.maxThinkingTokens`)
   * and per-session (`ChatSession.maxThinkingTokens`).
   */
  defaultMaxThinkingTokens?: number
  /** App-wide default for `--bare` (skip on-disk auto-discovery). Overridden by character + session. */
  bareMode?: boolean
  /** App-wide default for `--debug` (verbose logging). Overridden by character + session. */
  debugMode?: boolean
  /** App-wide default for cognia-next's brief-output mode. Overridden by character + session. */
  briefMode?: boolean
  /**
   * Auto-generate a conversation title from the first turn using a
   * configurable background model. `enabled` defaults to true; the instant
   * first-message truncation always runs as a placeholder regardless. See
   * `lib/ai/generation/title.ts` and the chat hook's turn-complete path.
   */
  conversationTitle?: UtilityModelConfig
  /**
   * Agent command-execution permission policy — the "Auto mode" that
   * auto-decides whether a shell command the agent runs is safe (allow),
   * needs confirmation (ask), or must be blocked (deny). Modeled on
   * OpenCode's permission ruleset + OpenClaw's exec-approval gate, with an
   * optional small-model judge. See `lib/claude/permissions/`.
   */
  agentPermissions?: {
    /** Command Auto-mode — auto-approve/deny shell commands. */
    autoApprove?: {
      /** Master switch. Off by default — every command prompts as today. */
      enabled?: boolean
      /**
       * `rules` = deterministic classifier only (offline). `rules+model`
       * = also consult a cheap background model when the classifier is
       * uncertain. Defaults to `rules`.
       */
      mode?: "rules" | "rules+model"
      /**
       * When true (default), a model `high`-risk verdict denies the command
       * instead of merely prompting.
       */
      denyOnHighRisk?: boolean
      /** Per-feature model override for the safety judge (provider/model). */
      judgeModel?: UtilityModelConfig
    }
    /**
     * OpenCode-style `command-glob → allow|ask|deny` overrides for the
     * agent's shell tool. Highest authority — an explicit match wins over
     * the classifier. Author with trailing globs, e.g. `"git push*": "ask"`.
     */
    commandRules?: import("@/lib/claude/permissions/ruleset").ToolRules
  }
  /** Right-edge conversation-timeline minimap preferences. */
  conversationTimeline?: ConversationTimelineSettings
  // Tools the user has chosen to always allow for this app (per-tool name).
  alwaysAllowTools: string[]
  /**
   * Per-category toggles for the sidecar's built-in `cognia-tools` MCP
   * server. Resolved into {@link SendOptions.builtinTools} on each turn by
   * `lib/claude/build-options.ts`. See {@link BuiltinToolsConfig}.
   */
  builtinTools: BuiltinToolsConfig
  /**
   * Global default tool/MCP allow-deny filter. Overridden per-character
   * ({@link Character.toolFilter}) and per-session
   * ({@link ChatSession.toolFilter}). Undefined ≡ `{ mode: "all" }`.
   */
  toolFilter?: ToolFilterConfig
  /**
   * Global default runtime tool-search (deferred loading) policy. Overridden
   * per-character ({@link Character.toolSearchRuntimeOverride}). Undefined ≡
   * disabled (legacy "all tools resident" behaviour).
   */
  toolSearchRuntime?: ToolSearchRuntimeConfig
  /**
   * Anthropic API key. v1 stores the key in IndexedDB plaintext — the user is
   * told this in the settings UI. Future iterations should migrate to an OS
   * keyring via `tauri-plugin-stronghold` or similar.
   */
  apiKey?: string
  /**
   * Optional Anthropic-compatible base URL. Set when the user is talking to a
   * proxy / alternative endpoint such as Kimi, DeepSeek, Qwen, or any
   * CCSwitch-managed provider. Forwarded to the sidecar as
   * `ANTHROPIC_BASE_URL`; empty/unset means the SDK uses the official endpoint.
   */
  apiBaseUrl?: string
  /**
   * Identifier of the provider currently in use. `"local"` means the user
   * pasted their own key in the API key section; `"ccswitch:<id>"` means the
   * key/baseUrl was sourced from a CCSwitch provider record. Powers the
   * "active" badge and drift detection in Settings → CCSwitch.
   */
  activeProviderId?: string
  /**
   * CCSwitch interop preferences. Drives the Settings → CCSwitch section.
   * `defaultPropagation` is the pre-selected list of external agents in the
   * "Use here & in…" provider-switch dialog; the user can still adjust per
   * switch.
   */
  ccswitchSync?: {
    enabled: boolean
    watchDb: boolean
    defaultPropagation: AgentId[]
  }
  /**
   * Claude subscription settings — drives the Settings → Subscription →
   * Claude probe-loop preferences. The credentials themselves live in the
   * OS keyring (Tauri-only); only cadence + threshold preferences are
   * stored here. See ADR-0025 and
   * `lib/subscription/core/types.ts:AnthropicSubscriptionSettings`.
   */
  subscriptionSettings?: import("@/lib/subscription/core/types").AnthropicSubscriptionSettings
  /**
   * Codex (OpenAI) subscription preferences — discovery fallback + refresh
   * cadence. Credentials live in the OS keyring; only renderer-side toggles
   * are stored here. See ADR-0025 and
   * `lib/subscription/core/types.ts:CodexSubscriptionSettings`.
   */
  codexSubscriptionSettings?: import("@/lib/subscription/core/types").CodexSubscriptionSettings
  /** Last time the auto-updater check ran (ms since epoch). Daily debounce. */
  lastUpdateCheckAt?: number
  /** UI theme; "system" follows OS preference. */
  theme?: AppTheme
  /** Base UI font size scale; maps to <html> font-size in px. */
  fontScale?: AppFontScale
  /** Active locale for translatable UI surfaces. */
  language?: AppLanguage
  /** Disable non-essential animations and transitions. */
  reduceMotion?: boolean
  /**
   * Visual workflow editor performance tier — user-facing knob in the editor
   * toolbar's perf popover. `undefined` is treated as `"auto"` (the resolver
   * picks the best tier from `prefers-reduced-motion` + workflow node count).
   * See `lib/workflow/editor/performance-tier.ts` for the resolution table.
   */
  workflowEditorPerformanceTier?: import("@/lib/workflow/editor/performance-tier").PerformanceTier
  /**
   * Tauri webview zoom level (1.0 = 100%). Persisted across launches and
   * applied at boot via `<WebviewZoomBootstrap />`. Range 0.5..2.0.
   */
  webviewZoom?: number
  /** Forward-compat opt-in for future telemetry; never wired in v1. */
  telemetryEnabled?: boolean
  /**
   * Integrated terminal preferences (plan: vscode-vivid-wilkinson).
   * `defaultShell` is the absolute path or PATH-resolvable name of the
   * shell binary used by the dock's "+ New" affordance when no
   * per-project override is set. Empty / unset → platform default
   * (`pwsh.exe` on Windows, `/bin/zsh` on macOS, `/bin/bash` on Linux).
   * The other fields drive xterm.js rendering and OSC 633 enablement.
   */
  terminal?: {
    defaultShell?: string
    fontFamily?: string
    fontSize?: number
    scrollback?: number
    enableShellIntegration?: boolean
    /**
     * When true, every selection in a terminal tab is auto-copied to the
     * system clipboard. Defaults to false so accidental selections don't
     * overwrite the user's clipboard.
     */
    copyOnSelect?: boolean
    /**
     * When true, the renderer manifests 4 synthetic `terminal_dock_*` tools
     * to the SDK sidecar through `pluginTools` (see
     * `lib/plugin/bridge/sidecar-tools-bridge.ts:buildTerminalDockManifestEntries`).
     * The sidecar proxies invocations back via `plugin_tool_exec`; the
     * renderer routes them to `lib/terminal/dock-tool-handler.ts` which
     * drives the user's visible PTY through `runInDockTab`. The agent
     * and the user share one shell.
     *
     * Off by default — the user opts in per machine. Agent access never
     * surfaces tabs the user spawned; the filter is by `agentSpawner` row
     * field on `useTerminalStore`. (Wave 1, supersedes Wave 3D.)
     */
    exposeDockToAgents?: boolean
    /**
     * Maximum wait (seconds) for `command_end` after writing into a dock
     * tab — applies to `runInDockTab` (chat affordance) and the agent's
     * `terminal_dock_*` MCP tool. Defaults to 60. Per-call overrides
     * (via the `timeoutSec` schema field) clamp to [5, 600]. Wave 4.
     */
    runInDockTimeoutSec?: number
    /**
     * xterm.js cursor shape. Defaults to `"block"`. Mapped 1:1 to the
     * `cursorStyle` Terminal option.
     */
    cursorStyle?: "block" | "bar" | "underline"
    /**
     * Whether the cursor blinks. Defaults to true (matches the xterm.js
     * `cursorBlink` default we set in `terminal-instance.tsx`).
     */
    cursorBlink?: boolean
    /**
     * Enable programming-font ligatures via `@xterm/addon-ligatures`. Off by
     * default — the addon shapes glyph runs at render time, a small cost only
     * worth paying for fonts that ship ligatures (Cascadia Code, JetBrains
     * Mono, Fira Code). Toggling remounts the terminal.
     */
    fontLigatures?: boolean
    /**
     * Force the spawned shell's console output encoding to UTF-8 (PowerShell
     * `[Console]::OutputEncoding` / cmd `chcp 65001`). Defaults to true. The
     * Rust spawn path (`src-tauri/src/terminal/integration.rs`) honors this;
     * it fixes mojibake on non-UTF-8 system codepages (e.g. GBK on Chinese
     * Windows). Disable only if you deliberately depend on the legacy
     * codepage.
     */
    forceUtf8?: boolean
    /**
     * Active terminal color scheme id (`lib/terminal/color-schemes.ts`).
     * `"auto"` (default) follows the app's light/dark mode with a neutral
     * palette; named schemes (campbell, dracula, solarized-dark, …) are fixed.
     */
    colorScheme?: string
    /**
     * xterm.js renderer preference. `"auto"` (default) tries WebGL → Canvas →
     * DOM. `"webgl"` / `"canvas"` force that renderer (still falling back if it
     * fails to initialize). `"dom"` skips both accelerated renderers — the
     * escape hatch when WebGL renders blank/garbled in a given WebView2.
     */
    renderer?: "auto" | "webgl" | "canvas" | "dom"
    /**
     * Named launch profiles (Windows-Terminal style). Each bundles a shell +
     * cwd + env + args the dock's profile picker can spawn directly. See
     * `lib/terminal/profiles.ts`.
     */
    profiles?: import("@/lib/terminal/profiles").TerminalProfile[]
    /** Id of the profile the plain "+ New" affordance uses, if any. */
    defaultProfileId?: string
    /**
     * GitHub-Copilot-style inline command autocomplete (ADR-0039). As you
     * type at a shell prompt, a debounced suggestion is shown as dim ghost
     * text after the cursor; Tab / → accepts it (writing the suffix into the
     * PTY — it never auto-runs), Esc dismisses.
     */
    autocomplete?: {
      /** Master switch. Off by default — the user opts in. */
      enabled?: boolean
      /**
       * Which built-in suggestion sources to use:
       *  - `"history"` — offline prefix-match of this session's history only.
       *  - `"ai"` — LLM completions only (needs a configured model).
       *  - `"both"` (default) — history + AI, ranked AI-first.
       * Plugin-contributed providers run regardless of this setting.
       */
      source?: "history" | "ai" | "both"
      /** Debounce before querying, ms. Default 350. Clamped [50, 2000]. */
      debounceMs?: number
    }
  }
  /** BCP-47 language tag for the composer's voice-input controls. */
  sttLanguage?: string
  /** `MediaDeviceInfo.deviceId` of the user's last-picked microphone. */
  selectedMicId?: string
  /**
   * Base URL for the SkillsMP skill marketplace API. Empty / unset disables
   * the SkillsMP source in the Browse tab — the local registry remains
   * available regardless. Trailing slash is stripped at read time.
   */
  skillsMpBaseUrl?: string
  /**
   * Skill bundle mirror targets. The cognia-owned canonical at
   * `<appData>/cognia/skills/<id>/` is always written; these toggles
   * control whether the on-enable push also mirrors to
   * `~/.claude/skills/<slug>/` (for Claude Code CLI visibility) and
   * `~/.agents/skills/<slug>/` (for Codex CLI visibility). Defaults are
   * `{ claude: true, codex: true }` and are applied at read time in
   * `stores/settings/settings-store.ts` so existing installs pick them up
   * without a Dexie migration. Per-mirror absence (e.g. Codex CLI not
   * installed) degrades to an info toast rather than an error.
   */
  skillBundleMirrors?: { claude?: boolean; codex?: boolean }
  /**
   * Workflow ids the user has pinned in the mobile Workflows tab. Surfaced
   * as a "Pinned" section above the main list. Lives in settings JSON to
   * avoid a Dexie migration on the workflow row.
   */
  pinnedWorkflowIds?: string[]
  /**
   * Row ids the user has pinned on the mobile `/me` screen. Surfaced as a
   * "Favorites" section above the grouped settings list. Lives in settings
   * JSON (same pattern as `pinnedWorkflowIds`) so a pin set on either surface
   * persists without a Dexie migration.
   */
  pinnedMeRowIds?: string[]
  /**
   * Customization of the desktop left navigation rail (`GuildRail`): which
   * nav items are pinned (shown directly) and which are hidden. Items neither
   * pinned nor hidden surface in the "More" overflow popover. Lives in settings
   * JSON (same pattern as `pinnedWorkflowIds`) so it persists without a Dexie
   * migration. See `@/types/shell/sidebar` for the model + default.
   */
  sidebarLayout?: import("@/types/shell/sidebar").SidebarLayout
  /**
   * Customization of the mobile home (chat welcome): the ordered quick-action
   * grid + which home sections are hidden. Lives in settings JSON (same pattern
   * as `sidebarLayout`) so it persists without a Dexie migration. See
   * `@/types/shell/mobile-home` for the model + default.
   */
  mobileHomeLayout?: import("@/types/shell/mobile-home").MobileHomeLayout
  /**
   * Customization of the mobile bottom tab bar: tab order, hidden tabs, and the
   * launch landing tab. Lives in settings JSON (same pattern as `sidebarLayout`)
   * — no Dexie migration. See `@/types/shell/mobile-tabs` for the model.
   */
  mobileTabLayout?: import("@/types/shell/mobile-tabs").MobileTabLayout
  /** Row density for the mobile workflow library list. Defaults to "comfortable". */
  mobileWorkflowView?: "compact" | "comfortable"
  /**
   * Customization of the `/discover` category navigation: which categories are
   * pinned (explicit order) and which are hidden. Reuses the `SidebarLayout`
   * `{ pinned, hidden }` shape (ids are `DiscoverCategoryId`) so the rail and
   * the discover page share one partition algorithm + customizer UI. Lives in
   * settings JSON (same pattern as `sidebarLayout`) — no Dexie migration.
   */
  discoverLayout?: import("@/types/shell/sidebar").SidebarLayout
  /**
   * Per-category view mode for the `/discover` grid (`grid` | `list` |
   * `compact`). Keyed by `DiscoverCategoryId` (plus the `favorites`
   * pseudo-category). Cross-device synced via settings JSON — unlike the
   * workflow library toggle, which is localStorage-only.
   */
  discoverViewByCategory?: Partial<
    Record<string, import("@/lib/discover/categories").DiscoverViewMode>
  >
  /**
   * Favorited discover items, stored as `${kind}:${id}` keys (e.g.
   * `character:abc`). Surfaced as the top "Favorites" pseudo-category and a
   * per-category "favorites" filter. Same JSON-array pattern as
   * `pinnedWorkflowIds` — no Dexie migration.
   */
  discoverFavorites?: string[]
  /**
   * Active view mode for the `/scheduler` dashboard (`overview` | `calendar` |
   * `timeline`). `overview` is the default static dashboard; `calendar` shows a
   * month grid of projected runs; `timeline` shows a day-grouped agenda. Lives
   * in settings JSON (same pattern as `discoverViewByCategory`) so it syncs
   * cross-device without a Dexie migration.
   */
  schedulerDashboardView?: "overview" | "calendar" | "timeline"
  /**
   * Active view mode for the `/goals` console open-goals grid (`grid` |
   * `list`). Lives in settings JSON (same pattern as `schedulerDashboardView`)
   * so the chosen layout follows the user across devices without a Dexie
   * migration.
   */
  goalConsoleView?: "grid" | "list"
  /**
   * Chat welcome page (`EmptyChatState`) personalization. All three live in
   * settings JSON (same pattern as `goalConsoleView`) so they persist without a
   * Dexie migration.
   *
   *  - `userName`: optional display name woven into the time-of-day greeting
   *    ("Good evening, {name}"). Empty → greeting shows without a name.
   *  - `welcomeStyle`: `"rich"` (default — aurora + bento cards) vs `"minimal"`
   *    (flat, compact). Toggled inline on the welcome page and from Settings →
   *    General. Mobile/narrow viewports force `"minimal"` regardless.
   *  - `welcomeHidden`: per-section dismissals. Once the user closes the
   *    "Quick start" capability grid or the "Try a prompt" starters, the flag
   *    keeps it hidden across reloads.
   */
  userName?: string
  welcomeStyle?: "rich" | "minimal"
  welcomeHidden?: { quickStart?: boolean; tryPrompt?: boolean }
  /**
   * Persisted view preferences for the MCP servers management panel
   * (`/settings?section=mcp`). Lives in settings JSON (same pattern as
   * `goalConsoleView` / `discoverFavorites`) so the chosen layout, grouping,
   * and favorites follow the user across devices without a Dexie migration.
   *
   *  - `view`: card grid vs. dense list for the "My Servers" tab.
   *  - `groupBy`: collapsible section grouping (`none` flat, by `transport`,
   *    or by enabled/disabled `status`). Favorites always float to the top.
   *  - `favorites`: server ids pinned to the top of the list, mirroring the
   *    `pinnedWorkflowIds` / `discoverFavorites` JSON-array pattern.
   */
  mcpPanel?: {
    view: "grid" | "list"
    groupBy: "none" | "transport" | "status"
    favorites: string[]
  }
  /**
   * Autonomous long-term memory configuration. Lives in settings JSON (same
   * pattern as `goalConsoleView` / `mcpPanel`) so it follows the user across
   * devices without a Dexie migration. Partial — unset fields fall back to
   * `DEFAULT_MEMORY_CONFIG`. The `memories` rows themselves live in their own
   * Dexie table (schema v65). See `@/types/memory/memory`.
   */
  memory?: Partial<import("@/types/memory/memory").MemoryConfig>
  /** View mode for the `/memory` management panel (`grid` | `list`). */
  memoryView?: import("@/types/memory/memory").MemoryViewMode
  /**
   * Last time the user opened the Inbox tab (ms since epoch). Used by the
   * mobile bottom Tab Bar to compute an unread badge over the Chat tab —
   * count of `inboundLedger` rows newer than this timestamp. `0` / unset
   * means "show every inbound row as unread".
   */
  lastInboxViewedAt?: number

  // ---- Text-to-Speech ----
  // The active TTS provider. See `lib/tts/types.ts` for the union.
  ttsProvider?:
    | "system"
    | "openai"
    | "gemini"
    | "edge"
    | "elevenlabs"
    | "lmnt"
    | "hume"
    | "cartesia"
    | "deepgram"
    | "xiaomi"
  /** Browser SpeechSynthesisVoice.voiceURI (system provider). */
  systemVoice?: string

  /** OpenAI TTS settings. */
  openaiVoice?: string
  openaiModel?: string
  openaiSpeed?: number
  openaiInstructions?: string
  openaiResponseFormat?: string

  /** Gemini TTS settings. */
  geminiVoice?: string

  /** Edge TTS settings. */
  edgeVoice?: string
  edgeRate?: string
  edgePitch?: string

  /** ElevenLabs TTS settings. */
  elevenlabsVoice?: string
  elevenlabsModel?: string
  elevenlabsStability?: number
  elevenlabsSimilarityBoost?: number

  /** LMNT TTS settings. */
  lmntVoice?: string
  lmntSpeed?: number

  /** Hume TTS settings. */
  humeVoice?: string

  /** Cartesia TTS settings. */
  cartesiaVoice?: string
  cartesiaModel?: string
  cartesiaLanguage?: string
  cartesiaSpeed?: number
  cartesiaEmotion?: string

  /** Deepgram TTS settings. */
  deepgramVoice?: string

  /** Xiaomi MiMo TTS settings. */
  xiaomiVoice?: string
  xiaomiModel?: string
  xiaomiStyle?: string
  xiaomiDialect?: string

  /** Common TTS controls. */
  ttsEnabled?: boolean
  ttsRate?: number
  ttsPitch?: number
  ttsVolume?: number
  ttsAutoPlay?: boolean
  ttsCacheEnabled?: boolean
  ttsStreamingEnabled?: boolean

  ttsCustomSSMLEnabled?: boolean
  ttsCustomSSML?: string
  ttsPronunciationDictionary?: Record<string, string>

  // ---- Web search (multi-provider) ----
  /** Master toggle. When false, the composer's web-search button is disabled. */
  searchEnabled?: boolean
  /** Default `maxResults` injected into search calls (1..50). */
  searchMaxResults?: number
  /** When true, retry next provider on failure. */
  searchFallbackEnabled?: boolean
  /** Active provider for new searches; falls back to first enabled provider. */
  defaultSearchProvider?: SearchProviderType
  /** Per-provider config (API key, enabled, priority, optional `cx` for Google). */
  searchProviders?: Record<SearchProviderType, SearchProviderSettings>

  /** Default search options applied when callers don't override. */
  defaultSearchType?: SearchType
  defaultSearchDepth?: SearchDepth
  defaultSearchRecency?: SearchRecency
  defaultSearchCountry?: string
  defaultSearchLanguage?: string
  defaultIncludeDomains?: string[]
  defaultExcludeDomains?: string[]
  defaultIncludeAnswer?: boolean
  defaultIncludeRawContent?: boolean

  /** LRU cache controls. */
  searchCacheEnabled?: boolean
  searchCacheTTL?: number
  searchCacheMaxEntries?: number

  /** Safe-search filter level. */
  searchSafeSearchEnabled?: boolean
  searchSafeSearchLevel?: SafeSearchLevel

  /** Source-verification settings (credibility scoring + cross-validation). */
  sourceVerificationSettings?: SourceVerificationSettings

  /** Per-provider usage tracking (counts, latencies, errors). */
  searchUsageStats?: Record<SearchProviderType, SearchUsageEntry>

  /** User-defined research sources (rendered as toggle pills in Global). */
  customSearchSources?: CustomSearchSource[]
  /** Currently-selected research source ids. */
  defaultSearchSources?: string[]

  // ---- Artifacts ----
  /**
   * Artifact panel + auto-detection preferences. The detector runs after each
   * assistant turn; the store dedupes by source fingerprint so toggling these
   * never produces duplicates from re-detection.
   */
  artifacts?: {
    /** Enable auto-detection of artifacts in assistant responses. */
    autoCreate?: boolean
    /** Minimum line count to auto-create code/document artifacts (3..50). */
    minLines?: number
    /** Subset of types eligible for auto-creation (defaults to all 9). */
    enabledTypes?: import("@/types/artifact/artifact").ArtifactType[]
    /** Show a sonner toast when an artifact is auto-created. */
    showNotification?: boolean
    /** Initial tab when the panel opens for a previewable artifact. */
    defaultPanelMode?: "preview" | "code"
    /** When false, artifacts are wiped when the session is cleared. */
    persistAcrossSessions?: boolean
  }

  // ---- Backup reminders & scheduling ----
  /**
   * Days between "you should back up" reminder toasts. 0 disables reminders.
   * Default 7. Range 1..90.
   */
  backupReminderDays?: number
  /** Epoch ms the user last clicked "Dismiss" on the reminder. */
  backupReminderDismissedAt?: number
  /**
   * Auto-schedule config — when enabled, the in-app provider writes a backup
   * to `dirPath` every `intervalDays`, retaining only the newest `retainCount`
   * files. Tauri-only (web has no `dirPath`).
   */
  backupAutoSchedule?: BackupAutoSchedule

  // ---- A2UI defaults (schema v13) ----
  /**
   * Global A2UI on/off. New characters default to this; per-character
   * `a2uiEnabled` overrides. When false, the model never receives the
   * `mcp__a2ui-bridge__*` tool whitelist or the A2UI system prompt.
   */
  a2uiDefaultEnabled?: boolean
  /** Default catalog id for new A2UI surfaces (academic / financial / general). */
  a2uiDefaultCatalogId?: string
  /** Default widget host strategy used when a surface omits the field. */
  a2uiDefaultHostStrategy?: import("@/types/a2ui/schema").A2UIWidgetHostStrategy
  /** Default widget theme. */
  a2uiDefaultTheme?: import("@/types/a2ui/schema").A2UIWidgetTheme
  /** LRU surface cap kept in zustand persist (default 20). */
  a2uiPersistenceLimit?: number

  // =============================================================================
  // Plugin-facing fields
  //
  // The plugin Theme / AI-Provider APIs read these directly from the
  // settings store. They live alongside the rest of the appearance and
  // provider configuration so a single Dexie write persists everything.
  // =============================================================================

  /** Active color preset. Plugin Theme API surfaces this as `colorTheme`. */
  colorTheme?: import("@/types/plugin/plugin-extended").ColorThemePreset
  /** User-defined custom theme palettes (UI colors, not export tokens). */
  customThemes?: import("@/types/plugin/plugin-extended").CustomTheme[]
  /** Currently active custom theme id; null when a preset is in use. */
  activeCustomThemeId?: string | null

  /** Active default AI provider id (e.g. "openai", "anthropic", "google"). */
  defaultProvider?: string
  /**
   * Default account override (ADR-0028) for sessions / characters that do not
   * set their own `accountId` / `accountIdOverride`. Refers to a UUIDv7 in
   * `ProviderVault::accounts[]` for the provider matched by `defaultProvider`.
   * Undefined keeps today's behaviour exactly — the single global active pointer
   * (`ActiveAccountState`) remains the source of truth.
   */
  defaultAccountId?: string
  /**
   * Pet subsystem preferences (v67). Undefined ⇒ defaults from
   * `DEFAULT_PET_SETTINGS`. See `components/settings/pet/pet-section.tsx`.
   */
  petSettings?: PetSettings
  /**
   * Stable, locally-generated install identifier. Used as the fallback seed for
   * the pet's deterministic appearance when no provider account id is available
   * (no PII; one random UUID written once). See `lib/pet/bones/account-id.ts`.
   */
  installUuid?: string
  /**
   * App-wide default for the ADR-0028 sandbox layer. When undefined or false,
   * sessions / characters that don't opt in see today's behaviour (SDK builtin
   * Bash / Edit / Write unchanged). When true, those tools are replaced
   * everywhere unless a specific session / character opts out.
   */
  sandboxDefaultEnabled?: boolean
  /**
   * App-wide default for the ADR-0028 / T4 sandbox tier. `"os"` (default)
   * routes Bash / Edit / Write through the per-platform OS sandbox
   * (sandbox-exec / bwrap / windows-codex). `"microvm"` routes them
   * through the existing `plugins/e2b-sandbox/` Firecracker workspace
   * backend for the strongest isolation. Beaten by `Character.sandboxTier`
   * when both are set. Only consulted when `sandboxDefaultEnabled` /
   * `sandboxEnabled` resolves true.
   */
  sandboxTier?: "os" | "microvm"
  /**
   * Per-provider configuration. Stores the full `UserProviderSettings`
   * shape (api key, base URL, model list, key rotation, OAuth state,
   * health metrics) used by the providers settings UI. The lean
   * `ProviderSettingsEntry` consumed by the plugin/embedding resolver is
   * derived via `lib/ai/providers/provider-persistence:toProviderSettingsEntry`.
   */
  providerSettings?: Record<string, import("@/types/provider/provider").UserProviderSettings>
  /**
   * User-defined custom AI providers (self-hosted, proxies). Stored as the
   * extended `CustomProviderSettings` so the providers UI can edit
   * per-model metadata. The resolver-facing `CustomProviderDefinition[]`
   * is derived via `provider-persistence:customSettingsToDefinitions`.
   */
  customProviders?: import("@/types/provider/provider").CustomProviderSettings[]
  /** Per-(provider:model) usage entries powering the cost tab. */
  providerUsageStats?: Record<string, import("@/types/provider/provider").ProviderModelUsageEntry[]>
  /** UI preferences for the providers settings page (filter, sort, view mode). */
  providerUIPreferences?: import("@/types/provider/provider").ProviderUIPreferences
  /** Whether the user dismissed the first-time providers onboarding banner. */
  providerOnboardingDismissed?: boolean
  /**
   * ISO 8601 timestamp recorded the first time the user dismissed or
   * completed the desktop first-run onboarding dialog. Set on any exit path
   * (skip, OAuth success, character pick, tour finish). The trigger
   * predicate in `lib/onboarding/should-show.ts` treats any non-empty value
   * as "do not show again" — re-entry happens via Settings only.
   */
  onboardingDismissedAt?: string

  // ---- Provider routing (P4) ----
  /**
   * User-defined model aliases (e.g., `"fast"`, `"coding"`, `"reasoning"`)
   * that resolve to ordered provider:model fallback chains. Read by the
   * routing engine inside `resolveSendOptions` when `session.model` matches
   * an `alias`. Built-in seeds come from `lib/ai/routing/default-mappings.ts`.
   *
   * Each `ModelMapping` carries an `alias` plus an ordered `providers`
   * array of `ModelMappingEntry`. The runtime registry wrapper lives in
   * `lib/ai/routing/model-mapping-registry.ts`.
   */
  modelMappings?: ModelMapping[]
  /**
   * Active routing strategy + per-provider constraints. Drives
   * `ProviderRoutingEngine.selectProvider` when an alias resolves to multiple
   * eligible entries. Defaults to `DEFAULT_ROUTING_CONFIG` from
   * `@/types/provider/model-mapping` (strategy `"balanced"`, no constraints,
   * 30s timeout, 3 fallback attempts).
   */
  routingConfig?: RoutingConfig
  /**
   * When true, on a `session_ended.error` for a turn that resolved via an
   * alias with non-empty `aliasResolution.fallbackEntries`, the renderer
   * adapter automatically retries with the next entry. Default true.
   * Set false for debugging — keeps the original error visible instead of
   * masking it with the fallback's outcome.
   */
  routingFallbackEnabled?: boolean

  // ---- Appearance (background, wallpapers, custom CSS, VSCode imports) ----
  background?: import("@/types/appearance").BackgroundSettings
  wallpapers?: import("@/types/appearance").Wallpaper[]
  customCss?: string
  customCssEnabled?: boolean
  importedVscodeThemes?: import("@/types/appearance").ImportedThemeRecord[]
  // ---- Appearance v47 (density / radius / motion / typography / a11y / auto-mode / monaco link) ----
  density?: import("@/types/appearance").DensitySettings
  radius?: import("@/types/appearance").RadiusSettings
  motion?: import("@/types/appearance").MotionSettings
  typographyExt?: import("@/types/appearance").TypographyExtSettings
  a11y?: import("@/types/appearance").A11ySettings
  autoMode?: import("@/types/appearance").AutoModeSettings
  monacoLink?: import("@/types/appearance").MonacoLinkSettings
  /** Active theme-pack id (from plugin manifest.themePacks). null when nothing applied. */
  activeThemePackId?: string | null
  /** Wraps user CSS in `@scope (#app) { ... }` when "app" (default), or applies globally. */
  customCssScope?: "app" | "global"
  /** Per-component surface customization (tonality / elevation / radius). */
  componentStyles?: import("@/types/appearance").ComponentStyles

  // ---- WebRTC WAN transport (ADR-0021) ----
  /**
   * Feature flag for the WebRTC DataChannel transport tier. When `true`
   * (default), the mobile companion tries `signaling → WebRTC` before
   * falling back to cloudflared on the WAN. When `false`, the tier is
   * skipped entirely and the transport stays on HTTPS+WS. Toggle from the
   * "Mobile companion" settings tab.
   */
  webrtcEnabled?: boolean
  /**
   * WSS endpoint of the rendezvous signaling service. Default: the
   * `DEFAULT_SIGNALING_URL` from `lib/signaling/types.ts`
   * (`NEXT_PUBLIC_SIGNALING_URL` build var, else
   * `wss://signaling.cognia.cn/v1/signaling`). Users may override to self-host
   * the `cognia-signaling-server` binary (or the Cloudflare Worker) on their
   * own domain.
   */
  signalingUrl?: string
  /**
   * Base URL of the Cloudflare-hosted public share service. Default: the
   * `DEFAULT_SHARE_URL` from `lib/share/config.ts` (`NEXT_PUBLIC_SHARE_URL`
   * build var, else `https://share.cognia.cn`). Users self-deploy the share
   * worker and point this at their own domain. The upload bearer secret is
   * stored separately in the OS keyring, not here.
   */
  shareUrl?: string
  /**
   * WebDAV snapshot sync (ADR-0001 extension). Periodically uploads the
   * encrypted backup package to a WebDAV server so another device can
   * download + restore it. The server password lives in the OS keyring
   * (`WEBDAV_PASSWORD_REF`); the zero-knowledge sync passphrase is never
   * persisted (session-only, see `lib/webdav/passphrase-cache.ts`).
   */
  webdavSync?: {
    enabled?: boolean
    /** Base URL with no trailing slash, e.g. `https://dav.example.com`. */
    baseUrl?: string
    username?: string
    /** Collection to store snapshots in. Default `/cognia-backups`. */
    remoteDir?: string
    /** ISO timestamp of the last successful upload. */
    lastSyncAt?: string
    /** ISO mtime of the newest remote snapshot the startup check has seen. */
    lastRemoteSeenAt?: string
  }
  /**
   * Additional ICE servers presented to the browser's `RTCPeerConnection`.
   * STUN entries only — TURN goes in {@link turnServers} so the UI can
   * render them separately. Defaults to two public STUN servers when
   * unset (Google + Cloudflare).
   */
  iceServers?: RTCIceServer[]
  /**
   * Optional TURN relay servers. Empty by default; ICE falls back to
   * cloudflared when STUN-only NAT traversal fails. Self-hosted coturn or
   * paid TURN-as-a-service URLs go here.
   */
  turnServers?: RTCIceServer[]

  // ---- External Bridge / MCP server (schema v17, Phase 1) ----
  /**
   * Configuration for the External Bridge MCP server that exposes Cognia's
   * wiki / RAG / runtime entities to outside coding agents (Claude Code,
   * Cursor, Cline, etc.). When `undefined`, the server is OFF.
   *
   * Permission gate semantics: the `enabledScopes` whitelist is checked on
   * every MCP call; scopes not in the list are denied with MCP error -32602.
   * Default install ships with only `wiki:cognia` + `rag:cognia` enabled.
   */
  externalBridge?: import("@/types/wiki").ExternalBridgeSettings

  // ---- Network Proxy ----
  /**
   * HTTP/HTTPS/SOCKS5 proxy configuration applied to outbound network
   * traffic from the renderer, the Rust backend (reqwest clients +
   * WebSocket dialer), and the Node sidecar (via injected
   * `HTTP_PROXY` / `HTTPS_PROXY` env vars). When `undefined` or
   * `mode === "off"`, every caller goes direct.
   *
   * The Rust side reads this via `proxy_config::current()`; the
   * frontend mirrors writes into Rust by calling `proxy_set` after
   * every save so the in-memory config stays coherent without a Dexie
   * round-trip on the hot path.
   */
  networkProxy?: import("@/types/network/proxy").NetworkProxySettings

  /**
   * Per-action biometric guard policy (Wave 1.5). Each flag, when true,
   * requires a successful biometric verification before the named action
   * runs. Devices with no biometric enrollment fall through unless the
   * action's caller passes `fallthroughWhenUnavailable: false`.
   */
  biometricRequiredFor?: BiometricGuardPolicy

  /**
   * Master switch for mobile-initiated Computer Use sessions (ADR-0020
   * follow-up). When `false`, the mobile `/me/computer-use` quick toggle
   * is off and the runtime refuses to enter a computer-use turn from a
   * mobile-driven conversation regardless of per-character `enableComputerUse`.
   * `undefined` falls back to the per-character flag, preserving today's
   * behaviour for existing installs.
   */
  mobileComputerUseEnabled?: boolean

  /**
   * ADR-0028 / T5 — per-action policy applied AFTER the automation
   * permission gate resolves Allow for a Computer Use action. Empty
   * arrays (the default) impose no extra constraint; any non-empty
   * allowlist hard-fails the call when the action's facts don't satisfy
   * it. Backed by `src-tauri/src/automation/policy.rs:Policy`; the TS
   * shape mirrors the Rust serde-camelCase exactly.
   */
  automationPolicy?: AutomationPolicy

  /**
   * Developer-only knobs. Surfaced under Settings → Developer in dev
   * builds; hidden in production builds (gate via `NODE_ENV`). Each
   * toggle relaxes a safety check that exists for a reason — never
   * enable them by default.
   */
  developer?: DeveloperSettings
}

/**
 * ADR-0028 / T5 — per-action policy shape, mirrored from
 * `src-tauri/src/automation/policy.rs::Policy` (serde camelCase).
 *
 * Empty arrays = no constraint (the default for fresh installs).
 * Any non-empty allowlist hard-fails Computer Use calls whose facts
 * don't satisfy it. Regex patterns are evaluated against the target's
 * window title and URL; forbidden screen regions are absolute pixels
 * and apply only to coordinate-based actions.
 */
export interface AutomationPolicy {
  allowedProcessNames: string[]
  allowedWindowTitlePatterns: string[]
  allowedUrlPatterns: string[]
  forbiddenScreenRegions: ScreenRect[]
}

export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/** Default empty policy — no extra constraints. */
export const DEFAULT_AUTOMATION_POLICY: AutomationPolicy = {
  allowedProcessNames: [],
  allowedWindowTitlePatterns: [],
  allowedUrlPatterns: [],
  forbiddenScreenRegions: [],
}

/**
 * Settings that loosen safety gates for development workflows. Each
 * field defaults to `undefined`/`false` and is hidden from production
 * UIs.
 */
export interface DeveloperSettings {
  /**
   * When `true`, the VS Code LSP binary policy
   * (`lib/plugin/vscode-shim/lsp-binary-policy.ts`) allows unsigned LSP
   * binaries to spawn after a single in-session consent prompt instead
   * of refusing them outright. Every spawn is still audit-logged with
   * `decision: "dev-allow"`.
   *
   * **Safety note:** intended for plugin authors testing their own
   * extensions before signing. Never enable on a machine where you
   * install third-party `.vsix` files you haven't audited.
   */
  unsignedLspAllowed?: boolean

  /**
   * User-managed Language Server entries — Phase B of the LSP reuse
   * work. Each entry is a `PluginLspServerDef` owned by `"user"` (vs.
   * plugin-contributed servers owned by a plugin id). The bootstrap at
   * `lib/plugin/lsp/lsp-user-servers.ts` registers them with the
   * `lsp-registry` on app start and re-registers when this list
   * changes.
   *
   * Stored in the settings singleton (rather than a dedicated Dexie
   * table) because the typical user has at most a handful of entries
   * and the existing settings store already gives us atomic save +
   * cross-tab sync for free.
   */
  userLspServers?: UserLspServerEntry[]
}

/**
 * One entry in `DeveloperSettings.userLspServers`. Shape mirrors
 * `PluginLspServerDef` from `@/types/plugin` — kept inline so the
 * types module avoids a circular dependency on the plugin barrel.
 */
export interface UserLspServerEntry {
  id: string
  name: string
  languages: string[]
  command: string
  args?: string[]
  env?: Record<string, string>
  transport?: "stdio"
  initializationOptions?: Record<string, unknown>
  settings?: Record<string, unknown>
  workspaceFolderRequired?: boolean
  /** When `false`, the registry skips this entry on bootstrap. Default true. */
  enabled?: boolean
}

export interface BiometricGuardPolicy {
  /** Sign-out / pair-revocation already wires this up; here for parity. */
  deletePairing: boolean
  /** Encrypted backup export from the mobile shell. */
  exportBackup: boolean
  /** Revealing secrets (API keys, OAuth tokens) in the UI. */
  revealSecrets: boolean
  /**
   * The "退出登录" button on mobile `/me`. When true (default), we re-prompt
   * the user's biometric before clearing the pairing JWT + Anthropic
   * credential. Off lets the action run unconditionally on devices the
   * user trusts.
   */
  signOut: boolean
}

export const DEFAULT_BIOMETRIC_GUARD: BiometricGuardPolicy = {
  deletePairing: true,
  exportBackup: false,
  revealSecrets: false,
  signOut: true,
}

export interface BackupAutoSchedule {
  enabled: boolean
  /** 1..30 days between automated backups. */
  intervalDays: number
  /** Absolute path to the destination directory. Tauri only. */
  dirPath?: string
  /** Keep this many newest auto-backup files; older ones are deleted. */
  retainCount: number
  /**
   * ISO-8601 timestamp of the most recent successful auto-backup. Stored on
   * the singleton settings row so it rides along with backups themselves
   * (the previous source — `backupHistory` — is local-only and isn't
   * carried in v3 packages).
   */
  lastRunAt?: string
}

/** Defaults applied when the user hasn't customized the schedule yet. */
export const DEFAULT_BACKUP_AUTO_SCHEDULE: BackupAutoSchedule = {
  enabled: false,
  intervalDays: 7,
  retainCount: 5,
}

/**
 * High-level grouping for presets. Drives the section's filter chips and
 * lets users organise their library across topics. Mirrors Cognia's preset
 * categories (`D:\Project\Cognia\types\content\preset.ts`) so labels carry
 * across between the two apps when users export/import presets.
 */
export type PresetCategory =
  | "general"
  | "coding"
  | "writing"
  | "research"
  | "education"
  | "business"
  | "creative"
  | "productivity"

/**
 * A reusable session-configuration template. The `content` field carries the
 * system prompt; the optional override fields mirror what `ChatSession` and
 * `Character` carry, so applying a preset to a session is a simple field
 * copy. All fields beyond the original 5 are optional — legacy rows from v2
 * (when this table only stored `id/name/content/createdAt/updatedAt`)
 * migrate forward losslessly via the v12 schema upgrade hook.
 */
export interface SystemPromptPreset {
  // --- v2 baseline fields ----------------------------------------------
  id: string
  name: string
  /** The system prompt body. Named `content` for back-compat with v2. */
  content: string
  createdAt: number
  updatedAt: number
  // --- metadata --------------------------------------------------------
  description?: string
  /** Single emoji glyph rendered inside the preset card avatar. */
  icon?: string
  /** CSS color token (oklch / hex) used for the card avatar background. */
  color?: string
  category?: PresetCategory
  // --- chat-config overrides (mirrors ChatSession / Character fields) -
  model?: string
  permissionMode?: SendOptions["permissionMode"]
  effort?: SendOptions["effort"]
  allowedTools?: string[]
  disallowedTools?: string[]
  /** Subset of MCP server ids to enable. Undefined means "all enabled". */
  mcpServerIds?: string[]
  /** Ordered list of skill ids appended to the system prompt at send time. */
  skillIds?: string[]
  /** Built-in or custom Agent Mode id. Undefined means "use whatever is active". */
  agentModeId?: string
  workingDir?: string
  // --- organisation ---------------------------------------------------
  isDefault?: boolean
  isFavorite?: boolean
  /** Seeded built-ins are read-only; UI offers "Duplicate" instead of edit. */
  isBuiltIn?: boolean
  /** Manual sort position. Lower comes first. Auto-assigned at create time. */
  sortOrder?: number
  // --- usage tracking -------------------------------------------------
  usageCount?: number
  lastUsedAt?: number
}

export type McpTransport = "stdio" | "sse" | "http"

/**
 * Identifier for an external AI coding agent that cognia-next can read MCP
 * server configs from and (for writable agents) project our managed servers
 * into. User-scope only — workspace/project-scope files are out of scope.
 *
 * `cline` and `roo-code` are read-only because their config paths live inside
 * VS Code's globalStorage and aren't stable across distributions.
 */
export type AgentId =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "codex"
  | "gemini"
  | "windsurf"
  | "cline"
  | "roo-code"

export interface McpServer {
  id: string
  name: string
  transport: McpTransport
  /**
   * Free-form configuration object passed verbatim to the SDK as
   * `options.mcpServers[name]`. Shape varies per transport:
   *   stdio: { command: string, args?: string[], env?: Record<string,string> }
   *   sse:   { url: string, headers?: Record<string,string> }
   *   http:  { url: string, headers?: Record<string,string> }
   */
  config: Record<string, unknown>
  /** Whether this server is exposed to Claude in cognia-next's own chats. */
  enabled: boolean
  /**
   * Per-agent projection toggles. When an entry is `true`, this server is
   * mirrored into that agent's user-scope MCP config file on every CRUD.
   * Unset / false / read-only agents stay untouched.
   *
   * Orthogonal to `enabled`: a server can be "off in cognia-next, on in
   * Cursor" or vice-versa.
   */
  appsEnabled?: Partial<Record<AgentId, boolean>>
  /**
   * Plugin origin (§A-6). Set by the plugin manager when an installed
   * plugin contributes an MCP server through its `mcp` capability. Lets
   * the runtime soft-disable / hard-delete the row when the plugin is
   * disabled / uninstalled — purely tagging metadata, no Dexie index needed.
   * User-created MCP rows leave this field undefined.
   */
  pluginId?: string
  createdAt: number
  updatedAt: number
}

export interface PendingApproval {
  sessionId: string
  requestId: string
  toolUseID: string
  toolName: string
  input: Record<string, unknown>
  title?: string
  displayName?: string
  description?: string
  blockedPath?: string
  decisionReason?: string
}

// ---- Characters / Skills / Teams -----------------------------------------

/**
 * A reusable persona. When a session has `characterId`, the character's config
 * supplies the system prompt, model, tool whitelist, MCP subset, and skills,
 * unless the session has explicit overrides for those fields.
 */
export interface Character {
  id: string
  name: string
  description?: string
  /** CSS color token (e.g. "oklch(...)" or a hex) used for avatar fallback. */
  avatarColor: string
  /** Optional one-glyph icon shown inside the avatar. */
  avatarEmoji?: string
  systemPrompt: string
  model?: string
  /**
   * Provider id this character prefers. Beats `AppSettings.defaultProvider`
   * but is itself overridden by `ChatSession.providerOverride`. Optional —
   * leave undefined to honour the global default. Added in the multi-provider
   * port (P3).
   */
  providerId?: string
  /**
   * Per-character account override (ADR-0028). Picks which `ProviderVault::accounts[]`
   * entry supplies credentials for every session bound to this character — unless
   * the session itself sets `ChatSession.accountId`, which wins. Undefined here
   * falls through to `AppSettings.defaultAccountId` and then to the global
   * `ActiveAccountState` pointer (today's behaviour).
   */
  accountIdOverride?: string
  /**
   * Per-character sandbox enablement (ADR-0028 Phase 4.5). Beats
   * `AppSettings.sandboxDefaultEnabled` but loses to `ChatSession.sandboxEnabled`.
   * Undefined falls through to the app default.
   */
  sandboxEnabled?: boolean
  /**
   * Sandbox tier (ADR-0028 T4). `"os"` (default) routes Bash / Edit / Write
   * through the per-platform OS sandbox (sandbox-exec / bwrap / windows-codex).
   * `"microvm"` routes them through the existing `plugins/e2b-sandbox/`
   * Firecracker workspace backend for the strongest isolation. Only relevant
   * when `sandboxEnabled` resolves true.
   */
  sandboxTier?: "os" | "microvm"
  /**
   * Provider id used for embedding this character's twin sources.
   * Independent of chat provider — a character can chat through OpenAI but
   * embed via Anthropic, or vice versa. When unset the twin runtime falls
   * back to `AppSettings.defaultProvider`. Switching this on an existing
   * character requires a re-embed (twin Workbench surfaces the banner). P5.
   */
  embeddingProviderId?: string
  permissionMode?: SendOptions["permissionMode"]
  allowedTools?: string[]
  disallowedTools?: string[]
  /** Subset of MCP server ids; undefined means "all enabled servers". */
  mcpServerIds?: string[]
  /** Ordered list of skills appended to the system prompt at send time. */
  skillIds?: string[]
  /**
   * Plugin-contributed skill ids attached to this character. Separate from
   * the existing `skillIds` (chat skills) — these resolve through the
   * skill-registry overlay (M1·T3) and may include anthropic-managed
   * container.skill_id entries. See `lib/claude/skills-bridge.ts`.
   */
  pluginSkillIds?: string[]
  workingDir?: string
  /**
   * Per-character extended-thinking budget. Beats the app default but loses to
   * a per-session override. `undefined` falls through to the app default.
   */
  maxThinkingTokens?: number
  /** Per-character default for `--bare` (skip on-disk auto-discovery). */
  bareMode?: boolean
  /** Per-character default for `--debug` (verbose logging). */
  debugMode?: boolean
  /** Per-character default for cognia-next's brief-output mode. */
  briefMode?: boolean
  /**
   * Opt-out of the synthetic `cognia-plugin-tools` in-process MCP server.
   * When `true`, `resolveSendOptions` skips populating
   * `SendOptions.pluginTools` for this character even if the plugin store
   * has enabled tool-contributing plugins. Leave unset / `false` to keep
   * the default opt-in behaviour.
   */
  disablePluginTools?: boolean
  /**
   * Per-character tool/MCP filter. When set, replaces the global
   * {@link AppSettings.toolFilter} for this character (a per-session
   * {@link ChatSession.toolFilter} replaces this in turn). See
   * {@link ToolFilterConfig}.
   */
  toolFilter?: ToolFilterConfig
  /**
   * Per-character runtime tool-search override. When set, replaces the global
   * {@link AppSettings.toolSearchRuntime}. See {@link ToolSearchRuntimeConfig}.
   */
  toolSearchRuntimeOverride?: ToolSearchRuntimeConfig
  /** Seeded built-ins are read-only (UI offers "Duplicate" instead of edit). */
  isBuiltIn?: boolean
  /** Whether this character is allowed to drive A2UI surfaces (4-tool whitelist + system prompt). */
  a2uiEnabled?: boolean
  /** Optional A2UI catalog this character defaults to (academic / financial / general / …). */
  a2uiCatalogId?: string
  /**
   * Soft-bind this character to an Employee Digital Twin. When set, the runtime
   * (`lib/twin/runtime/apply-twin-context.ts`, Phase 6) injects RAG-retrieved
   * chunks + style-sample few-shots into the send-time system prompt before
   * Claude is called. When unset the character behaves like a normal one.
   */
  twinId?: string
  /**
   * Per-character runtime preferences for the twin pipeline. All optional;
   * the runtime falls back to `DEFAULT_TWIN_SETTINGS` from `@/types/twin`.
   */
  twinSettings?: {
    enableRag?: boolean
    ragTopK?: number
    enableStyleFewShot?: boolean
    styleSamplesK?: number
    enableHybrid?: boolean
    hybridKeywordWeight?: number
  }
  platformDefaults?: import("@/types/connectors/binding").CharacterPlatformDefaults
  /**
   * Opt-in to the Anthropic Computer Use native tools (computer / bash /
   * text_editor) registered by the `cognia-computer-use` plugin or any
   * other plugin that calls `ctx.agent.registerNativeAnthropicTool`.
   * When `undefined` or `false`, `resolveSendOptions` does NOT attach the
   * registry's tool descriptors to the send — equivalent to "no
   * computer-use for this character". Mirrors the `twinId` / `a2uiEnabled`
   * soft-binding convention.
   */
  enableComputerUse?: boolean
  /**
   * Opt-in flag for the built-in skill tier in desktop sessions
   * (ADR-0026). When true, `build-options.ts:resolveSendOptions`
   * surfaces every registered built-in skill that targets the
   * desktop runtime via `opts.pluginTools` so the assistant can call
   * `lark.calendar.*` etc. from in-app chat.
   *
   * IM-bound sessions ignore this flag — built-in skills always
   * surface there, filtered by the per-conversation
   * `allowedBuiltInSkillIds` allowlist and the per-skill `imAccess`
   * tier. The flag is desktop-only because IM messaging is the
   * primary use case for the skill tier; desktop is opt-in to keep
   * the chat-history token budget tight.
   */
  enableBuiltInSkills?: boolean
  /**
   * Fine-grained per-character configuration that only applies when
   * `enableComputerUse === true`.
   */
  computerUseSettings?: {
    /**
     * Subset of registered native-anthropic-tool ids to expose. When
     * `undefined` or empty, every registered tool is exposed. Use this to
     * restrict a character to just `computer` without `bash` / `text_editor`,
     * for example.
     */
    allowedToolIds?: string[]
    /**
     * When `true`, every driving call is forced into the
     * `Decision::RequireConsent` path regardless of the global tier. The
     * default `false` honours the tier as configured in Settings →
     * Automation → Permissions.
     */
    requireConsent?: boolean
    /**
     * How the chat-side canUseTool modal behaves for the three computer-use
     * plugin tools (`computer_use` / `bash` / `text_editor`) on this
     * character. Independent of the Rust permission gate's tier — both
     * gates evaluate every call.
     *
     * - `"always-ask"` (default): every invocation prompts the user.
     * - `"session-grant"`: the first prompt offers an "always allow this
     *   session" button that remembers the verdict until the chat closes.
     * - `"auto"`: chat-side modal is suppressed; the Rust gate alone
     *   decides. Use sparingly — best paired with `Tier::Whitelist`.
     */
    chatConsentMode?: "always-ask" | "session-grant" | "auto"
    /**
     * Screen-off mode (ADR-0020 follow-up). When `true`, computer-use turns on
     * this character ensure the bundled virtual display is active and primary
     * so screen capture keeps working while the physical monitor is off /
     * asleep (the Windows session must stay unlocked). Windows-only; default
     * `false`. Strict: when the driver isn't installed the turn errors with
     * `vdd_unavailable` rather than capturing a black screen.
     */
    screenOffMode?: boolean
  }
  /**
   * ADR-0020 remote-target — where this character's computer-use GUI actions
   * run. `"local"` (or `undefined`) = the local host backend; `{ connectionId }`
   * targets a cua desktop sandbox (see `lib/db/sandbox-connections.ts`). The
   * connection id is the convergence anchor (a future ADR-0028 `cua-desktop`
   * tier reuses the same binding). Resolved with session precedence by
   * `resolveSendOptions` (`lib/automation/sandbox-target.ts`).
   */
  computerUseTarget?: import("@/lib/automation/sandbox-target").ComputerUseTargetSetting
  /**
   * Set ONLY when this row is a user-cloned copy of a plugin-overlay character
   * (ADR-0030). Never set on app-seeded built-ins or pure user-created rows.
   * Pairs with `sourcePackId` + `clonedFromPackCharacterId` to drive the
   * "Update available" comparison on the row when the pack ships a new version.
   */
  sourcePluginId?: string
  /** Pack id within the source plugin. See `sourcePluginId`. */
  sourcePackId?: string
  /**
   * The synthetic runtime id (`cognia-pack:<plugin>:<pack>:<local>`) at the
   * moment the user clicked Duplicate. Used to surface the original overlay
   * row in the Re-clone affordance.
   */
  clonedFromPackCharacterId?: string
  /**
   * Pack semver at clone time. Compared against the currently-registered
   * `PluginCharacterPackDef.version` to decide whether to show
   * "Update available". Updated only when the user explicitly re-clones.
   */
  packVersionAtClone?: string
  /**
   * v49 — snapshot of pack-managed fields at the moment this row was last
   * cloned (or last "Apply Update"-ed). Used by `applyPackUpdate` to
   * distinguish "user hasn't touched this field" (current value still
   * equals the snapshot → safe to overwrite from the pack) from "user
   * edited it" (diverged → preserve). Undefined for rows created before
   * v49 — `applyPackUpdate` falls back to a confirm-before-overwrite-all
   * dialog in that case.
   */
  pristineSnapshot?: PackPristineSnapshot

  // ---- v2 character-pack fields (mirror PluginCharacterDef v2) -------------
  /**
   * Optional avatar image — populated when the source character pack ships
   * one. UI renders this in preference to `avatarEmoji + avatarColor`; if
   * neither branch resolves in the current shell, falls back to the emoji.
   */
  avatarImage?: import("@/types/plugin/plugin-character-pack").PluginCharacterAvatarImage
  /** Personality / interaction metadata. Display-only this round. */
  persona?: import("@/types/plugin/plugin-character-pack").PluginCharacterPersona
  /**
   * Voice profile riding `lib/tts/`. When set, `resolveCharacterVoice()`
   * projects this into a `SpeechSettings` overlay at speak time.
   */
  voiceProfile?: import("@/types/plugin/plugin-character-pack").PluginCharacterVoiceProfile
  /**
   * Platform availability filter — when set, the overlay / picker suppresses
   * the character on platforms not listed. Inherited from the source pack
   * character at clone time; user may edit on cloned rows.
   */
  availableOnPlatforms?: import("@/types/plugin").PluginRuntimeProfile[]

  createdAt: number
  updatedAt: number
}

/**
 * Frozen snapshot of every pack-managed field on a character row at the
 * moment of its last clone / apply-update. Lives in `Character.pristineSnapshot`.
 *
 * The field set IS the single source of truth for which fields `applyPackUpdate`
 * overwrites — never extend without updating
 * `lib/plugin/character-pack/diff-pack-update.ts` in the same change.
 *
 * Fields are stored verbatim (deep-copied at capture time) so the diff is a
 * simple value comparison. Optional fields can be `undefined`, which means
 * "the source pack didn't define it" — distinct from "the user cleared it"
 * (which would change the row's field while leaving the snapshot intact).
 */
export interface PackPristineSnapshot {
  systemPrompt?: string
  description?: string
  avatarColor?: string
  avatarEmoji?: string
  model?: string
  providerId?: string
  permissionMode?: SendOptions["permissionMode"]
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServerIds?: string[]
  skillIds?: string[]
  pluginSkillIds?: string[]
  enableComputerUse?: boolean
  computerUseSettings?: Character["computerUseSettings"]
  sandboxTier?: Character["sandboxTier"]
  a2uiEnabled?: boolean
  a2uiCatalogId?: string
  platformDefaults?: Character["platformDefaults"]
  availableOnPlatforms?: import("@/types/plugin").PluginRuntimeProfile[]
  avatarImage?: import("@/types/plugin/plugin-character-pack").PluginCharacterAvatarImage
  persona?: import("@/types/plugin/plugin-character-pack").PluginCharacterPersona
  voiceProfile?: import("@/types/plugin/plugin-character-pack").PluginCharacterVoiceProfile
}

/**
 * A reusable instruction blob appended to a character's system prompt at send
 * time. Skills are pure markdown — no filesystem side effects in this version.
 */
export interface Skill {
  id: string
  name: string
  description?: string
  /** Markdown body, appended verbatim to the system prompt under `## <name>`. */
  content: string
  /** Tools this skill expects to call; unioned with the character's whitelist. */
  allowedTools?: string[]
  tags?: string[]
  /**
   * Seeded built-ins are read-only. Kept alongside `source` for back-compat;
   * new code should prefer `source === "builtin"`.
   */
  isBuiltIn?: boolean
  /** Where this skill came from. Defaults to "custom" for legacy rows. */
  source?: SkillSource
  /**
   * Lifecycle state. Defaults to "enabled" for legacy rows. "disabled" means
   * the skill is hidden from the system prompt at send time without deleting.
   */
  status?: SkillStatus
  /** High-level category, drives the UI sidebar/icons. Defaults to "custom". */
  category?: SkillCategory
  version?: string
  author?: string
  license?: string
  /** SemVer-style usage count, bumped each time the skill is sent. */
  usageCount?: number
  /** Last time the skill was appended to a system prompt. */
  lastUsedAt?: number
  /** Validation issues found by `lib/skills/validate.ts`. Non-fatal. */
  validationErrors?: SkillValidationError[]
  /**
   * Stable cross-source identity (e.g., GitHub `owner/repo:path`). Used by
   * the marketplace + native sync to detect that two rows are the same skill.
   */
  canonicalId?: string
  /** Marketplace item id this skill was installed from. */
  marketplaceSkillId?: string
  /** Path of the matching `~/.claude/skills/<dir>/` if synced to disk. */
  nativeDirectory?: string
  /** Which source last wrote this record. */
  syncOrigin?: SkillSyncOrigin
  /** Hash of (frontmatter + body + resources) used to detect drift. */
  syncFingerprint?: string
  lastSyncedAt?: number
  /** Most recent sync failure, cleared on successful sync. */
  lastSyncError?: string | null
  createdAt: number
  updatedAt: number
}

/**
 * 8 high-level skill categories — same set Cognia uses, so SKILL.md frontmatter
 * roundtrips between the two apps. Falls back to "custom" when unspecified.
 */
export type SkillCategory =
  | "creative-design"
  | "development"
  | "enterprise"
  | "productivity"
  | "data-analysis"
  | "communication"
  | "meta"
  | "custom"

export type SkillSource = "builtin" | "custom" | "imported" | "generated" | "marketplace"

export type SkillStatus = "enabled" | "disabled" | "error" | "loading"

export type SkillSyncOrigin = "frontend" | "builtin" | "native" | "marketplace"

export type SkillResourceKind = "script" | "reference" | "asset"

/**
 * A file bundled with a skill — script (executable), reference (markdown/text
 * companion), or asset (image, json, anything else). The text content is
 * stored inline in IndexedDB; binary assets store an opaque base64 payload.
 */
export interface SkillResource {
  id: string
  skillId: string
  kind: SkillResourceKind
  /** Display name shown in the resource manager. */
  name: string
  /** Relative path under the skill's native directory (`scripts/foo.sh`). */
  path: string
  /** Inline text or base64. Resource-manager UI treats binary by mimeType. */
  content: string
  /** Encoding used for `content`: utf-8 text by default. */
  encoding?: "utf-8" | "base64"
  mimeType?: string
  size?: number
  /** When true, body is inlined into the system prompt at send time. */
  inline?: boolean
  createdAt: number
  updatedAt: number
}

export interface SkillValidationError {
  code:
    | "missing-name"
    | "name-too-long"
    | "name-format"
    | "missing-content"
    | "description-too-long"
    | "duplicate-resource-path"
    | "resource-path-traversal"
    | "frontmatter-parse"
    | "unknown"
  message: string
  /** Frontmatter field or resource id this error applies to. */
  field?: string
}

/** Strategy for distributing user turns across a team's members. */
export type TeamOrchestration = "mention_round_robin" | "round_robin" | "manual" | "supervisor"

/**
 * A character slot inside a team. The character supplies defaults; any
 * non-empty override field replaces the corresponding character field for
 * this team only (does not mutate the underlying Character).
 */
export interface TeamMember {
  characterId: string
  /** Free-text label, e.g. "Critic" or "Researcher". Display-only. */
  role?: string
  /** Replaces character.systemPrompt when set. Skills are still appended. */
  systemPromptOverride?: string
  /** Replaces character.model when set. */
  modelOverride?: string
  /** Fully replaces (does not union) character.allowedTools when set. */
  allowedToolsOverride?: string[]
  /** Fully replaces (does not union) character.mcpServerIds when set. */
  mcpServerIdsOverride?: string[]
}

export interface Team {
  id: string
  name: string
  description?: string
  avatarColor: string
  avatarEmoji?: string
  /** Ordered member slots. The order determines round-robin reply order. */
  members: TeamMember[]
  orchestration: TeamOrchestration
  /** When orchestration === "supervisor", which member acts as the leader. */
  supervisorCharacterId?: string
  /** Team-level MCP override applied to members without their own subset. */
  mcpServerIds?: string[]
  isBuiltIn?: boolean
  createdAt: number
  updatedAt: number
}
