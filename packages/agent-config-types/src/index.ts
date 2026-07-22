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
} from "@cognia/web-search/types"
import type { PetSettings } from "./pet-settings"
import type {
  ModelMapping,
  ModelMappingEntry,
  RoutingConfig,
} from "@cognia/provider-types/model-mapping"
import type { RoutingStrategy } from "@cognia/provider-types/auto-router"
import type { LspServerConfig, LspSettings, LspSendOptions } from "./lsp-config"
import type {
  CompressionSettings,
  CompressionStrategy,
  CompressionTrigger,
  OpticalCompactionOptions,
  SessionCompressionOverrides,
} from "./compression"

// ---- Outbound (UI → Tauri → sidecar) -------------------------------------

/**
 * Compaction config resolved by `resolveSendOptions` and serialised onto
 * {@link SendOptions.compaction} for the sidecar. Every field is optional so an
 * absent blob falls back to the sidecar's built-in defaults. `summaryPrompt`
 * is composed in the renderer from the canonical summarizer prompt + the active
 * strategy + the user `focus`, so the sidecar never hard-codes wording.
 */
export interface ResolvedCompaction {
  /** Whether automatic compaction runs (generic path). Default true. */
  enabled?: boolean
  /** Window fraction (0..1) at which auto-compaction triggers. Default `AUTO_COMPACT_FRACTION`. */
  fraction?: number
  /**
   * Authoritative context-window size (tokens) for the active model, resolved
   * from the provider catalog by `resolveSendOptions`. The generic (AI-SDK)
   * compaction trigger prefers this over its own conservative regex table, which
   * floors families like `deepseek*` at 128k and would otherwise auto-compact a
   * real 1M model (e.g. deepseek-v4) at ~107k. Absent ⇒ the sidecar falls back
   * to that table.
   */
  contextWindow?: number
  /** Number of most-recent turns kept verbatim. Default 6. */
  keepRecent?: number
  /** Free-form focus / compact instructions merged into the summary prompt. */
  focus?: string
  /** Full summarization system prompt (canonical prompt + strategy + focus). */
  summaryPrompt?: string
  /**
   * Hard cap on the summary call's output tokens (generic path). Mirrors
   * `CompressionModelConfig.maxSummaryTokens` (default 500). Without it the
   * summary inherits the full turn's (potentially large) output budget.
   */
  maxSummaryTokens?: number
  /**
   * Alternate cheap/fast model for the summary call ONLY (generic path). Absent
   * ⇒ the sidecar reuses the turn's model + credentials. `model` alone (no
   * `protocol`/`credentials`) means "same provider, cheaper model". Credentials
   * are resolved in `resolveSendOptions` (async/registry), never in the pure
   * `resolveCompaction`. Treated like `providerCredentials` for log redaction.
   */
  summary?: {
    model?: string
    protocol?: string
    /**
     * Built-in provider id backing `credentials` (NOT the protocol). Set only
     * alongside `credentials`, i.e. when the summary runs on a DIFFERENT
     * provider than the turn; absent ⇒ the sidecar reuses the turn's provider
     * id along with its credentials. The sidecar needs the id — not just the
     * base URL — to pick the OpenAI endpoint family, since a responses-only
     * provider (codex) behind a relay preset is unidentifiable from its host.
     */
    providerId?: string
    credentials?: {
      apiKey?: string
      baseURL?: string
      apiFlavor?: import("@cognia/provider-types/provider").ApiFlavor
      headers?: Record<string, string>
    }
    protocolAdapterSpec?: SendOptions["protocolAdapterSpec"]
  }
  /**
   * Compaction strategy (generic path): summary | sliding-window | selective |
   * hybrid | recursive. Drives `planStrategy` in the sidecar.
   */
  strategy?: CompressionStrategy
  /** Trigger mode (generic path): token-threshold | message-count | manual. */
  trigger?: CompressionTrigger
  /** Message-count trigger threshold (generic path, when trigger = message-count). */
  messageCountThreshold?: number
  /** Keep ALL system messages verbatim (not just the leading block). */
  preserveSystemMessages?: boolean
  /** When false, summarize deterministically (extractive) instead of an LLM call. */
  useAISummarization?: boolean
  /** Importance score (0..1) above which a message is kept by the selective strategy. */
  importanceThreshold?: number
  /** Per-tool-result token cap applied during compaction (default 500). */
  maxToolResultTokens?: number
  /** Keep tool name/args/status metadata when capping a tool result. */
  preserveToolCallMetadata?: boolean
  /** Messages per chunk for the recursive strategy (default 20). */
  recursiveChunkSize?: number
  /** Drain line (0..1): compact down to at most this window fraction. */
  retainedFraction?: number
  /** Attach the pre-compaction message snapshot to the boundary event (enables undo). */
  captureUndoSnapshot?: boolean
  /** Shape + budget knobs for the "optical" strategy (ADR-0063); read only when
   * `strategy === "optical"`. Absent ⇒ the sidecar renderer's own defaults. */
  optical?: OpticalCompactionOptions
}

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
  /**
   * Unified core file-tool suite (grep/glob/read/ls/edit/multi_edit/write/
   * bash/TodoWrite) implemented in `sidecar/builtin-tools/core/`. Primarily
   * for the non-Anthropic ai-sdk dispatch path, which has no SDK-native file
   * tools; mutating tools are approval-gated and denied in Restricted Mode.
   */
  coreFiles?: boolean
  /**
   * Escape hatch: also register the coreFiles suite on the Anthropic path
   * (normally OFF there — the claude-agent-sdk ships native Grep/Read/Edit/
   * Bash and a second grep-shaped tool only confuses the model).
   */
  coreFilesOnAnthropic?: boolean
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
  /**
   * Tree-sitter code-graph tools (codegraph_search / node / callers / callees /
   * impact / context / explore / files / status). Read-only; desktop only;
   * per-session index built lazily. See `sidecar/builtin-tools/code/`.
   */
  codeGraph?: boolean
  /**
   * AST-aware structural code search/replace (ast_grep_search /
   * ast_grep_replace) across 25 languages, backed by the `ast-grep` CLI.
   * Desktop only; the binary is probed lazily. Off by default.
   */
  astGrep?: boolean
  /**
   * Dependency-source research (clone_dep_source / list_cloned_deps): clone a
   * dependency's source repo into an ignored `.cognia/clonedeps/` workspace so
   * the agent can read library internals. Desktop only; off by default.
   */
  dependencyResearch?: boolean
  /**
   * Web page snapshot (web_clone / web_clone_convert): download a live page's
   * HTML + all CSS/JS/image/font assets into a self-contained single file or a
   * directory bundle, with optional component extraction + Vue/React/Angular/
   * Svelte/jQuery codegen. Runs the vendored engine as an isolated child
   * process. Desktop only; off by default. See `sidecar/webclone/`.
   */
  webclone?: boolean
}

/** Default values when the user hasn't customised the toggles. Mirrors `lib/db/settings.ts`. */
export const DEFAULT_BUILTIN_TOOLS: BuiltinToolsConfig = {
  fileExtras: true,
  coreFiles: true,
  git: true,
  process: false,
  environment: true,
  shellAdvanced: false,
  terminalRepl: false,
  lsp: false,
  codeGraph: false,
  astGrep: false,
  dependencyResearch: false,
  webclone: false,
}

export interface SendOptions {
  /**
   * Host-only task workspace envelope. The Rust/Companion host consumes it
   * before spawning the agent and never forwards it to a model provider.
   */
  taskWorkspace?: {
    taskId: string
    runId: string
    parentRunId?: string
    workspaceRoot: string
    agentId: string
    agentKind: string
  }
  /**
   * Per-send turn id, stamped by `runAndCaptureAssistantReply` — an envelope
   * field rather than a real SDK option (it rides in `options` only because
   * Rust's `SendOptions.extra` flatten forwards unknown keys verbatim, and the
   * sidecar's dispatchers pick SDK options field-by-field, so it never reaches
   * the SDK).
   *
   * The sidecar echoes it back on every session-scoped event, bound to the loop
   * that was live when the turn started. That lets a capture discard events
   * belonging to a PREVIOUS turn of the same session: after a turn times out,
   * its best-effort `interruptSession` produces a late `session_ended` which the
   * NEXT turn's capture would otherwise consume (sessionId alone can't tell them
   * apart) and report as a spurious "ended with no assistant text".
   */
  turnId?: string
  cwd?: string
  model?: string
  fallbackModel?: string
  /**
   * Engage the sidecar's `tool_result_review` round-trip (ai-sdk channel):
   * before each tool result reaches the model, the renderer gets to review /
   * rewrite it (plugin `onPostToolUse`). Set by the chat send path and the
   * agent executor only when a plugin actually listens.
   */
  toolResultReviewEnabled?: boolean
  /** Replaces the SDK's default system prompt entirely. Mutually exclusive with `appendSystemPrompt`. */
  systemPrompt?: string
  /** Appended to the SDK's default system prompt. Mutually exclusive with `systemPrompt`. */
  appendSystemPrompt?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  additionalDirectories?: string[]
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto"
  env?: Record<string, string>
  /** Per-name MCP server configs forwarded to the SDK. */
  mcpServers?: Record<string, Record<string, unknown>>
  /** Hard cap on agentic turns inside a single SDK invocation (1..=100). */
  maxTurns?: number
  /**
   * Non-Anthropic (ai-sdk) channel only: agentic step budget for one user turn.
   * The sidecar's `dispatchAiSdk` runs a manual agent loop and continues across
   * tool-call legs until the model stops or this budget is reached. Undefined ⇒
   * the dispatcher's default (256). An explicit {@link maxTurns} takes
   * precedence. Ignored by the Anthropic Agent SDK path.
   */
  aiSdkMaxSteps?: number
  /**
   * Non-Anthropic (ai-sdk) channel only: per-leg agentic step cap (STEP_CHUNK).
   * Each `streamText` leg re-sends the whole growing conversation, so a LARGER
   * chunk means fewer legs → fewer full re-sends for a long tool-using turn (less
   * prompt-token overhead), at the cost of inspecting the context window less
   * often within a turn. Undefined ⇒ the dispatcher's default (16). Ignored by
   * the Anthropic Agent SDK path.
   */
  aiSdkStepChunk?: number
  /**
   * Non-Anthropic (ai-sdk) channel only: per-tool execution deadline (ms) for
   * READ-ONLY built-in tools (`content_search`, `file_search`, `glob`, `grep`,
   * `read`, the git read tools, `lsp_*`, …). These walk the workspace with no
   * internal deadline, so a huge / cyclic tree makes the handler hang — and
   * because the tool is "in flight" the stream-idle watchdog is paused, so the
   * turn only dies at the wall-clock timeout. The bridge bounds each such
   * handler and surfaces a recoverable `tool-error` instead. Exec tools (bash /
   * shell / process) self-bound and are excluded. Undefined ⇒ the bridge default
   * (120000). `0` disables the net.
   */
  toolExecutionTimeoutMs?: number
  /**
   * Hard USD cost ceiling for a single SDK invocation. When the cumulative cost
   * of one send crosses this, the SDK halts and emits a `result` with
   * `subtype === "error_max_budget_usd"`. Used by `/goal` (mapped from
   * `GoalConfig.maxBudgetUsd`) as a per-turn runaway-cost guard that complements
   * the renderer-side turn/token budget. Undefined → no ceiling.
   */
  maxBudgetUsd?: number
  /** Forward partial-message stream events (only meaningful in streaming mode). */
  includePartialMessages?: boolean
  /** Which on-disk settings the SDK loads — subset of "user" | "project" | "local". */
  settingSources?: Array<"user" | "project" | "local">
  /** Dynamic subagent definitions keyed by name. */
  agents?: Record<string, Record<string, unknown>>
  /**
   * Run THIS turn's main thread AS the named subagent (its system prompt, tool
   * restrictions, and model). Must be a key present in {@link agents}. Equivalent
   * to Claude Code's `@agent` / `--agent`. Set by `resolveSendOptions` from the
   * composer's `@`-mention. Anthropic path forwards it to the SDK's `agent`
   * option; the ai-sdk path applies a synthetic system/tools overlay instead.
   */
  agent?: string
  /**
   * Forward subagent text + thinking blocks as assistant/user messages with
   * `parent_tool_use_id` set (default off in the SDK). Enabled for team /
   * workflow-editor so the SDK-subagent bridge can render rich nested logs.
   */
  forwardSubagentText?: boolean
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
   * Mirror of `AppSettings.cacheOptimizationEnabled` for the sidecar. On the
   * non-Anthropic ai-sdk path with the anthropic protocol, the dispatcher
   * places an explicit `cacheControl: ephemeral` breakpoint on the stable
   * system segment so the prefix caches across turns. Other protocols cache
   * automatically and only need the prefix stability this flag enables in
   * `resolveSendOptions`.
   */
  cacheOptimizationEnabled?: boolean
  /**
   * The per-turn dynamic tail of the system prompt (twin RAG chunks + style
   * few-shot, memory recall) when {@link cacheOptimizationEnabled} is on. It is
   * the exact suffix of `appendSystemPrompt`, surfaced separately so the ai-sdk
   * dispatcher can place its second `cacheControl` breakpoint at the
   * stable/dynamic boundary — caching `systemPrompt` + the stable part of
   * `appendSystemPrompt`, leaving only this tail uncached so it never churns the
   * cache write. `appendSystemPrompt` still carries the full text, so paths that
   * ignore this field (the native Anthropic SDK) lose nothing.
   */
  dynamicSystemPrompt?: string
  /**
   * Resolved conversation-compaction config for the sidecar. The renderer
   * resolves session ← character ← appSettings (`resolveSendOptions`) and
   * serialises the result here so the sidecar — which cannot import `lib/` —
   * honours the user's threshold / keep-recent / focus / strategy prompt
   * without hard-coding them. Absent ≡ the sidecar's built-in defaults
   * (auto-compaction on at `AUTO_COMPACT_FRACTION`, keep last 6). The
   * Anthropic path ignores all but `focus` (the Agent SDK owns its own
   * compaction); the generic (AI-SDK) path honours every field.
   */
  compaction?: ResolvedCompaction
  /**
   * Per-category toggles for the sidecar's built-in `cognia-tools` MCP
   * server. Sidecar-protocol field — the sidecar strips it before calling
   * the SDK. See {@link BuiltinToolsConfig}.
   */
  builtinTools?: BuiltinToolsConfig

  /**
   * Resolved LSP server list + master toggle for the agent runtime LSP.
   * Sidecar-protocol field: the renderer resolves builtin ← user ← project
   * layers (`lib/lsp/resolve-config.ts`) and serialises the result here so
   * the sidecar — a separate Node project that cannot import `lib/` — never
   * hard-codes its server registry. See {@link LspSendOptions}.
   */
  lsp?: LspSendOptions

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
   * Anthropic `container.skill_id` entries for plugin-contributed skills with
   * `source.kind === "anthropic-managed"` (via
   * `lib/claude/skills-bridge.ts:extractContainerSkillIds`).
   *
   * @deprecated NOT delivered: the Claude Agent SDK exposes no `query()` option
   * to attach uploaded/managed skill_ids (verified against sdk 0.3.x — no
   * runtime reads `containerSkillIds`, `SdkBeta` has no skills value, no
   * `container.skills` request is built). The sidecar dispatcher no longer
   * forwards this field, and `resolveSendOptions` warns when managed skills are
   * selected instead of silently dropping them. Retained on the type only so a
   * future SDK that adds the capability can be re-wired without a schema change;
   * do not set it expecting it to take effect. See ADR-0020.
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
   * Session-global "always allow" tool names (from `AppSettings.alwaysAllowTools`).
   * Honored by BOTH sidecar `canUseTool` gates (anthropic + ai-sdk) so a tool the
   * user marked "Allow always" runs without a `permission_request` round-trip —
   * previously only the ai-sdk path read this and the anthropic path relied on the
   * renderer's `allowListRef` to auto-answer the round-trip. A confinement `deny`
   * (credential path) still overrides this; a confinement `ask` does not (an
   * explicit name-level grant is deliberate). Populated by `resolveSendOptions`.
   */
  alwaysAllowTools?: string[]

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
   * Workspace confinement policy (ADR-0028 "lite") consulted by the sidecar
   * `canUseTool` gates. When set, the built-in file/bash tools are confined to
   * `roots`: a mutator call whose target escapes every root escalates to the
   * approval round-trip ("ask"), and any op resolving into a protected
   * credential path (`.ssh`/`.aws`/`.git-credentials`/…) — directly or via a
   * symlink escape — is hard-denied. Read-only tools outside the roots are not
   * confined (only secret paths deny). Populated by `resolveSendOptions` from
   * the active workspace roots (`cwd` + `additionalDirectories`); omitted when
   * the heavy OS sandbox is active for the session (that path enforces at the
   * OS level instead, so the two never double-confine).
   */
  confinement?: { enabled: boolean; roots: string[] }

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
     * native Gemini set `"google"`; etc. Plugin-contributed protocol
     * adapters carry their namespaced id (`${pluginId}:${id}`) and ride a
     * `protocolAdapterSpec` alongside.
     */
    protocol?: import("@cognia/provider-types/provider").ResolverProtocol
    /**
     * Explicit OpenAI endpoint family (responses/chat/auto). Overrides the host
     * heuristic so the Responses API can be used on Azure OpenAI, on compatible
     * gateways that proxy `/responses`, and on custom base URLs. Consumed by the
     * sidecar's `decideOpenAiEndpointFlavor`. Omitted = "auto".
     */
    apiFlavor?: import("@cognia/provider-types/provider").ApiFlavor
    /**
     * Extra default headers forwarded into the provider client. Used by the
     * Codex ChatGPT-login path (`ChatGPT-Account-Id`, `OpenAI-Beta`,
     * `originator`, `OAI-Product-Sku`). Absent for providers that need only a
     * bearer.
     */
    headers?: Record<string, string>
    bedrockAuthMode?: import("@cognia/provider-types").BedrockAuthMode
    region?: string
    accessKeyId?: string
    secretAccessKey?: string
    sessionToken?: string
    profile?: string
    roleArn?: string
    roleSessionName?: string
  }

  /**
   * Declarative execution spec for a plugin-contributed protocol
   * (`openai-compatible-variant`). Set by `resolveSendOptions` when the
   * resolved protocol is a registered plugin adapter id; the sidecar's
   * variant adapter executes it with fetch + SSE parsing — pure data, no
   * plugin code crosses the process boundary. Passes through the Rust
   * SendOptions via its `#[serde(flatten)]` catch-all.
   */
  protocolAdapterSpec?:
    | import("@/types/plugin/plugin-protocol-adapter").OpenAiCompatibleVariantSpec
    | import("@/types/plugin/plugin-protocol-adapter").SidecarCodeAdapterSpec

  /**
   * Sampling/generation parameters (AI SDK v6 call-option names) assembled
   * from the resolved provider's configured inference defaults. The ai-sdk
   * dispatcher spreads these into `streamText`; the legacy Anthropic path
   * ignores them. Absent when the provider has no inference config.
   */
  modelParams?: import("@cognia/provider-types/provider").ModelInferenceParams

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
    /**
     * Error-class-specific fallback chains from the mapping — a
     * context-window / content-policy failure retries through these
     * instead of the main chain (`lib/claude/routing-fallback.ts`).
     */
    specialFallbacks?: import("@cognia/provider-types/model-mapping").ModelMappingSpecialFallbacks
    /** Per-error-class retry budgets for the main chain. */
    retryPolicy?: import("@cognia/provider-types/model-mapping").ModelMappingRetryPolicy
  }

  /**
   * Records which routing strategy made the decision and a human-readable
   * reason. Surfaced in the message metadata badge for debugging /
   * transparency. Optional — set only when an alias was resolved or an
   * auto-router decision was made; direct provider:model selection leaves
   * this undefined.
   */
  routingDecision?: {
    strategy: RoutingStrategy | (string & {})
    reason: string
    /**
     * Advisory daily-budget overage: the selected provider is past its
     * `dailyCostBudget` but was the only viable candidate. The renderer
     * surfaces a once-per-day toast; the send proceeds regardless.
     */
    overBudgetWarning?: { providerId: string; spend: number; budget: number }
  }

  /**
   * Set when opt-in auto routing rewrote a non-alias model to a tier alias
   * (before `aliasResolution` resolved it): the difficulty `score` and the
   * chosen `tier` alias, for the transparency badge. Sidecar-protocol metadata
   * only — the sidecar ignores it (mirrors `routingDecision`).
   */
  autoRouting?: { score: number; tier: string }

  /**
   * Advisory capability-gate notice: the user requested a feature (e.g. a
   * reasoning `effort` level) that the resolved model does not support per
   * its models.dev metadata, so the parameter was silently dropped to avoid
   * a provider 400. The renderer surfaces a once-per-model toast; the send
   * proceeds regardless. Sidecar-protocol metadata only — the sidecar
   * ignores it (mirrors `routingDecision`).
   */
  droppedCapabilityWarning?: { capability: "effort"; model: string; provider?: string }

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
    /**
     * Optional formatted source citations for the retrieved chunks — metadata
     * only, never part of the assembled prompt. Present when the character has
     * `enableCitations` on. Structural mirror of `@cognia/rag` `Citation`.
     */
    citations?: Array<{
      id: string
      marker: string
      fullCitation: string
      source: string
      title?: string
      relevanceScore?: number
    }>
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
      evidenceState?: import("@/types/memory/memory").MemoryEvidenceState
      reviewStatus?: import("@/types/memory/memory").MemoryReviewStatus
    }>
    proceduralCount: number
    withheldCount?: number
    budget?: { limit: number; used: number; truncated: boolean }
    degraded: boolean
  }

  /**
   * Project (workspace) knowledge-base context injected this turn (project-scoped
   * RAG). Set by `resolveSendOptions` when `applyProjectKnowledgeContext`
   * retrieved any chunks from the active workspace's knowledge files. Mirrors
   * `twinContext` / `memoryContext` — stashed so the chat hook can render a
   * "Project knowledge" SourcesPart. Stripped before the SDK call. `degraded` is
   * true when the runtime failed and fell back to no context.
   */
  projectKnowledgeContext?: {
    retrievedChunks: Array<{
      fileId: string
      fileName?: string
      content: string
      score: number
    }>
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
  /** W3C propagation header derived from traceId/spanId for Rust and sidecar consumers. */
  traceparent?: string
}

/**
 * A user-turn payload. Either a plain string (back-compat) or a list of
 * content blocks for multimodal input (text + images + documents). Image and
 * document blocks share the Anthropic base64 `source` shape; the sidecar
 * ai-sdk path converts `document` blocks to AI SDK `file` parts, and the
 * Anthropic path passes them through verbatim.
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
  | {
      type: "document"
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
  /**
   * Real HTTP status from the failing provider response, captured by the
   * sidecar (`extractHttpErrorMeta`) when the SDK error exposed it. Lets the
   * routing classifier + circuit breaker act on the true status instead of
   * string-matching `error`. Absent when the error carried no HTTP status.
   */
  httpStatus?: number
  /**
   * Real Retry-After delay (ms) parsed from the failing response header by the
   * sidecar. Feeds the breaker's dynamic cooldown; absent → the classifier
   * falls back to extracting a hint from the `error` text.
   */
  retryAfterMs?: number
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

/**
 * A pending `permission_request` whose sidecar waiter died before the user
 * answered (turn aborted, session closed, teardown drain). The SDK already
 * received a deny — this event exists so the renderer can mark the approval
 * `interrupted` (honest terminal) instead of silently dropping the dialog.
 */
export interface PermissionInterruptedEvent {
  type: "permission_interrupted"
  sessionId: string
  requestId: string
  reason: string
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

/**
 * Emitted by the sidecar's synthetic `cognia-plugin-tools` MCP server when the
 * model calls a renderer-proxied tool (plugin tool, ADR-0026 built-in skill, or
 * `terminal_dock_*`). The renderer executes it via `handlePluginToolExec` and
 * writes the result back through the `claude_plugin_tool_response` command.
 * Fans out on the same `claude://message` channel as every other ClaudeEvent.
 */
export interface PluginToolExecEvent {
  type: "plugin_tool_exec"
  sessionId: string
  toolUseId: string
  name: string
  args: Record<string, unknown>
}

export function isPluginToolExecEvent(evt: ClaudeEvent): evt is PluginToolExecEvent {
  return evt.type === "plugin_tool_exec"
}

export interface ProtocolAdapterCancelEvent {
  type: "protocol_adapter_cancel"
  sessionId: string
  execId: string
  reason?: string
}

export function isProtocolAdapterCancelEvent(evt: ClaudeEvent): evt is ProtocolAdapterCancelEvent {
  return evt.type === "protocol_adapter_cancel"
}

/**
 * Emitted by the ai-sdk dispatcher when `sendOptions.toolResultReviewEnabled`
 * is set: before a tool result is fed to the model, the sidecar pauses and asks
 * the renderer to review (and optionally rewrite) the output. The renderer
 * answers via the `claude_tool_result_decision` command. Mirrors the
 * `permission_request` round-trip but for tool OUTPUT (the plugin Agent SDK's
 * PostToolUse rewrite). ai-sdk channel only — native Anthropic tools execute
 * inside the SDK subprocess and are observe-only.
 */
export interface ToolResultReviewEvent {
  type: "tool_result_review"
  sessionId: string
  reviewId: string
  toolUseId: string
  toolName: string
  result: unknown
  isError: boolean
}

// ---- Live session introspection & control (Claude Agent SDK Query methods) --
// The renderer drives the SDK `Query`'s streaming-input-only control methods
// (`getContextUsage`, `mcpServerStatus`, `setModel`, …) through a request/
// response round-trip over the SAME `claude://message` channel: the renderer
// fires `claude_session_control` (fire-and-forget) and the sidecar replies with
// a `control_response` event correlated by `requestId`. Mirrors the
// `permission_request` / `plugin_tool_exec` round-trips. See `lib/claude/ipc.ts`.

/** Allowlisted SDK `Query` control methods reachable via `sessionControl`. */
export type SessionControlMethod =
  | "getContextUsage"
  | "mcpServerStatus"
  | "reconnectMcpServer"
  | "toggleMcpServer"
  | "supportedModels"
  | "supportedCommands"
  | "setModel"
  | "steer"

/**
 * Sidecar → renderer reply to a `sessionControl` request. `ok` distinguishes a
 * successful method call (`result` carries the SDK return value) from a failure
 * (`error` is a stable code: `no_active_session` | `unsupported_provider` |
 * `unknown_method` | a thrown message). Fans out on `claude://message`.
 */
export interface ControlResponseEvent {
  type: "control_response"
  sessionId: string
  requestId: string
  ok: boolean
  method: SessionControlMethod
  result?: unknown
  error?: string
}

export function isControlResponseEvent(evt: ClaudeEvent): evt is ControlResponseEvent {
  return evt.type === "control_response"
}

export type FeatureCallOperation =
  "language-generate" | "language-stream" | "embedding" | "bedrock-discover"

export interface FeatureCallCredentials {
  protocol?: string
  apiKey?: string
  baseURL?: string
  headers?: Record<string, string>
  apiFlavor?: "auto" | "responses" | "chat"
  bedrockAuthMode?: "api-key" | "iam" | "default-chain"
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  profile?: string
  roleArn?: string
  roleSessionName?: string
}

export interface FeatureCallRequest {
  requestId: string
  operation: FeatureCallOperation
  providerId?: string
  model?: string
  credentials: FeatureCallCredentials
  options?: Record<string, unknown>
}

export type FeatureCallEvent =
  | { type: "feature_call_result"; requestId: string; result: unknown }
  | { type: "feature_call_stream"; requestId: string; part: unknown }
  | { type: "feature_call_stream_end"; requestId: string }
  | { type: "feature_call_error"; requestId: string; error: string }
  | { type: "feature_call_aborted"; requestId: string }

export function isFeatureCallEvent(evt: ClaudeEvent): evt is FeatureCallEvent {
  return typeof evt?.type === "string" && evt.type.startsWith("feature_call_")
}

/**
 * Narrow mirror of the SDK's `SDKControlGetContextUsageResponse` (only the
 * fields the context indicator reads). The SDK knows the TRUE window size and a
 * per-category token breakdown the renderer's estimate can't compute.
 */
export interface SdkContextUsage {
  totalTokens: number
  maxTokens: number
  rawMaxTokens?: number
  percentage: number
  model?: string
  categories?: Array<{ name: string; tokens: number; color?: string; isDeferred?: boolean }>
  systemPromptSections?: Array<{ name: string; tokens: number }>
  systemTools?: Array<{ name: string; tokens: number }>
  mcpTools?: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>
  memoryFiles?: Array<{ path: string; type: string; tokens: number }>
  agents?: Array<{ agentType: string; source: string; tokens: number }>
  skills?: unknown
  slashCommands?: { totalCommands: number; includedCommands: number; tokens: number }
}

/** Narrow mirror of the SDK's `McpServerStatus` (live in-session client state). */
export interface SdkMcpServerStatus {
  name: string
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled"
  serverInfo?: { name: string; version: string }
  error?: string
  scope?: string
  tools?: Array<{ name: string; description?: string }>
}

/** Narrow mirror of the SDK's `ModelInfo` (account-authoritative model list). */
export interface SdkModelInfo {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: Array<"low" | "medium" | "high" | "xhigh" | "max">
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
  supportsAutoMode?: boolean
}

/** Narrow mirror of the SDK's `SlashCommand` (agent-facing command list). */
export interface SdkSlashCommand {
  name: string
  description: string
  argumentHint?: string
  aliases?: string[]
}

/**
 * Per-MCP-server diagnostic line emitted by the sidecar while it connects out
 * to user-configured MCP servers (connect success/failure, `tools()` failures,
 * captured child `stderr`). Mirror of `buildMcpLogEvent` in
 * `sidecar/dispatch/mcp-log.mjs`. `server` is absent when a line can't be
 * attributed to a named server. Consumed on the GUI side by the MCP log bridge
 * (`lib/mcp/log-bridge.ts`), which forwards each into the unified logger.
 */
export interface McpLogEvent {
  type: "mcp_log"
  sessionId: string
  ts: number
  level: "error" | "warn" | "info" | "debug"
  message: string
  source?: "stderr" | "diagnostic" | "status"
  server?: string
}

export function isMcpLogEvent(evt: ClaudeEvent): evt is McpLogEvent {
  return evt.type === "mcp_log"
}

export type ClaudeEvent =
  | ReadyEvent
  | SidecarExitedEvent
  | LogEvent
  | SessionEndedEvent
  | SdkSessionIdEvent
  | PermissionRequestEvent
  | PermissionInterruptedEvent
  | SDKEventEnvelope
  | UsageHeadersEvent
  | PluginToolExecEvent
  | ProtocolAdapterCancelEvent
  | ToolResultReviewEvent
  | ControlResponseEvent
  | FeatureCallEvent
  | McpLogEvent

// ---- Narrow subset of SDKMessage we care about ---------------------------
// Full type lives in @anthropic-ai/claude-agent-sdk. We mirror only the bits
// we need for rendering. Anything else is `unknown`.

export interface BetaTextBlock {
  type: "text"
  text: string
  citations?: unknown
  providerMetadata?: Record<string, Record<string, unknown>>
}

export interface BetaThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
  providerMetadata?: Record<string, Record<string, unknown>>
}

export interface BetaToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
  state?: "input-streaming" | "approval-requested"
  providerExecuted?: boolean
  providerMetadata?: Record<string, Record<string, unknown>>
  toolMetadata?: Record<string, unknown>
  dynamic?: boolean
  title?: string
  invalid?: boolean
  error?: unknown
  approval?: {
    id: string
    signature?: string
  }
}

export interface BetaToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | Array<{ type: "text"; text: string } | Record<string, unknown>>
  is_error?: boolean
}

export interface BetaFileBlock {
  type: "file"
  source?: {
    type: "base64"
    media_type: string
    data: string
  }
  url?: string
  media_type?: string
  filename?: string
}

export type BetaContentBlock =
  | BetaTextBlock
  | BetaThinkingBlock
  | BetaToolUseBlock
  | BetaToolResultBlock
  | BetaFileBlock
  | { type: string; [k: string]: unknown }

export interface BetaMessage {
  id: string
  role: "assistant" | "user"
  content: BetaContentBlock[]
  stop_reason?: string | null
  model?: string
  usage?: Record<string, unknown>
  metadata?: unknown
}

export interface SDKAssistantMessage {
  type: "assistant"
  message: BetaMessage
  parent_tool_use_id: string | null
  uuid: string
  session_id: string
  error?: string
  /** Subagent type that produced this message (set on SDK-native subagent frames). */
  subagent_type?: string
  /** Task description for the spawning Task tool, when known. */
  task_description?: string
}

export interface SDKUserMessage {
  type: "user"
  message: { role: "user"; content: BetaContentBlock[] | string }
  parent_tool_use_id: string | null
  uuid: string
  session_id: string
  /** Subagent type that produced this message (set on SDK-native subagent frames). */
  subagent_type?: string
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

/** SDK Task-subagent lifecycle frames (type: "system"). Authoritative source
 *  for SDK-native subagent start / progress / status used by the chat bridge. */
export interface SDKTaskStartedMessage {
  type: "system"
  subtype: "task_started"
  task_id: string
  tool_use_id?: string
  description: string
  subagent_type?: string
  task_type?: string
  prompt?: string
  skip_transcript?: boolean
  uuid: string
  session_id: string
}

export interface SDKTaskProgressMessage {
  type: "system"
  subtype: "task_progress"
  task_id: string
  tool_use_id?: string
  description: string
  subagent_type?: string
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
  last_tool_name?: string
  summary?: string
  uuid: string
  session_id: string
}

export interface SDKTaskUpdatedMessage {
  type: "system"
  subtype: "task_updated"
  task_id: string
  patch: {
    status?: "pending" | "running" | "completed" | "failed" | "killed" | "paused"
    description?: string
    error?: string
    is_backgrounded?: boolean
  }
  uuid: string
  session_id: string
}

export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskUpdatedMessage
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
 *   • `"subagent"` — a hidden, read-only session holding the full inner
 *     transcript of an imported Claude Code Task subagent (ADR-0062 fidelity
 *     upgrade). Filtered out of the ChannelList / search / companion-sync;
 *     reachable only by drilling in from the parent turn's `SubagentPart`.
 *     Carries no `branchSeed`, so it has no continuation path.
 */
export type SessionKind = "direct" | "team" | "workflow-editor" | "resource-workbench" | "subagent"

export type SessionVisibility = "standard" | "embedded"

export type SessionSurfaceBinding =
  | { kind: "canvas-document"; documentId: string }
  | { kind: "project-file"; projectId: string; rootId: string; relPath: string }
  | { kind: "artifact"; artifactId: string }
  | { kind: "workflow"; workflowId: string }

export interface ChatSession {
  id: string
  /**
   * Owning workspace (Project) id — Workspace isolation column (Dexie v86).
   * Stamped on create via `resolveScopeProjectId`; the v86 upgrade backfills
   * legacy rows from `Project.sessionIds[]`. Optional only for back-compat
   * with un-upgraded rows; production reads filter on it. See
   * `lib/db/project-scope.ts`.
   */
  projectId?: string
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
  /** Embedded sessions belong to a resource workbench, not the global conversation rail. */
  visibility?: SessionVisibility
  /** Typed resource identity for an embedded session; never contains resource content. */
  surfaceBinding?: SessionSurfaceBinding
  /** Direct sessions: the persona driving replies. */
  characterId?: string
  /** Team sessions: the team whose members reply. */
  teamId?: string
  /** Skills the user has temporarily disabled for this session only. */
  disabledSkillIds?: string[]
  /** Per-chat learned-memory recall override. */
  memoryUse?: boolean
  /** Per-chat automatic learned-memory write override. */
  memoryLearn?: boolean
  pinned?: boolean
  /**
   * Manual sort position within this session's ChannelList section — the
   * Pinned block, a date bucket, a folder, or the flat "recent" list
   * (ascending). Written by the ChannelList drag-reorder; `undefined` sorts by
   * recency after manually-ordered rows. The order is per-section: two rows in
   * different sections may share an index, only their relative order within one
   * section is meaningful. Non-indexed optional column — no Dexie schema bump.
   */
  manualOrder?: number
  /**
   * Section the manual order was dragged in (see `conversationSectionKey` in
   * `lib/chat/conversation-list-model.ts` — e.g. `"pinned"`, `"date:today"`,
   * `"folder:<id>"`, `"recent"`). The order is honored only inside that
   * section, so a session migrating to another date bucket falls back to
   * recency instead of dragging its old rank along. Absent on legacy rows
   * (pre-section-key orders apply wherever the row sits).
   */
  manualOrderSection?: string
  /**
   * Denormalized text preview of this session's most-recent message, written by
   * `persistMessages` (only when it changes) so the ChannelList can render a
   * second preview line without a per-row message query. Truncated (~120 chars).
   */
  lastMessagePreview?: string
  /** Epoch ms of the most-recent message, paired with {@link lastMessagePreview}. */
  lastMessageAt?: number
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
   * Per-session override of the always-on workspace confinement layer
   * (ADR-0028 "lite"). Precedence: session → character →
   * `AppSettings.workspaceConfinementEnabled` (default true). Set false to opt
   * this session out of confinement.
   */
  workspaceConfinementEnabled?: boolean
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
  /**
   * Conversation-branching lineage (ADR — conversation branching). Set when
   * this session was derived from another via `branchSessionAtMessage`
   * (`lib/chat/branch-session.ts`). Indexed in Dexie v80 so a session row can
   * cheaply find its children for the "branched from" indicator. Undefined on
   * non-branch sessions.
   */
  parentSessionId?: string
  /** The source message id (in the parent session) this branch was taken at. */
  branchedFromMessageId?: string
  /** How the branch was created: a verbatim copy or an LLM summary seed. */
  branchKind?: "direct" | "summary"
  /**
   * One-shot context seed for a freshly-branched session. Consumed by
   * `resolveSendOptions` on the first send (when there is no `sdkSessionId`
   * yet): injected as `appendSystemPrompt` so the new SDK conversation starts
   * with the pre-branch context, then cleared via `clearBranchSeed`. A
   * `transcript` seed carries the rendered pre-branch turns (mid-conversation
   * direct branch); a `summary` seed carries the LLM summary (summary branch).
   * Undefined once consumed, and on tail branches that use SDK fork instead.
   */
  branchSeed?: { kind: "transcript" | "summary"; content: string }
  /**
   * Imported-session ownership flag (ADR-0062 fidelity upgrade). An
   * `import:*` session is a live mirror of an external agent's on-disk history
   * until the user continues it in Cognia; the first continuation sets this
   * `true` (see the freeze-on-continue path in `hooks/chat/use-claude-chat.ts`).
   * Once frozen, the fs-watch re-import guard (`lib/data/import-merge.ts`)
   * skips the row entirely, so later source-side edits can't clobber the
   * continued conversation (they surface as a "diverged" badge instead).
   * Non-indexed optional column — no Dexie schema bump.
   */
  importFrozen?: boolean
  /**
   * Set to `"cli"` on a session materialised from a standalone-CLI handoff
   * (`lib/chat/import-handoff-session.ts`). Lets a repeat handoff of the *same*
   * CLI session overwrite its row in place (idempotent re-handoff), while an
   * incoming id that collides with a *native* desktop session is diverted to a
   * fresh id instead of clobbering it. Non-indexed optional column — no Dexie
   * schema bump.
   */
  handoffSource?: "cli"
  /** Per-session override for `--bare` (skip on-disk auto-discovery). */
  bareMode?: boolean
  /** Per-session override for `--debug` (verbose logging). */
  debugMode?: boolean
  /** Per-session override for cognia-next's brief-output mode. */
  briefMode?: boolean
  /** Per-session output-style override (see lib/claude/output-styles.ts). */
  outputStyle?: string
  /** Free-form instruction used when `outputStyle === "custom"`. */
  customOutputStyle?: string
  /** Per-session conversation-compaction overrides. Highest precedence. */
  compactionOverride?: SessionCompressionOverrides
  /**
   * Per-session extended-thinking budget. Highest precedence — wins over both
   * the character and the app default. `undefined` falls through.
   */
  maxThinkingTokens?: number
  /**
   * Per-session reasoning effort ("thinking level"). Highest precedence — wins
   * over the app default. Forwarded to the SDK as `output_config.effort` for
   * models that support it (Opus 4.5+, Sonnet 4.6, Fable 5). `undefined` falls
   * through to {@link AppSettings.defaultEffort}, then the model's own default.
   * Unlike `maxThinkingTokens`, effort does not disable partial-message
   * streaming, so streamed reasoning still renders.
   */
  effort?: SendOptions["effort"]
  /** Set when this session is bound to an external IM platform conversation. */
  platformBinding?: import("@/types/connectors/binding").PlatformBinding
  /**
   * Denormalized copy of `platformBinding.conversationKey`, indexed in Dexie
   * v85 so the connector runtime can enumerate every session bound to one IM
   * conversation (multi-session: `/new` / `/switch` / `/sessions`) in O(log n)
   * instead of a full-table scan. Kept in sync by `createPlatformSession`; the
   * v85 upgrade hook backfills it for legacy rows. Undefined on non-IM
   * (direct/team/workflow-editor) sessions.
   */
  platformConversationKey?: string
  /**
   * Per-session tool/MCP filter. Highest precedence — replaces the character
   * ({@link Character.toolFilter}) and global ({@link AppSettings.toolFilter})
   * filter for this conversation only. See {@link ToolFilterConfig}.
   */
  toolFilter?: ToolFilterConfig
  /**
   * Archive marker (conversation-list overhaul). Presence = archived; the
   * value is the archive timestamp. Non-indexed (no Dexie schema bump): the
   * conversation-list model filters on it in memory. Undefined = active.
   * Written by `archiveSession` / `unarchiveSession` (lib/db/sessions.ts).
   */
  archivedAt?: number
  /**
   * Lightweight folder membership (conversation-list overhaul). References a
   * {@link SessionFolder} id within the same workspace, or undefined = loose
   * (shown under date buckets). Non-indexed; the table lives in Dexie v90
   * (`sessionFolders`). Written by `assignSessionToFolder` (lib/db/sessions.ts).
   */
  folderId?: string
  createdAt: number
  updatedAt: number
}

/**
 * A user-defined folder for organizing conversations within a workspace
 * (conversation-list overhaul). Orthogonal to the workspace (Project) scope:
 * folders live inside a workspace and group its sessions. Persisted in the
 * Dexie `sessionFolders` table (v90) and managed via lib/db/session-folders.ts.
 */
export interface SessionFolder {
  id: string
  /** Owning workspace — scoped exactly like {@link ChatSession.projectId}. */
  projectId?: string
  name: string
  /** Manual sort position among sibling folders (ascending). */
  order: number
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
  /** Owning workspace id — Workspace isolation column (Dexie v86). Inherits the session's project. */
  projectId?: string
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
      /**
       * Adapter-instance + conversation scoping for edit/delete lookups.
       * Per-chat message ids (Telegram `message_id`, Slack `ts`) collide
       * across chats, and multi-bot setups collide across adapters — the
       * bus requires BOTH to match before rewriting a stored message.
       * Optional: rows written before the scoping fix carry neither and
       * fall back to the historical platform-only match.
       */
      adapterId?: string
      conversationKey?: string
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

/** Row density for the conversation sidebar (ChannelList). */
export type ConversationSidebarDensity = "comfortable" | "compact"
/** How far the conversation-sidebar search reaches. */
export type ConversationSearchScope = "title" | "titleAndContent"

/**
 * Behavior preferences for the conversation sidebar (ChannelList). All fields
 * optional; read sites derive the default with `?? <default>` so an absent
 * object (legacy settings) keeps today's behavior. Layout state (width, view,
 * collapsed folders) lives in `useUIStore`, not here.
 */
export interface ConversationSidebarSettings {
  /** Row density. Defaults to `"comfortable"`. */
  density?: ConversationSidebarDensity
  /** Show a second line with the last-message preview + relative time. Default off. */
  showPreview?: boolean
  /** Group non-search results into date buckets. Defaults to on. */
  groupByDate?: boolean
  /** Show per-conversation unread badges. Defaults to on. */
  showUnreadBadges?: boolean
  /** Whether search also matches message content (async). Defaults to title-only. */
  searchScope?: ConversationSearchScope
}

/**
 * Which metrics the chat run-status bar (`components/chat/run-panel.tsx` — the
 * "second clock" pinned above the composer) surfaces on its collapsed face. All
 * fields optional; read sites resolve defaults via
 * `lib/chat/run-bar-metrics.ts:resolveRunStatusBarSettings`, so an absent object
 * (legacy settings) keeps the sensible defaults there. Speed/tokens/cost derive
 * from the bound session's live `metadata.usage`; context% from the latest turn.
 */
export interface RunStatusBarSettings {
  /** Active-work elapsed clock (e.g. "12.3s"). Defaults to on. */
  showElapsed?: boolean
  /** Session output-token count (e.g. "1.2k tok"). Defaults to on. */
  showOutputTokens?: boolean
  /** Model throughput in tokens/second (e.g. "45 tok/s"). Defaults to on. */
  showSpeed?: boolean
  /** Session cost so far (e.g. "$0.03"). Defaults to off. */
  showCost?: boolean
  /** Latest-turn context-window fill (e.g. "context 38%"). Defaults to off. */
  showContextPct?: boolean
  /** Tool-call count of the turn (e.g. "3 tools"). Defaults to on. */
  showTools?: boolean
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

/**
 * Local-first user profile (no cloud account). Stored as a nested blob on the
 * `AppSettings` singleton so it rides the existing settings persistence,
 * companion sync (`CROSS_PLATFORM_SETTING_KEYS`) and WebDAV backup without a
 * Dexie schema bump. Every field is optional: an empty profile falls back to
 * the credential-derived identity (Anthropic email prefix + initials avatar)
 * in `lib/profile/use-user-profile.ts`.
 */
export interface UserProfile {
  /** Custom display name. Empty/undefined → credential-derived fallback. */
  displayName?: string
  /** Short bio / signature, editor-capped at 280 chars. */
  bio?: string
  /** Preferred pronouns (e.g. "she/her"), editor-capped at 32 chars. */
  pronouns?: string
  /** One-line "what I'm up to" status, editor-capped at 80 chars. */
  statusMessage?: string
  /**
   * Self-contained `data:` URL for the avatar, downscaled + size-capped
   * (≤96 KB) by `lib/profile/avatar-image.ts` BEFORE write — never store a
   * raw FileReader result here (settings row syncs to companions).
   */
  avatarDataUrl?: string
  /**
   * Preferred IANA timezone (e.g. "America/New_York"). Empty/undefined →
   * the device zone. Resolved everywhere via `resolveUserTimeZone()`
   * (`lib/profile/timezone.ts`); consumed by notification DND, pet/twin
   * proactive greetings, and as the default zone for goal/schedule pacing.
   */
  timezone?: string
  /** Epoch ms of the last profile edit. */
  updatedAt?: number
}

export const DEFAULT_USER_PROFILE: UserProfile = {}

/**
 * Ephemeral-TURN provider kinds (ADR-0021). `"none"` keeps the static
 * {@link AppSettings.turnServers} behaviour; the others mint short-lived
 * credentials from a third-party TURN-as-a-service the user configures.
 */
export type TurnProviderKind = "none" | "cloudflare-calls" | "twilio"

/**
 * Automatic ephemeral-TURN provider configuration. Only non-secret fields
 * live here (and in Dexie); the provider API token/secret is stored in the
 * OS keyring under {@link secretRef} (a `"kr:<keyId>"` sentinel).
 */
export interface TurnProviderConfig {
  kind: TurnProviderKind
  /** Requested credential TTL in seconds. Clamped to 600..86400. Default 86400. */
  ttlSeconds?: number
  /** Cloudflare Calls TURN Key ID (non-secret — safe in Dexie). */
  cloudflareKeyId?: string
  /** Twilio Account SID (non-secret — safe in Dexie). */
  twilioAccountSid?: string
  /** Keyring sentinel `"kr:<keyId>"` for the provider secret; absent when `kind === "none"`. */
  secretRef?: string
}

/** Default provider config — off (static TURN list only). */
export const DEFAULT_TURN_PROVIDER: TurnProviderConfig = { kind: "none" }

/**
 * ADR-0028 — sandbox resource + network **ceiling** for OS-sandboxed tool
 * calls. Enforced in `cognia-sandboxed-tools` before the call reaches the
 * Rust `sandbox_exec` dispatcher (the model can only reach the sandbox via
 * that plugin, so the clamp can't be bypassed). A per-character policy beats
 * the app default; an unset field falls through to the backend's own default.
 */
export interface SandboxResourcePolicy {
  /** Max CPU-seconds the model may request (0 / undefined = backend default). */
  maxCpuSeconds?: number
  /** Max memory MB the model may request (0 / undefined = backend default). */
  maxMemoryMb?: number
  /**
   * Network **ceiling** the model cannot exceed. `"off"` forces every
   * sandboxed shell offline regardless of what the model asks; `"allowlist"`
   * caps egress to `networkAllowlist` (a model `"on"` is downgraded to the
   * allowlist); `"on"` / undefined honours the model's per-call choice.
   */
  network?: "off" | "on" | "allowlist"
  /** Hosts allowed when `network` is `"allowlist"`. */
  networkAllowlist?: string[]
  /**
   * Absolute directories a sandboxed write may be confined to — the writable
   * **ceiling**. When non-empty, every model-supplied writable / target path
   * is narrowed to those under one of these roots (paths outside are denied).
   * Empty / undefined = no ceiling (the always-on backend floor still rejects
   * system + app-data roots). The model can only ever narrow.
   */
  writableRoots?: string[]
  /**
   * Extra read-only roots available to native Computer Use bash/text_editor
   * confinement. Sandboxed write tools keep their model-supplied readable set;
   * this field exists so native Computer Use gets the same configured ceiling
   * context that `cognia-sandboxed-tools` receives.
   */
  readableRoots?: string[]
}

export interface UpdateSettings {
  /** Check on launch and keep checking while the desktop app is running. */
  autoCheck: boolean
  /** Period between automatic checks. Clamped to 15 minutes–7 days at runtime. */
  checkIntervalMinutes: number
  /** Fetch the signed update package in the background after discovering it. */
  autoDownload: boolean
  /** Relaunch immediately after installation instead of waiting for the user. */
  relaunchAfterInstall: boolean
  /** Timeout applied to update manifest and package requests. */
  requestTimeoutSeconds: number
  /** Reuse the active global network proxy for update requests. */
  useProxy: boolean
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  autoCheck: true,
  checkIntervalMinutes: 6 * 60,
  autoDownload: false,
  relaunchAfterInstall: true,
  requestTimeoutSeconds: 30,
  useProxy: true,
}

export interface AppSettings {
  id: "singleton"
  /** Opt-in local Chromium-cookie import for the embedded desktop browser. */
  browserCookieImportEnabled?: boolean
  /**
   * Experimental Cloud/headless shared browser. The server hard gate and
   * runtime health gate must also pass; this local preference alone never
   * advertises or provisions a remote browser.
   */
  remoteBrowserEnabled?: boolean
  /**
   * Epoch ms of the last write, bumped by `lib/db/settings.ts:saveSettings`.
   * Drives the companion sync cursor for the settings singleton: the desktop
   * sync source emits the row only when `updatedAt` postdates the phone's
   * cursor, so settings changes propagate to paired phones (pre-v61 the row
   * had no `updatedAt` and only ever synced once, on the first pull).
   */
  updatedAt?: number
  /**
   * Local user profile (editable display name / avatar / bio). Merged forward
   * by `lib/db/settings.ts:getSettings()`; synced to companion devices via
   * the `CROSS_PLATFORM_SETTING_KEYS` allowlist.
   */
  profile?: UserProfile
  /**
   * OCR subsystem preferences (default provider, cloud fallback, per-provider
   * config, cache TTL, platform overrides, wizard dismissal). Merged forward
   * by `lib/db/settings.ts:getSettings()` so older installs pick up new
   * defaults without a schema migration. Defaults to `DEFAULT_OCR_SETTINGS`
   * from `lib/ocr/types.ts`.
   */
  ocrSettings?: import("@/types/ocr").UserOcrSettings
  /**
   * Local-storage retention policy. `traceRetentionDays` bounds how long agent
   * trace spans (`agentTraces`, an otherwise unbounded table) are kept before
   * the boot-time sweeper in `lib/storage/retention.ts` prunes them. `0` means
   * "keep forever". Merged forward by `lib/db/settings.ts:getSettings()`.
   */
  storageRetention?: { traceRetentionDays: number }
  /**
   * Source Control feature preferences (AI commit-message generation, …).
   * Merged forward by `lib/db/settings.ts:getSettings()` from
   * `DEFAULT_GIT_SETTINGS` in `types/git`, so older installs pick up new
   * defaults without a schema migration.
   */
  gitSettings?: import("@/types/git").GitUiSettings
  /**
   * Nested-subagent dispatch settings (depth-N). Opt-in: when `enabled`, the
   * built-in chat agent is offered the `dispatch_agent` tool and dispatched
   * subagents that opt into nesting may themselves dispatch, up to `maxDepth`.
   * Undefined ≡ disabled (default `maxDepth: 2`). Merged forward by
   * `getSettings()` so older installs pick up the default without a migration.
   */
  subagentNesting?: {
    /** Master switch. Default false → zero behaviour change (SDK Task, depth 1). */
    enabled: boolean
    /** Max nesting level below the top-level chat. Default 2 (parent→child→grandchild). */
    maxDepth: number
    /** Per-subtree token budget; 0 = unlimited (refuse new dispatch at 95%). */
    tokenBudget?: number
    /** Per-subtree wall-clock timeout in ms; 0 = none. */
    timeoutMs?: number
    /**
     * Bounded retries for TRANSIENT dispatch failures (rate-limit / timeout /
     * network / server-error / sidecar-exited). Default 1; 0 disables. Each
     * retry re-checks abort, the subtree deadline, and the token budget.
     */
    dispatchMaxRetries?: number
  }
  /**
   * Background subagent-run lifecycle. Merged forward by `getSettings()` so
   * older installs pick up the defaults without a migration.
   */
  backgroundTasks?: {
    /**
     * Opt-in (default false): on boot, automatically re-dispatch background
     * runs that were interrupted by the crash/quit (this boot's interruptions
     * only, capped by `maxAutoResumeAttempts` per lineage).
     */
    autoResumeInterrupted?: boolean
    /** Cap on chained auto-resume attempts per run lineage. Default 2. */
    maxAutoResumeAttempts?: number
  }
  /**
   * Dispatched-subagent permissioning. Merged forward by `getSettings()`.
   */
  /**
   * First-class web tools (web_search + web_fetch). Promoted out of the
   * optional `web-tools` plugin: always available to the agent (renderer +
   * CLI host), ungated by the pluginTools toggle. Undefined ≡ enabled.
   * Merged forward by `getSettings()` so older installs pick up the default.
   */
  webTools?: {
    /** Expose web_search / web_fetch to the agent. Default true. */
    enabled: boolean
    /**
     * Opt-in (default false): on the Anthropic (Agent SDK) path, use the SDK's
     * built-in WebSearch / WebFetch — server-side extraction + citations,
     * Anthropic's own token budget — instead of the custom multi-provider,
     * host-routed web tools. Ignored for non-Anthropic providers, where the
     * native tools aren't available and the custom ones are always used.
     */
    nativeOnAnthropic?: boolean
    /**
     * Opt-in (default false): allow `web_fetch` to reach private / loopback /
     * link-local hosts (localhost, 10./192.168., 169.254.x cloud metadata, …).
     * Off by default — the SSRF guard blocks them so a model-supplied URL can't
     * probe the user's internal network. Enable only for trusted local dev.
     */
    allowPrivateHosts?: boolean
    /**
     * Opt-in (default false): always run fetched page text through the cheap
     * utility model before returning it, even when the model didn't pass a
     * `prompt`. Narrows the prompt-injection surface (Claude-Code-style: the
     * main agent never sees raw page text). No-op on hosts without a usable
     * utility model.
     */
    alwaysDistill?: boolean
  }
  /**
   * Agent self-invocation tools (Claude Code parity). Opt-in (default off):
   * let the model call the `Skill` tool to load a skill's instructions, and/or
   * the `SlashCommand` tool to run a registered slash command. Host-routed
   * (renderer + CLI). Undefined ≡ both off.
   */
  selfInvokeTools?: {
    /** Expose the `Skill` tool to the agent. Default false. */
    skill?: boolean
    /** Expose the `SlashCommand` tool to the agent. Default false. */
    slashCommand?: boolean
    /**
     * Expose the team-collaboration tools (`team_send_message`,
     * `team_publish_memory`, `team_request_consensus`, `team_delegate`, …) to a
     * teammate during a team dispatch turn. Only takes effect on team sessions.
     * Default false.
     */
    teamCollaboration?: boolean
  }
  /**
   * Desktop → cognia CLI storage sync (ADR: CLI ↔ APP storage unification).
   * When `autoSync` is on, the desktop pushes its agent config + provider
   * credentials into the CLI home (`~/.cognia/*`) on settings save, so the
   * standalone `cognia-agent` CLI runs with the same setup without a second
   * login. Default OFF (the push writes secrets to a 0600 file). MCP server
   * projection rides the separate per-server agent-sync chips. No-op off the
   * Tauri desktop shell. See `lib/cli-bridge/push-to-cli.ts`.
   */
  cliBridge?: {
    /** Auto-push config + credentials to the CLI home on settings save. Default false. */
    autoSync?: boolean
  }
  /**
   * Desktop self-update preferences. `autoCheck` drives the boot-time (and
   * periodic) background update check in `UpdateCheckInitializer`; the manual
   * Settings → About check is always available regardless. Undefined ≡ on.
   * Merged forward by `getSettings()` so older installs pick up the default
   * without a migration. No-op off the Tauri desktop shell.
   */
  updates?: UpdateSettings
  /**
   * Mobile runtime mode (ADR: standalone BYOK mobile). Decides whether the
   * Capacitor shell drives a paired desktop ("paired") or runs chat / search /
   * documents standalone in-webview against the user's own provider keys
   * ("standalone"). `undefined` ≡ not yet chosen → the mobile onboarding shows
   * the mode chooser. Device-local: deliberately excluded from the
   * `CROSS_PLATFORM_SETTING_KEYS` sync allowlist (a phone's mode is its own).
   * No-op off the Capacitor shell. See `lib/runtime/standalone-mode.ts`.
   */
  mobileRuntimeMode?: "paired" | "standalone"
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
   * Plugin security posture. `balanced` (default, ≡ undefined) keeps the
   * historical behaviour: declared dangerous permissions prompt for consent,
   * and a plugin that declared no `networkAccess.allowedDomains` keeps
   * unrestricted egress. `strict` additionally denies egress for any plugin
   * that did not declare an allowlist. Read by the plugin permission/egress
   * gates via `lib/plugin/security/security-posture.ts`.
   */
  pluginSecurityPosture?: "strict" | "balanced"
  /**
   * App-wide default for the SDK's extended-thinking budget. `undefined` or
   * `0` keeps thinking off. Overridden per-character (`Character.maxThinkingTokens`)
   * and per-session (`ChatSession.maxThinkingTokens`).
   */
  defaultMaxThinkingTokens?: number
  /**
   * App-wide default reasoning effort ("thinking level"), forwarded to the SDK
   * as `output_config.effort`. Overridden per-session (`ChatSession.effort`).
   * `undefined` leaves the model at its own default effort.
   */
  defaultEffort?: SendOptions["effort"]
  /** App-wide default for `--bare` (skip on-disk auto-discovery). Overridden by character + session. */
  bareMode?: boolean
  /** App-wide default for `--debug` (verbose logging). Overridden by character + session. */
  debugMode?: boolean
  /** App-wide default for cognia-next's brief-output mode. Overridden by character + session. */
  briefMode?: boolean
  /**
   * Token-level streaming for interactive chat. When on (default), the sidecar
   * sets the SDK's `includePartialMessages` so assistant text renders
   * incrementally (`stream_event` deltas) instead of one whole-message update.
   * Only applies to interactive sends — connector / nested-dispatch / headless
   * paths never request partials (they consume the final result). Off → the
   * legacy whole-message behaviour.
   */
  streamPartialMessages?: boolean
  /** App-wide default output style. Overridden by character + session. */
  outputStyle?: string
  /** Free-form instruction used when `outputStyle === "custom"`. */
  customOutputStyle?: string
  /**
   * App-wide conversation-compaction settings (auto threshold, keep-recent,
   * active strategy, compact instructions). Stored as a partial — absent keys
   * fall back to {@link DEFAULT_COMPRESSION_SETTINGS} / the sidecar defaults.
   * Overridden per character and per session. See `types/system/compression.ts`.
   */
  compaction?: Partial<CompressionSettings>
  /**
   * App-wide config for loading on-disk project instruction files
   * (CLAUDE.md / AGENTS.md / AGENT.md, nested + `@import`) into the system
   * prompt, plus `.cognia/agents/*.md` subagent discovery. Overridden per
   * character via `Character.instructionsOverride`. Undefined → built-in
   * defaults (enabled, layered). See `lib/claude/instructions/`.
   */
  instructions?: import("@/lib/claude/instructions/types").InstructionsConfig
  /**
   * Auto-generate a conversation title from the first turn using a
   * configurable background model. `enabled` defaults to true; the instant
   * first-message truncation always runs as a placeholder regardless. See
   * `lib/ai/generation/title.ts` and the chat hook's turn-complete path.
   */
  conversationTitle?: UtilityModelConfig
  /**
   * Attention Radar — periodic AI "info-diet" analysis over recent memories +
   * captured items, surfaced in the pet console. See `lib/radar/` and
   * `types/radar`. Absent → defaults (disabled). Off by default.
   */
  attentionRadar?: import("@/types/radar").RadarSettings
  /**
   * Content capture (confirm-bubble flow) — clipboard watching + save +
   * enrichment; captured items feed the Attention Radar. See `lib/capture/`
   * and `types/capture`. Absent → defaults (disabled). Desktop-only.
   */
  capture?: import("@/types/capture").CaptureSettings
  /**
   * LLM input assistance for the main chat composer: prompt enhancement
   * (rewrite / variants), inline ghost-text autocomplete, and AI starter /
   * follow-up suggestions. Renderer-side via `buildUtilityLlmClient`, gated
   * by `hasNoLeakingPii`. Optional override (absent → built-in defaults).
   * See `lib/chat/completion/*` and `components/chat/composer/*`.
   */
  composerAssistance?: {
    /** Prompt enhancement (Wand) action. Defaults ON — click-only, no idle cost. */
    enhance?: { enabled?: boolean }
    /** Inline ghost-text continuation as you type. Defaults OFF — opt-in. */
    ghostText?: {
      enabled?: boolean
      /** Debounce before querying, ms. Default 500. Clamped [200, 2000]. */
      debounceMs?: number
    }
    /** AI starter prompts (empty state) + follow-up suggestions (post-reply). */
    suggestions?: {
      /** AI starter prompt cards on the empty state. Default ON. */
      starters?: boolean
      /** Follow-up suggestion chips after an assistant reply. Default ON. */
      followUps?: boolean
    }
    /** Per-feature provider/model override for all three assistance calls. */
    model?: UtilityModelConfig
  }
  /**
   * Non-LLM composer / send-box behavior toggles. Every field defaults to the
   * historical hard-coded behavior (treated as `true` via `!== false`), so an
   * absent block leaves existing users unchanged. Read renderer-side in
   * `components/chat/composer.tsx` and `components/chat/message-list.tsx`.
   */
  composerBehavior?: {
    /** Render the message composer as a compact, vertically stacked control surface. Default false. */
    compactLayout?: boolean
    /**
     * Plain Enter submits (default). When false, Enter inserts a newline and
     * ⌘/Ctrl+Enter submits instead. Wired in the composer `onKeyDown`.
     */
    sendOnEnter?: boolean
    /** Clear the composer (text + attachments) after a successful send. Default true. */
    clearAfterSend?: boolean
    /**
     * Stick-to-bottom auto-scroll while a turn is streaming (when already at
     * the bottom). Default true. Wired in the message-list scroll effect.
     */
    autoScrollOnStream?: boolean
    /**
     * ↑/↓ from the start of an empty composer recalls previously sent messages.
     * Default true. When false the arrows fall through to native caret movement.
     */
    inputHistoryRecall?: boolean
    /** Persist unsent drafts per session in Dexie and restore on session switch. Default true. */
    persistDrafts?: boolean
  }
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
    /**
     * Per-TOOL permission rules (multi-tool generalization of
     * `commandRules`): `tool name → { input-glob → allow|ask|deny }`.
     * Merged with the Bash-wrapped commandRules into
     * {@link SendOptions.permissionRuleset} by `build-options.ts`; resolved
     * identically on both dispatch paths. Tool keys may be bare core-tool
     * names (`bash`, `edit`), SDK names (`Bash`), namespaced MCP forms, or
     * globs (`mcp__github__*`).
     */
    toolRules?: import("@/lib/claude/permissions/ruleset").Ruleset
    /**
     * Where a dispatched subagent's permission asks go. `"surface"` (default)
     * re-buckets them into the parent chat session (Claude Code parity);
     * `"auto-deny"` restores the legacy fail-closed silent deny.
     */
    subagentAsks?: "surface" | "auto-deny"
    /**
     * Dispatch allowlist/denylist over PROJECTED subagent ids (`Explore`,
     * `myplugin:reviewer`, `template:*`). Glob→verdict, last-match-wins via the
     * shared ruleset machinery; denied ids never enter the `dispatch_agent`
     * enum and are refused fail-closed at dispatch time. `ask` is reserved and
     * treated as `allow` in v1. Default allow when unset.
     */
    subagentRules?: import("@/lib/claude/permissions/ruleset").ToolRules
  }
  /** Right-edge conversation-timeline minimap preferences. */
  conversationTimeline?: ConversationTimelineSettings
  /** Conversation sidebar (ChannelList) behavior preferences. */
  conversationSidebar?: ConversationSidebarSettings
  /** Which metrics the chat run-status bar surfaces (speed, tokens, cost, …). */
  runStatusBar?: RunStatusBarSettings
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
    /**
     * Pre-selected propagation targets. `CcswitchAgentId` is the modeled
     * `AgentId` union plus `"opencode"` (an OpenCode-CLI write target that
     * isn't one of cognia's modeled agents). See `types/ccswitch/switch.ts`.
     */
    defaultPropagation: import("@/types/ccswitch").CcswitchAgentId[]
    /**
     * Optional manual cc-switch data-dir override (a directory containing
     * `cc-switch.db`). When set, it takes priority over cc-switch's own
     * redirect store (but below the `CC_SWITCH_HOME` env var). Blank/undefined
     * falls through to the normal resolution chain.
     */
    manualDataDir?: string
  }
  /**
   * Claude subscription settings — drives the Settings → Subscription →
   * Claude probe-loop preferences. The credentials themselves live in the
   * OS keyring (Tauri-only); only cadence + threshold preferences are
   * stored here. See ADR-0025 and
   * `lib/subscription/core/types.ts:AnthropicSubscriptionSettings`.
   */
  subscriptionSettings?: import("@/types/subscription").AnthropicSubscriptionSettings
  /**
   * Codex (OpenAI) subscription preferences — discovery fallback + refresh
   * cadence. Credentials live in the OS keyring; only renderer-side toggles
   * are stored here. See ADR-0025 and
   * `lib/subscription/core/types.ts:CodexSubscriptionSettings`.
   */
  codexSubscriptionSettings?: import("@/types/subscription").CodexSubscriptionSettings
  /**
   * User-defined limits/usage sources for arbitrary coding-plan / relay
   * providers (Settings → Subscription → Custom sources). Each is a
   * self-contained descriptor carrying its own baseUrl + token, run by the
   * custom limits runner and surfaced alongside the vault accounts. NOTE: the
   * token is stored here in the renderer settings store (not the OS keyring),
   * mirroring the CLI's plaintext provider tokens — the UI surfaces a caveat.
   */
  customLimitsSources?: import("@/types/subscription").CustomLimitsSource[]
  /**
   * Account-scoped opt-ins for outbound quota/balance requests. Keys are
   * produced by `limitsQueryAccountKey(provider, accountId)`; missing means no
   * vault account may be queried automatically.
   */
  limitsQueryEnabledAccounts?: string[]
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
  /** Compatibility alias for behaviorTelemetry.enabled. */
  telemetryEnabled?: boolean
  /** Host-neutral behavior-event consent, routing, sampling, and local retention policy. */
  behaviorTelemetry?: {
    enabled: boolean
    destinations: { local: boolean; remote: boolean }
    categories: {
      chat: boolean
      workflow: boolean
      connector: boolean
      agentTeam: boolean
      system: boolean
    }
    sampleRate: number
    retentionDays: number
    maxStoredEvents: number
  }
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
     * ADR-0028 Phase 3 (P4.1) — launch dock terminals under the OS sandbox
     * (`bwrap` / `sandbox-exec`): writes confined to the session `cwd`,
     * `$HOME` read-only, network egress on. Off by default; Windows rejects
     * a sandboxed spawn until the restricted-token runner lands. Experimental.
     */
    sandboxed?: boolean
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
    /** Width in CSS pixels when `cursorStyle` is `bar`. Defaults to 1. */
    cursorWidth?: number
    /** Cursor shape when the terminal is not focused. Defaults to `outline`. */
    cursorInactiveStyle?: "outline" | "block" | "bar" | "underline" | "none"
    /**
     * Whether the cursor blinks. Defaults to true (matches the xterm.js
     * `cursorBlink` default we set in `terminal-instance.tsx`).
     */
    cursorBlink?: boolean
    /**
     * Line height as a multiplier of the font size (xterm `lineHeight`).
     * Defaults to 1.0. Values > 1 add vertical breathing room between rows;
     * changing it re-fits the terminal (the cell size shifts).
     */
    lineHeight?: number
    /**
     * Extra horizontal spacing between glyphs in pixels (xterm `letterSpacing`).
     * Defaults to 0. Small positive values improve legibility for dense mono
     * fonts; changing it re-fits the terminal.
     */
    letterSpacing?: number
    /**
     * Font weight for normal (non-bold) text (xterm `fontWeight`). Defaults to
     * `"normal"`. Accepts CSS keywords or the 100–900 numeric-string scale.
     */
    fontWeight?:
      "normal" | "bold" | "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900"
    /**
     * Font weight used for bold text (xterm `fontWeightBold`). Defaults to
     * `"bold"`. Same accepted values as {@link fontWeight}.
     */
    fontWeightBold?:
      "normal" | "bold" | "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900"
    /**
     * Enable programming-font ligatures via `@xterm/addon-ligatures`. Off by
     * default — the addon shapes glyph runs at render time, a small cost only
     * worth paying for fonts that ship ligatures (Cascadia Code, JetBrains
     * Mono, Fira Code). Toggling remounts the terminal.
     */
    fontLigatures?: boolean
    /**
     * Draw xterm's built-in box, block, braille, Powerline, progress, git, and
     * legacy-computing glyphs instead of relying on the configured font. This
     * keeps adjoining strokes continuous under non-default line height and
     * letter spacing. Accelerated renderers only; defaults to true.
     */
    customGlyphs?: boolean
    /**
     * Horizontally fit ambiguous-width single-cell glyphs that would otherwise
     * overlap the following cell. Matches VS Code's enabled default and
     * improves GB18030 rendering; ignored by xterm's DOM renderer.
     */
    rescaleOverlappingGlyphs?: boolean
    /** Map bold ANSI colors to their bright variants. Defaults to true. */
    drawBoldTextInBrightColors?: boolean
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
     * Mouse-wheel scroll speed — number of lines scrolled per wheel notch
     * (xterm `scrollSensitivity`). Defaults to 1. `fastScrollSensitivity`
     * (Alt-scroll) is derived as 5× this value.
     */
    scrollSensitivity?: number
    /**
     * Animate terminal buffer scrolling. Maps to xterm's 125 ms smooth-scroll
     * duration when enabled, matching VS Code; defaults to false.
     */
    smoothScrolling?: boolean
    /**
     * Minimum WCAG contrast ratio the renderer enforces between glyph and
     * background by lightening/darkening the foreground (xterm
     * `minimumContrastRatio`). `1` (default) disables it; `4.5` = WCAG AA,
     * `7` = AAA, `21` = maximum (forces black/white). Improves legibility of
     * low-contrast ANSI color output.
     */
    minimumContrastRatio?: number
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
      /**
       * File/directory path completion for the token under the cursor,
       * resolved against the session cwd (OSC 633 P). Desktop only — the
       * provider degrades to nothing in web mode. Default true.
       */
      path?: boolean
      /**
       * PATH-executable + shell-builtin completion for the head word.
       * The PATH scan is desktop only; static builtins work everywhere.
       * Default true.
       */
      exe?: boolean
      /**
       * Declarative subcommand/flag completion for common CLIs (git, npm,
       * cargo, docker, …) from the in-repo spec set. Default true.
       */
      spec?: boolean
      /**
       * Persist executed commands to Dexie (cross-session history-based
       * suggestions). Lines that fail the PII gate are never persisted.
       * Default true; the in-memory ring keeps working when off.
       */
      persistHistory?: boolean
      /**
       * The multi-candidate popup (Ctrl+Space / second Tab). Off → ghost
       * text only. Default true.
       */
      popup?: boolean
    }
    /**
     * Master switch for *unattended* terminal execution: workflow terminal
     * nodes (and, later, agent tools) running shell commands headlessly —
     * no visible dock tab, no per-command consent prompt. The
     * `classifyCommand` safety verdict replaces the human gate: `allow`
     * runs, `deny` is always blocked, `ask` follows
     * `unattendedAskPolicy`. Off by default — fail closed.
     */
    allowUnattendedExecution?: boolean
    /**
     * What an unattended execution does when the safety classifier returns
     * an `ask` verdict:
     *  - `"fail"` (default) — the step fails with the classifier's reason.
     *  - `"consent"` — fall back to the visible-dock consent path.
     *  - `"run"` — run anyway (explicit trust-my-workflow opt-in).
     */
    unattendedAskPolicy?: "fail" | "consent" | "run"
    /**
     * How the terminal surfaces the BEL character (`\x07`). `"none"`
     * (default) ignores it; `"visual"` flashes the terminal container;
     * `"sound"` plays a short WebAudio beep; `"both"` does both. Wired via
     * xterm's `onBell` in `terminal-instance.tsx`.
     */
    bell?: "none" | "visual" | "sound" | "both"
    /**
     * Terminal quick fixes (VS Code parity). When a finished command matches a
     * built-in matcher (`lib/terminal/quick-fix/`), a lightbulb at the command's
     * gutter offers a fix — `git push --set-upstream`, "did you mean", create-PR
     * link, free a busy port, pwsh command-not-found, … Default true.
     */
    quickFixes?: boolean
    /**
     * Make the per-command gutter decorations interactive: hovering/clicking a
     * command dot opens a menu (Rerun, Copy command, Copy output, Copy command +
     * output) with the exit code + duration. Default true.
     */
    commandActions?: boolean
    /**
     * Sticky scroll — pin the currently-scrolled-past command's prompt line at
     * the top of the viewport while reading its output. Default true.
     */
    stickyScroll?: boolean
    /**
     * Ask for confirmation before closing a terminal tab whose shell is still
     * running a command (status `"running"`). Guards against losing an
     * in-flight command to an accidental × click. Default true — matches VS
     * Code's `terminal.integrated.confirmOnKill`. Idle / exited tabs close
     * immediately regardless.
     */
    confirmOnClose?: boolean
  }
  /** BCP-47 language tag for the composer's voice-input controls. */
  sttLanguage?: string
  /** `MediaDeviceInfo.deviceId` of the user's last-picked microphone. */
  selectedMicId?: string
  /**
   * Optional Vercel OIDC token for the skills.sh `/api/v1` endpoints.
   * Unlocks the leaderboard views (all-time / trending / hot) and curated
   * collections in the Browse tab. Anonymous search, install, and security
   * audits work without it. Short-lived (12h when pulled locally), so it is
   * stored as a plain setting rather than in the keyring.
   */
  skillsShToken?: string
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
   * User-customizable Skills panel preferences (display density, list/grid
   * view, per-row field visibility, default tab/sort/status filter, and the
   * `autoEnableNew` / `enabledWarnThreshold` injection hints). All fields are
   * optional; defaults are applied at read time by `resolveSkillPanelPrefs`
   * (`lib/skills/preferences.ts`), so existing installs pick up new options
   * without a Dexie migration — same pattern as `skillBundleMirrors`. The
   * shape is typed structurally here (rather than importing
   * `PartialSkillPanelPrefs`) so `types.ts` stays free of any store/lib import
   * cycle.
   */
  skillPanelPrefs?: {
    density?: "comfortable" | "compact"
    viewMode?: "list" | "grid"
    showDescription?: boolean
    showTags?: boolean
    showSource?: boolean
    showUsage?: boolean
    defaultTab?: "my-skills" | "browse" | "editor" | "analytics"
    defaultSort?: "name" | "updated" | "usage"
    defaultStatusFilter?: SkillStatus | "all"
    rememberLastView?: boolean
    autoEnableNew?: boolean
    enabledWarnThreshold?: number
  }
  /**
   * Last Skills panel view snapshot (tab + sort + non-query filters). Written
   * only when `skillPanelPrefs.rememberLastView` is on, and re-seeded into the
   * ephemeral skills store on the next mount. Lives in settings JSON so the
   * ephemeral store stays free of persistence middleware.
   */
  lastSkillView?: {
    tab?: "my-skills" | "browse" | "editor" | "analytics"
    sort?: "name" | "updated" | "usage"
    category?: SkillCategory | "all"
    source?: SkillSource | "all"
    status?: SkillStatus | "all"
    tag?: string | null
  }
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
   * Global defaults for the `/discover` page. Lives in settings JSON (same
   * pattern as `discoverViewByCategory` / `discoverFavorites`) so it syncs
   * cross-device without a Dexie migration. Edited from
   * `/settings?section=discover`.
   *
   *  - `landingCategory`: the category (or the `favorites` pseudo-category) the
   *    page opens on when `?category=` is absent. Falls back to the first
   *    visible category when unset, invalid, or currently hidden.
   *  - `view`: the fallback view mode (`grid` | `list` | `compact`) applied to
   *    categories that have no explicit per-category override in
   *    `discoverViewByCategory`.
   */
  discoverDefaults?: {
    landingCategory?: string
    view?: import("@/lib/discover/categories").DiscoverViewMode
  }
  /**
   * Execution Monitor view preferences ("围观设置") — hidden kinds, row sort,
   * group-by-kind, and the live-elapsed toggle for the "what is running right
   * now" panel. Lives in settings JSON (same pattern as `discoverDefaults`) so
   * the chosen view follows the user across devices without a Dexie migration.
   * See `@/lib/execution/monitor-prefs` for the model + defaults.
   */
  executionMonitorPrefs?: import("@/lib/execution/monitor-prefs").StoredExecutionMonitorPrefs
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
   * Persisted preferences for the `/goals` console (ADR-0019 Phase 3): the
   * default landing tab and the open-goals default sort. Lives in settings
   * JSON (same pattern as `goalConsoleView` / `executionMonitorPrefs`) so it
   * follows the user across devices without a Dexie migration. Partial — unset
   * fields fall back to `DEFAULT_GOAL_CONSOLE_PREFS`.
   */
  goalConsolePrefs?: import("@/lib/goal/console-prefs").StoredGoalConsolePrefs
  /**
   * Unified Notification Center preferences (ADR-0042): global default
   * channels, per-source overrides, OS/push level gates, DND/quiet-hours,
   * retention, snooze, and connector focus-awareness. Lives in settings JSON
   * (same pattern as `goalConsoleView`) so it syncs cross-device without a
   * Dexie migration. The notification *records* live in the `notifications`
   * table (v68); only these preferences ride on the settings singleton.
   * See `@/types/notifications` for the model + `DEFAULT_NOTIFICATION_PREFERENCES`.
   */
  notificationPreferences?: import("@/types/notifications").NotificationPreferences
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
   *    "Try a prompt" starters, the flag keeps it hidden across reloads.
   *    (Stale `quickStart` flags from before the capability grid was removed
   *    are ignored.)
   */
  userName?: string
  welcomeStyle?: "rich" | "minimal"
  welcomeHidden?: { tryPrompt?: boolean }
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
   * Collapsed group ids in the settings sidebar (`/settings`). Lives in
   * settings JSON (same pattern as `mcpPanel` / `goalConsoleView`) so the
   * collapse state follows the user across devices without a Dexie migration.
   * Absent / empty = all groups expanded. Unknown ids are ignored on read.
   */
  settingsSidebarCollapsedGroups?: string[]
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
    | "openai-realtime"
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

  /** OpenAI Realtime TTS settings (desktop-only streaming). */
  realtimeVoice?: string
  realtimeModel?: string
  realtimeInstructions?: string

  /** Common TTS controls. */
  ttsEnabled?: boolean
  ttsRate?: number
  ttsPitch?: number
  ttsVolume?: number
  ttsAutoPlay?: boolean
  ttsCacheEnabled?: boolean
  ttsStreamingEnabled?: boolean
  /** Fall back to the system voice when a cloud provider fails. */
  ttsFallbackEnabled?: boolean

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
  /**
   * Max EXTRA attempts per provider on a transient failure (network / 429 / 5xx)
   * before falling through to the next provider. 0 disables retry. Default 2.
   */
  searchMaxRetries?: number
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
    /**
     * When not `false` (default on), AI revisions to an existing artifact are
     * staged as a pending diff proposal for per-hunk review instead of
     * overwriting the artifact directly.
     */
    reviewBeforeApply?: boolean
  }

  // ---- Agent evaluation ----
  /**
   * Project-level Agent-Eval defaults (judge model, default k / scorers,
   * new-dataset gate template, cost guard). Consumed by the run-config dialog
   * and `createDataset`; see {@link import("@/types/eval/settings").EvalSettings}.
   */
  evalSettings?: import("@/types/eval/settings").EvalSettings

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
  colorTheme?: import("@/types/plugin/plugin").ColorThemePreset
  /** User-defined custom theme palettes (UI colors, not export tokens). */
  customThemes?: import("@/types/plugin/plugin").CustomTheme[]
  /** Currently active custom theme id; null when a preset is in use. */
  activeCustomThemeId?: string | null
  /**
   * Registry id (`<pluginId>.<contributionId>`) of a directly-activated
   * plugin theme, or null. Mutually exclusive with `activeCustomThemeId`:
   * activating one clears the other. Applied live by `PluginThemeApplier`
   * via a `<style data-plugin-theme>` block; falls back to the preset when
   * the owning plugin is disabled.
   */
  activePluginThemeId?: string | null
  /**
   * Standalone accent color override (hex or oklch). Retints primary / accent
   * / ring on top of the active preset or custom theme without opening the
   * full custom-theme editor. Null / undefined uses the theme's own accents.
   */
  accentColor?: string | null

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
   * App-wide default for the always-on **workspace confinement** layer
   * (ADR-0028 "lite"). When true (the default), the sidecar built-in file/bash
   * tools are confined to the active workspace roots: out-of-root mutator calls
   * escalate to approval and credential paths hard-deny. Cross-platform (incl.
   * native Windows) and complementary to `sandboxDefaultEnabled` — the heavy OS
   * sandbox, when active, takes over and this layer steps aside. Beaten by
   * `Character.workspaceConfinementEnabled` / `ChatSession.workspaceConfinementEnabled`.
   * Read by `resolveSendOptions`.
   */
  workspaceConfinementEnabled?: boolean
  /**
   * Confine code executed from the Canvas panel (Python especially) through
   * the OS sandbox. Independent of `sandboxDefaultEnabled` (which gates chat
   * Bash/Edit/Write): defaults to **true** so model-authored Canvas code is
   * confined out of the box, while leaving a deliberate per-user opt-out for
   * trusted machines or platforms without a sandbox backend. Read by
   * `hooks/canvas/use-code-execution.ts`.
   */
  canvasCodeSandboxEnabled?: boolean
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
   * App-wide sandbox resource + network ceiling (ADR-0028). Beaten by
   * `Character.sandboxPolicy`. Only consulted when the sandbox is enabled.
   */
  sandboxPolicy?: SandboxResourcePolicy
  /**
   * Cache-friendly prompt assembly (experimental, default off). When true,
   * `resolveSendOptions` re-layers the prompt so per-turn dynamic sections
   * (memory recall, twin retrieved chunks, goal / plan / workflow state)
   * land at the END of the appended prompt, keeping the leading prefix
   * byte-stable across turns to maximize provider prompt-cache hits
   * (DeepSeek context caching on disk, OpenAI automatic caching, Anthropic
   * cache_control). When false/undefined the legacy assembly is used,
   * byte-identical to previous releases.
   */
  cacheOptimizationEnabled?: boolean
  /**
   * Auto-activate the built-in, surface-specific guidance skills (IM auto-reply
   * etiquette, computer-use safety, workflow authoring, agent-team delegation,
   * digital-twin grounding, goal/loop execution). When the turn runs on a
   * matching surface, `resolveSendOptions` appends the relevant SKILL.md body to
   * the system prompt (see lib/skills/surface-activation.ts). Defaults to ON
   * (undefined ⇒ enabled); set false to suppress all surface auto-activation.
   */
  surfaceSkillsEnabled?: boolean
  /**
   * Plan-mode capture defaults (ADR-0045). Applied by `captureExitPlanMode`
   * when an ExitPlanMode tool call materialises a draft `AgentPlan`:
   * - `requireApproval` — gate execution behind the approval dock (default
   *   true). False lands the capture `approved` and the dock auto-resumes the
   *   implementing turn once (idempotent via a metadata stamp).
   * - `maxAutoRefinements` — cap on automatic repair replans per plan.
   * - `interactiveHtmlView` — opt-in enhanced plan mode: render the approval
   *   card body as an interactive HTML editor (sandboxed iframe with drag
   *   reorder / inline edit / add / remove steps) instead of the static list.
   * - `interactiveHtmlStyle` — built-in visual preset for the interactive
   *   editor (mirrors `lib/agent/plan/plan-html.ts:PLAN_HTML_STYLES`).
   */
  planSettings?: {
    requireApproval?: boolean
    maxAutoRefinements?: number
    interactiveHtmlView?: boolean
    interactiveHtmlStyle?: "default" | "compact" | "timeline" | "cards"
  }
  /**
   * Per-provider configuration. Stores the full `UserProviderSettings`
   * shape (api key, base URL, model list, key rotation, OAuth state,
   * health metrics) used by the providers settings UI. The lean
   * `ProviderSettingsEntry` consumed by the plugin/embedding resolver is
   * derived via `lib/ai/providers/provider-persistence:toProviderSettingsEntry`.
   */
  providerSettings?: Record<string, import("@cognia/provider-types/provider").UserProviderSettings>
  /**
   * User-defined custom AI providers (self-hosted, proxies). Stored as the
   * extended `CustomProviderSettings` so the providers UI can edit
   * per-model metadata. The resolver-facing `CustomProviderDefinition[]`
   * is derived via `provider-persistence:customSettingsToDefinitions`.
   */
  customProviders?: import("@cognia/provider-types/provider").CustomProviderSettings[]
  /** Per-(provider:model) usage entries powering the cost tab. */
  providerUsageStats?: Record<
    string,
    import("@cognia/provider-types/provider").ProviderModelUsageEntry[]
  >
  /** UI preferences for the providers settings page (filter, sort, view mode). */
  providerUIPreferences?: import("@cognia/provider-types/provider").ProviderUIPreferences
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
   * Opt-in semantic pruning of the exposed plugin-tool manifest (default
   * OFF). When enabled and more plugin tools than `activationToolCount`
   * are exposed, `resolveSendOptions` keeps only the top-K semantic
   * matches for the current prompt plus pinned tools. Built-in tools are
   * never pruned. See `lib/ai/routing/semantic-tool-router.ts`.
   */
  semanticToolRouting?: import("@/types/routing/tool-route").SemanticToolRoutingSettings
  /**
   * Opt-in heuristic strong/weak difficulty routing (default OFF) — a
   * registered routing strategy (`"difficulty"`) usable as the routing
   * strategy or per-request override once a model pair is configured.
   */
  difficultyRouting?: import("@/types/routing/tool-route").DifficultyRoutingSettings
  /**
   * Opt-in automatic tier routing (default OFF). When enabled,
   * `resolveSendOptions` scores each non-alias prompt's difficulty and rewrites
   * the model to one of `candidateAliases`, resolved by the existing alias
   * engine. Strict no-op until opted in and until matching aliases exist in
   * `modelMappings`. See `lib/routing/auto-tier.ts`.
   */
  autoRouting?: import("@/types/routing/tool-route").AutoRoutingSettings
  /**
   * When true, on a `session_ended.error` for a turn that resolved via an
   * alias with non-empty `aliasResolution.fallbackEntries`, the renderer
   * adapter automatically retries with the next entry. Default true.
   * Set false for debugging — keeps the original error visible instead of
   * masking it with the fallback's outcome.
   */
  routingFallbackEnabled?: boolean
  /**
   * Routing-preset activation state: custom presets, the active preset id,
   * and the pre-activation snapshot that powers one-click revert. See
   * `@/types/provider/routing-presets` and the routing settings tab.
   */
  routingPresets?: import("@cognia/provider-types/routing-presets").RoutingPresetsState

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
  /** Agent invocation-flow display mode (simplified / standard / detailed). */
  agentFlowMode?: import("@/types/appearance").AgentFlowSettings
  /** Usage / consumption statistics display mode (simplified / standard / detailed). */
  usageDisplayMode?: import("@/types/appearance").UsageDisplaySettings
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
   * (`WEBDAV_PASSWORD_REF`); the zero-knowledge sync passphrase is
   * session-only by default (`lib/webdav/passphrase-cache.ts`) and is
   * persisted to the keyring (`WEBDAV_PASSPHRASE_REF`) only when the user
   * opts into {@link rememberPassphrase}.
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
    /**
     * Opt-in: persist the sync passphrase in the OS keyring so scheduled
     * uploads and the remote-newer check run unattended across restarts.
     * Default off → memory-only. Only this boolean lives here; the secret
     * itself never touches Dexie. Shared by the data-backup passphrase and
     * the subscription-vault passphrase (identical threat model).
     */
    rememberPassphrase?: boolean
    /**
     * Subscription-vault cloud sync (ADR-0025 follow-up 2026-06-07): mirror
     * the encrypted subscription package (`cogniabak-subscription-v1`) to the
     * same WebDAV server, CC-Switch-style. Server connection fields above are
     * shared; this toggle + stamps are subscription-specific. The package is
     * keyed by its own passphrase (session cache + opt-in keyring at
     * `lib/subscription/sync/passphrase-cache.ts`).
     */
    subscriptionSyncEnabled?: boolean
    /** ISO timestamp of the last successful subscription-vault upload. */
    subscriptionLastSyncAt?: string
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
  /**
   * Optional automatic ephemeral-TURN provider (ADR-0021). When
   * `kind !== "none"`, the desktop and mobile each mint short-lived TURN
   * credentials from the configured provider (Cloudflare Calls / Twilio)
   * and rotate them before expiry, instead of relying on the static
   * {@link turnServers} list. The provider API secret lives in the OS
   * keyring (referenced by {@link TurnProviderConfig.secretRef}), never
   * in Dexie. Defaults to {@link DEFAULT_TURN_PROVIDER} (`kind: "none"`).
   */
  turnProvider?: TurnProviderConfig

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
   * Auto-lock the active local account after this many minutes of inactivity
   * (Tauri-only — local accounts don't exist off desktop). `0` or `undefined`
   * disables auto-lock; the account stays unlocked until a manual lock or app
   * exit. Drives `use-auto-lock-on-idle`, which calls the account store's
   * `lock()` on timeout.
   */
  accountAutoLockMinutes?: number

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
   * Unified Language Server configuration (ADR — unified LSP). Single
   * source of truth feeding BOTH the agent runtime LSP (via
   * `sendOptions.lsp`, resolved in `lib/claude/build-options.ts`) and the
   * editor LSP registry (`lib/plugin/lsp/*`). Builtin defaults
   * (`lib/lsp/builtin-defaults.ts`) are layered under `servers` here and
   * under any project-local `.cognia/lsp.json` by
   * `lib/lsp/resolve-config.ts`.
   *
   * Stored in the settings singleton (no dedicated Dexie table). Migrated
   * from the former `developer.userLspServers` /
   * `developer.unsignedLspAllowed` fields.
   */
  lsp?: LspSettings

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
   * Experimental task-scoped isolated workspace and reversible resource
   * ledger. Default off until the full runtime matrix reaches GA.
   */
  taskWorkspace?: boolean

  /**
   * Experimental: when `true`, registered plugin chat-middlewares actually run
   * on the send hot path (ADR-0026 §4 §A). Default off — the runner skips
   * `runChatMiddlewareChain` entirely. Rehydrated into the module-level flag
   * (`lib/claude/chat-middleware/feature-flag.ts`) at boot by
   * `ChatMiddlewareFlagInitializer`.
   */
  chatMiddlewareExecution?: boolean

  /**
   * When `true`, the VS Code LSP binary policy
   * @deprecated Migrated to `AppSettings.lsp.unsignedAllowed` by
   * `lib/lsp/migrate-settings.ts`. Read only during the one-time
   * migration; cleared afterwards. Kept on the type so the migration can
   * still see legacy values.
   */
  unsignedLspAllowed?: boolean

  /**
   * @deprecated Migrated to `AppSettings.lsp.servers` by
   * `lib/lsp/migrate-settings.ts`. Read only during the one-time
   * migration; cleared afterwards.
   */
  userLspServers?: UserLspServerEntry[]
}

/**
 * One user-authored Language Server entry. Now an alias of the unified
 * {@link LspServerConfig} (`@/types/lsp/config`) so the shape lives in one
 * place — the former inline copy diverged from the editor's
 * `PluginLspServerDef` and the agent's hard-coded registry.
 */
export type UserLspServerEntry = LspServerConfig

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
  /**
   * ADR-0056 (decision D4) — re-prompt biometric before a remote write that
   * ESCALATES the paired desktop's `permissionMode` toward a more autonomous
   * mode (acceptEdits / bypassPermissions / dontAsk / auto) from the phone's
   * `/me/agent` page. Optional for back-compat; treated as `true` (gated) when
   * absent, since escalation is the security-sensitive direction.
   */
  escalatePermissionMode?: boolean
}

export const DEFAULT_BIOMETRIC_GUARD: BiometricGuardPolicy = {
  deletePairing: true,
  exportBackup: false,
  revealSecrets: false,
  signOut: true,
  escalatePermissionMode: true,
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
  | "zed"
  | "kiro"
  | "opencode"
  | "cognia"

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
  /**
   * Approval lifecycle. Absent/"pending" = live (answerable). "interrupted" =
   * the sidecar waiter died (turn aborted / session closed) and the tool was
   * already denied — the entry stays so the UI can show an honest notice with
   * a Dismiss action instead of silently dropping the dialog.
   */
  status?: "pending" | "interrupted"
  /** Why the approval was interrupted (sidecar-provided reason). */
  interruptReason?: string
  /** Stamped by the store when the request arrives (feeds attention sorting). */
  requestedAt?: number
  /**
   * Where this ask originated. `"subagent"` = a dispatched subagent whose
   * ephemeral session was re-bucketed into the parent chat; drives the
   * "Asked by <subagent>" header + the Cancel-run affordance in the dialog.
   * `sessionId` stays the ephemeral id (what `approveTool` needs).
   */
  origin?: "subagent"
  /** Display id of the asking subagent (origin "subagent"). */
  subagentId?: string
  /** Runtime-store run id of the asking subagent (Cancel-run target). */
  subagentRunId?: string
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
   * Per-character override of the always-on workspace confinement layer
   * (ADR-0028 "lite"). Beats `AppSettings.workspaceConfinementEnabled` but
   * loses to `ChatSession.workspaceConfinementEnabled`.
   */
  workspaceConfinementEnabled?: boolean
  /**
   * Sandbox tier (ADR-0028 T4). `"os"` (default) routes Bash / Edit / Write
   * through the per-platform OS sandbox (sandbox-exec / bwrap / windows-codex).
   * `"microvm"` routes them through the existing `plugins/e2b-sandbox/`
   * Firecracker workspace backend for the strongest isolation. Only relevant
   * when `sandboxEnabled` resolves true.
   */
  sandboxTier?: "os" | "microvm"
  /**
   * Per-character sandbox resource + network ceiling (ADR-0028). Beats
   * `AppSettings.sandboxPolicy`. Only relevant when `sandboxEnabled` is true.
   */
  sandboxPolicy?: SandboxResourcePolicy
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
  /** Per-character default output style (see lib/claude/output-styles.ts). */
  outputStyle?: string
  /** Free-form instruction used when `outputStyle === "custom"`. */
  customOutputStyle?: string
  /** Per-character conversation-compaction overrides. Beats the app default. */
  compactionOverride?: SessionCompressionOverrides
  /**
   * Per-character override for project instruction-file loading. Beats the
   * app default (`AppSettings.instructions`) wholesale when set. See
   * `lib/claude/instructions/`.
   */
  instructionsOverride?: import("@/lib/claude/instructions/types").InstructionsConfig
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
    enableQueryExpansion?: boolean
    enableCorrectiveFilter?: boolean
    correctiveMinKeep?: number
    enableCitations?: boolean
    citationStyle?: import("@/types/twin").TwinCitationStyle
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
   * Gate for the agent browser tools (`cognia-browser-tools`, ADR-0055) that
   * drive the embedded preview webview (navigate / snapshot / click / type /
   * console / network). Opt-in: only `true` surfaces the `browser_*` tools.
   * Mirrors the `enableComputerUse` soft-binding convention.
   */
  enableBrowserTools?: boolean
  /**
   * Gate for the OCR agent tool (`ocr.extract`, ADR-0024). Unlike Computer
   * Use, OCR is low-risk and defaults to **enabled** — only an explicit
   * `false` removes the `cognia-ocr` tool from the send (and the IM safeguard
   * `ConversationOverrideRow.allowOcr` likewise only blocks when explicitly
   * false). Mirrors the `enableComputerUse` soft-binding convention.
   */
  enableOcr?: boolean
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
  enableBrowserTools?: boolean
  enableOcr?: boolean
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
  /**
   * Content hash of the marketplace snapshot this skill was installed from.
   * Either the skills.sh `/api/v1` hash or a `sha256:`-prefixed client-side
   * hash of the downloaded file set. Compared like-for-like by the explicit
   * "Check for updates" action; distinct from `syncFingerprint` (native sync).
   */
  marketplaceHash?: string
  /** Path of the matching `~/.claude/skills/<dir>/` if synced to disk. */
  nativeDirectory?: string
  /** Which source last wrote this record. */
  syncOrigin?: SkillSyncOrigin
  /** Hash of (frontmatter + body + resources) used to detect drift. */
  syncFingerprint?: string
  lastSyncedAt?: number
  /** Most recent sync failure, cleared on successful sync. */
  lastSyncError?: string | null
  /**
   * Skill body kind (D5). "markdown" (default) is a prose playbook appended to
   * the system prompt. "workflow" is a graph-bodied skill: only its
   * name+description are injected (progressive disclosure) and a tool is
   * registered that runs the referenced workflow, returning typed output.
   */
  kind?: "markdown" | "workflow"
  /** For kind:"workflow" — the published workflow this skill runs. */
  workflowId?: string
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
