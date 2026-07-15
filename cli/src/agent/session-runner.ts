/**
 * Persistent multi-turn agent session — the core behind the interactive TUI.
 *
 * Unlike `runHeadlessTurn` (bootstrap → one turn → shutdown), this bootstraps
 * the sidecar ONCE and keeps it alive, so every `send()` reuses the same
 * `sessionId`. The sidecar keeps that SDK session open (it `pushUserMessage`s
 * follow-ups), so context accumulates in-process across turns — exactly the
 * desktop chat behaviour, reused unchanged.
 *
 * Collaborators are injected so the multi-turn orchestration unit-tests without
 * a live sidecar or model.
 */

import os from "node:os"

import {
  resolveSendOptions as defaultResolveSendOptions,
  type BuildOptionsContext,
} from "@/lib/claude/build-options"
import {
  runAndCaptureAssistantReply as defaultCapture,
  type RunAndCaptureResult,
  type CaptureStreamEvent,
} from "@/lib/claude/run-and-capture"
import { setSessionMode as defaultSetSessionMode } from "@/lib/claude/ipc"
import type { SendOptions } from "@cognia/agent-config-types"

/** A concrete permission mode value (excludes `undefined`). */
type PermissionModeValue = NonNullable<SendOptions["permissionMode"]>

import type { McpServer } from "@cognia/agent-config-types"

import { buildAttachmentContent, type BuiltAttachmentContent } from "./attachments/build"
import { resolveHome } from "../config/load"
import { type ResolvedConfig } from "../config/schema"
import { toBuildContext } from "../config/to-build-context"
import { loadMcpServers } from "../mcp/load-mcp-config"
import { applyDisabled, readDisabled, readDisabledTools } from "../mcp/mcp-state"
import { readEnabled } from "../skill/skill-state"
import { bootstrapSidecar, type SidecarBootstrap } from "../runtime/bootstrap"
import { ensureCliDb, CliDbSnapshotError } from "../db/bootstrap"
import { ensurePluginRuntime } from "../plugin/plugin-runtime"
import { resolveDevPluginsDir } from "../plugin/dev-plugins"
import { subscribePluginToolDispatch } from "../plugin/plugin-tool-dispatch"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { mintSessionId } from "./run"
import { type PermissionResponder } from "./permission-gate"
import { fetchTwinContext as defaultFetchTwinContext } from "../twin/context-client"
import { readToolApprovals } from "./tool-approvals"
import { appendTranscript, type TranscriptFs } from "./transcript"
import {
  CLI_AUTO_APPROVED_TOOLS,
  withCliAutoApprovedTools,
  withCliDisabledMcpTools,
} from "./tool-suppression"
import {
  applySubagentModelOverrides,
  discoverDispatchableAgents,
  type AgentSummary,
} from "./discover-agents"
import { withBuiltinAgents } from "./builtin-agents"
import { discoverCustomAgentModes, resolveAgentMode as selectAgentMode } from "../config/agent-mode"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import {
  buildCliSubagentToolManifest,
  clearCliSubagentContext,
  makeCliPluginToolHandle,
  registerCliSubagentContext,
} from "./subagent-dispatch"
import { buildLoadSkillManifestEntry, type LoadableSkill } from "./skill-load-tool"

// Re-exported from `./tool-suppression` so existing
// `import { … } from "./session-runner"` call sites (and tests) stay unchanged.
export { CLI_AUTO_APPROVED_TOOLS, withCliAutoApprovedTools, withCliDisabledMcpTools }

export interface AgentSessionParams {
  config: ResolvedConfig
  sessionId?: string
  /**
   * Session kind forwarded to `toBuildContext`. Defaults to `"direct"`. Set to
   * `"workflow-editor"` (with a `sessionId` shaped `workflow:<id>`) to run the
   * desktop Workflow Copilot agent — `resolveSendOptions` then swaps the prompt
   * + `wf_*` tool whitelist and injects the live editor-store snapshot.
   */
  sessionKind?: import("@cognia/agent-config-types").SessionKind
  home?: string
  bootstrap?: (cwd: string) => Promise<SidecarBootstrap>
  resolveOptions?: (ctx: BuildOptionsContext) => Promise<SendOptions>
  capture?: typeof defaultCapture
  transcriptFs?: TranscriptFs
  /** Assemble multimodal content from a typed prompt — encode `@image` refs,
   * inject text/rich-doc content, and resolve `@*.pdf` per the active model.
   * Defaults to {@link buildAttachmentContent}; injected in tests. */
  buildContent?: (
    prompt: string,
    cwd: string
  ) => BuiltAttachmentContent | Promise<BuiltAttachmentContent>
  /** Resolve the MCP servers to expose. Defaults to loading `.mcp.json` from
   * the cwd + home, applying the `/mcp disable` overlay. */
  resolveMcpServers?: () => McpServer[]
  /** Resolve the session-enabled skill ids. Defaults to the `/skill` state file. */
  resolveSkillIds?: () => string[]
  /** Resolve metadata (id/name/description) for the enabled skills, to build the
   * `load_skill` tool's catalog when `skillLoadMode === "name"`. Defaults to a
   * CLI-local Dexie read; injected in tests. Best-effort — a failure yields a
   * generic (still functional) tool. */
  resolveLoadableSkills?: (ids: string[]) => Promise<LoadableSkill[]>
  /** Resolve the per-tool MCP disable overlay (namespaced `mcp__server__tool`
   * names) to union into `disallowedTools`. Defaults to the `mcp-state.json`
   * store; injected in tests. */
  resolveDisabledMcpTools?: () => Set<string>
  /** Open the CLI-local Dexie (installs the `window` + IndexedDB shims that
   * `getDb()` requires) before resolving options. Only invoked when at least
   * one skill is enabled, since that is the lone build-options read the CLI's
   * `toBuildContext` can route through Dexie. Defaults to {@link ensureCliDb};
   * injected in tests. */
  ensureDb?: () => Promise<unknown>
  /** Resolve the user's persisted "Allow always" tool names. Defaults to the
   * `tool-approvals.json` store; injected in tests. */
  resolveApprovedTools?: () => Set<string>
  /** Bootstrap the in-tree plugin runtime (only when `config.pluginTools`).
   * Defaults to {@link ensurePluginRuntime}; injected as a no-op in tests. */
  loadPluginRuntime?: () => Promise<unknown>
  /** Subscribe the `plugin_tool_exec` executor after the sidecar is live (when
   * plugin/web tools are on, or subagents are available so the `dispatch_agent`
   * tool can resolve). Defaults to {@link subscribePluginToolDispatch} with the
   * CLI subagent-aware handle. */
  subscribePluginTools?: () => Promise<UnlistenFn>
  /** Discover the dispatchable `.cognia/agents/*.md` subagents for this session.
   * Seeds the `dispatch_agent` (Task) tool the model uses to launch a subagent
   * on the non-Anthropic (ai-sdk) channel — that channel has no SDK-native Task
   * tool, so without this the model cannot delegate. Defaults to scanning the
   * cwd + home roots; injected in tests. */
  resolveAgents?: () => Promise<AgentSummary[]>
  /** Resolve the active agent mode (built-in or `.cognia/modes/*.json` custom)
   * for this session. The resolved {@link AgentModeConfig} is threaded into
   * `toBuildContext` so the shared `resolveSendOptions` applies its system-prompt
   * append, tool allow-list, model override, and permission ruleset — exactly as
   * the desktop does. Defaults to resolving `config.agentMode` against the modes
   * discovered under the cwd + home roots; injected in tests. */
  resolveAgentMode?: () => Promise<AgentModeConfig | null>
  /** Send the `claude_set_mode` control message to mutate the LIVE session's
   * permission mode without respawning the sidecar. Defaults to the ipc
   * {@link defaultSetSessionMode}; injected in tests. */
  setSessionMode?: (sessionId: string, mode: PermissionModeValue) => Promise<void>
  /** Fetch the twin context from the running desktop (only when `config.twin`
   * is enabled). Resolves `null` on any failure — the turn then proceeds
   * without twin grounding. Injected in tests. */
  fetchTwin?: typeof defaultFetchTwinContext
  now?: () => number
}

/** What the attachment builder did with this turn's `@<path>` references. */
export interface AttachmentSummary {
  /** Images encoded as native blocks. */
  imageCount: number
  /** PDFs sent as native document blocks. */
  documentCount: number
  /** Refs whose extracted text was folded into the prompt. */
  injectedFiles: string[]
  /** Refs that went through OCR (a subset of `injectedFiles`). */
  ocr: string[]
  /** Refs that could not be read/extracted. */
  failed: string[]
  /** `@refs` with an unknown/binary extension — left literal. */
  skipped: string[]
}

export interface SendTurnOptions {
  gate: PermissionResponder
  onEvent?: (event: CaptureStreamEvent) => void
  /** Fired once per session, on the first turn that loads session-enabled
   * skills, with the skill ids that resolved into the prompt. Lets the UI show
   * the user which skills are active. Not fired for plain (skill-less) chat. */
  onActiveSkills?: (skillIds: string[]) => void
  /** Fired once per turn when the prompt referenced one or more `@<path>`
   * attachments, summarising how each was handled. Lets the UI show a notice. */
  onAttachments?: (summary: AttachmentSummary) => void
  /** Fired at most once per session when twin grounding is enabled but the
   * desktop bridge is unreachable — the turn proceeds without twin context. */
  onTwinNotice?: (message: string) => void
  /** Fired at most once per session when the CLI-local db could not be opened
   * because its snapshot was corrupt or schema-incompatible. The snapshot has
   * been moved aside (see {@link CliDbSnapshotError.preservedPath}) and the turn
   * proceeds without skills. Unlike a transient open failure this MUST reach the
   * user: their sessions/goals/memory are intact on disk, but nothing else says
   * so, and an unannounced empty db reads as silent data loss. */
  onDatabaseError?: (error: CliDbSnapshotError) => void
  signal?: AbortSignal
  timeoutMs?: number
}

export interface AgentSession {
  readonly sessionId: string
  send(prompt: string, opts: SendTurnOptions): Promise<RunAndCaptureResult>
  /** Drop the cached SendOptions so the next `send` re-resolves them — used
   * after `/mcp`, `/skill`, or `/plugin` toggle a server/skill mid-session.
   * Optional so lightweight test doubles need not implement it. */
  invalidateOptions?(): void
  /** Mutate the live session's permission mode in place (no respawn), so the
   * in-process conversation is preserved across a Shift+Tab / plan-approval
   * mode switch. A no-op before the sidecar has spawned — the mode then folds
   * into the first `startSession`. Optional for lightweight test doubles. */
  setPermissionMode?(mode: PermissionModeValue): Promise<void>
  /** True once the sidecar has spawned (≥1 `send` happened) — i.e. there is a
   * live session the sidecar knows by `sessionId`, so a manual `/compact` can
   * target it. Optional so lightweight test doubles need not implement it. */
  isLive?(): boolean
  close(): Promise<void>
}

/**
 * Create a persistent agent session. Lazy: the sidecar spawns + options resolve
 * on the first `send`. Subsequent sends reuse both.
 */
export function createAgentSession(params: AgentSessionParams): AgentSession {
  const now = params.now ?? Date.now
  const sessionId = params.sessionId ?? mintSessionId(now())
  const home = params.home ?? resolveHome(process.env, os.homedir())
  const resolveOptions = params.resolveOptions ?? defaultResolveSendOptions
  const capture = params.capture ?? defaultCapture
  const bootstrap =
    params.bootstrap ?? ((cwd: string) => bootstrapSidecar({ cwd, env: process.env }))
  const resolveMcpServers =
    params.resolveMcpServers ??
    (() => {
      const roots = [params.config.cwd, home]
      return applyDisabled(loadMcpServers(roots), readDisabled(home))
    })
  const resolveSkillIds = params.resolveSkillIds ?? (() => [...readEnabled(home)])
  const skillLoadMode = params.config.skillLoadMode ?? "name"
  const resolveLoadableSkills =
    params.resolveLoadableSkills ??
    (async (ids: string[]): Promise<LoadableSkill[]> => {
      // Read the enabled skills' metadata from the CLI-local Dexie (already
      // opened when skills are enabled) so the load tool advertises the catalog.
      const { listEnabledSkillsByIds } = await import("@/lib/db/skills")
      const rows = await listEnabledSkillsByIds(ids)
      return rows.map((s) => ({ id: s.id, name: s.name, description: s.description }))
    })
  const resolveDisabledMcpTools = params.resolveDisabledMcpTools ?? (() => readDisabledTools(home))
  const ensureDb = params.ensureDb ?? (() => ensureCliDb())
  const resolveApprovedTools = params.resolveApprovedTools ?? (() => readToolApprovals(home))
  // Dev plugins imply the plugin runtime (they ride the same manifest path). The
  // repo `plugins/` dir is resolved once and threaded into the runtime bootstrap.
  const devPluginsEnabled = params.config.devPlugins === true
  const pluginToolsEnabled = params.config.pluginTools === true || devPluginsEnabled
  const devPluginsDir = devPluginsEnabled
    ? (resolveDevPluginsDir(params.config.devPluginsDir, params.config.cwd) ?? undefined)
    : undefined
  const loadPluginRuntime =
    params.loadPluginRuntime ?? (() => ensurePluginRuntime({ devPluginsDir }))
  const subscribePluginTools =
    params.subscribePluginTools ??
    (() => subscribePluginToolDispatch({ handle: makeCliPluginToolHandle() }))
  const resolveAgents =
    params.resolveAgents ??
    (async () =>
      applySubagentModelOverrides(
        withBuiltinAgents(await discoverDispatchableAgents([params.config.cwd, home])),
        params.config.subagentModels
      ))
  const resolveAgentMode =
    params.resolveAgentMode ??
    (async () =>
      selectAgentMode(
        params.config.agentMode,
        await discoverCustomAgentModes([params.config.cwd, home])
      ) ?? null)
  const setSessionMode = params.setSessionMode ?? defaultSetSessionMode
  // The default builder needs the per-send resolved provider/model, so it is
  // invoked inside `send` (not bound here). Only the test override is captured.
  const buildContentOverride = params.buildContent

  let boot: SidecarBootstrap | null = null
  let options: SendOptions | null = null
  let pluginUnsub: UnlistenFn | null = null
  let closed = false
  // Discovered dispatchable subagents (`.cognia/agents/*.md`) — resolved once
  // with the options. Drives the `dispatch_agent` tool surfaced below and the
  // per-turn dispatch context the tool's handler reads.
  let agents: AgentSummary[] = []
  // True when the `dispatch_agent` (Task) plugin tool was surfaced this session
  // (non-Anthropic provider + ≥1 subagent). Forces the plugin-tool executor to
  // subscribe even when plugin/web tools are otherwise off, so the model's
  // `dispatch_agent` call round-trips back to {@link handleCliDispatchAgent}.
  let subagentToolEnabled = false
  // The skill ids that resolved into the prompt (≤ once-resolved, since options
  // are cached). Surfaced to the UI via `onActiveSkills` on the first send.
  let activeSkillIds: string[] = []
  let skillsAnnounced = false
  // Digital-twin grounding state. The stable segment (persona/identity) is
  // appended to the cached SendOptions once per options lifetime; the dynamic
  // segment (per-turn RAG + style) rides each user message as a
  // <twin-context> block, because the interactive channel caches its options
  // at ensureReady and cannot re-resolve the system prompt per turn. One
  // English notice per session when the desktop is unreachable.
  const fetchTwin = params.fetchTwin ?? defaultFetchTwinContext
  const twinEnabled = params.config.twin?.enabled === true && !!params.config.twin.characterId
  let twinStableInjected = false
  let twinNoticeShown = false
  // Set when the db refused to open because its snapshot was unsafe; reported to
  // the UI on the next send, once. Distinct from a transient open failure, which
  // stays silent.
  let databaseError: CliDbSnapshotError | null = null
  let databaseErrorShown = false

  async function ensureReady(): Promise<SendOptions> {
    if (closed) throw new Error("agent session is closed")
    if (!options) {
      // Hydrate the in-tree plugin runtime BEFORE resolving options so
      // `buildPluginToolsManifest` (inside `resolveSendOptions`) sees the
      // plugins. Graceful: a failure leaves the manifest empty, chat unaffected.
      if (pluginToolsEnabled) await loadPluginRuntime()
      let ephemeralSkillIds = resolveSkillIds()
      // The desktop build-options pipeline reads enabled skills from Dexie via
      // `getDb()`, which throws "getDb() called on the server" unless the
      // CLI-local db (and its `window` + IndexedDB shims) is open. Plain chat
      // touches no Dexie table, so open it lazily — only when a skill is enabled
      // (commonly carried over from a prior session's `/skill` state file).
      // Mirrors the goal/memory/tasks controllers, which open the db first too.
      if (ephemeralSkillIds.length > 0) {
        try {
          await ensureDb()
        } catch (err) {
          // Opening the CLI-local db failed (locked file, missing shim, …).
          // Degrade gracefully: resolve options WITHOUT skills rather than let
          // the build-options Dexie read crash the whole turn. Chat still works;
          // the skills just don't attach this session.
          // An unsafe snapshot is different in kind: the user's data was moved
          // aside, so degrading silently would read as it having vanished.
          if (err instanceof CliDbSnapshotError) databaseError = err
          ephemeralSkillIds = []
        }
      }
      activeSkillIds = ephemeralSkillIds
      // Resolve the active agent mode (best-effort — a bad mode never breaks the
      // turn) so its prompt/tools/model/permission flow through the shared
      // resolver, identical to the desktop.
      const agentMode = await resolveAgentMode().catch(() => null)
      const ctx = toBuildContext({
        sessionId,
        config: params.config,
        mcpServers: resolveMcpServers(),
        ephemeralSkillIds,
        ...(params.sessionKind ? { sessionKind: params.sessionKind } : {}),
        ...(agentMode ? { agentMode } : {}),
        // Live TUI turn: request token-level partials so the deltas keep feeding
        // the idle watchdog through a long single generation (large file write),
        // preventing a spurious "stream idle for 60000ms" interrupt.
        interactive: true,
        now: now(),
      })
      options = withCliDisabledMcpTools(
        withCliAutoApprovedTools(await resolveOptions(ctx), resolveApprovedTools()),
        resolveDisabledMcpTools()
      )
      // Surface the `dispatch_agent` (Task) tool so the model can launch a
      // subagent. The CLI's dispatch is ALWAYS its own: a model call round-trips
      // (`plugin_tool_exec` → the CLI handle → `runCliSubagent`) and runs over
      // THIS host's sidecar/provider. So advertise the provider-agnostic
      // plugin-tool unconditionally — the Anthropic path consumes `pluginTools`
      // (a `cognia-plugin-tools` MCP server) exactly like the ai-sdk path, so the
      // tool reaches the model on BOTH channels.
      //
      // We must NOT lean on the SDK-native Task tool driven by `options.agents`:
      // `resolveSendOptions` now populates that in direct chat (the desktop's
      // workflow-*/plugin/template subagents), but (a) those are wired to the
      // desktop's Dexie-backed `executeAgent`, absent here, and (b) on the ai-sdk
      // channel `options.agents` only drives the `@agent` identity overlay, never
      // a dispatch tool — so the model saw NO way to delegate there. A non-empty
      // `options.agents` also used to SUPPRESS this very tool (the removed
      // `nativeAgentsPresent` guard), the regression that left dispatch dormant.
      // So drop the desktop agent map and make the CLI plugin tool the single
      // dispatch path. `withBuiltinAgents` guarantees ≥1 agent (general-purpose)
      // even on discovery failure, so the manifest is non-null even with no
      // `.cognia/agents/*.md`. The CLI sets no `options.agent` (see
      // `toBuildContext`), so dropping the map can't strand an `@agent` reference.
      agents = await resolveAgents().catch(() => withBuiltinAgents([]))
      delete options.agents
      const manifest = buildCliSubagentToolManifest(agents)
      if (manifest) {
        options.pluginTools = [...(options.pluginTools ?? []), manifest]
        subagentToolEnabled = true
      }
      // Name-only skill loading (progressive disclosure): when skills are enabled
      // AND the load mode is "name", the prompt carries only the catalog, so the
      // model needs the `load_skill` tool to pull a skill's full body on demand.
      // The plugin-tool executor is subscribed unconditionally below (for
      // `ask_user`), so the tool round-trips back to the CLI handle without a
      // separate gate. Best-effort metadata read enriches the advertised list; a
      // failure still surfaces a generic (functional) tool.
      if (skillLoadMode === "name" && ephemeralSkillIds.length > 0) {
        const loadable = await resolveLoadableSkills(ephemeralSkillIds).catch(
          (): LoadableSkill[] => []
        )
        options.pluginTools = [
          ...(options.pluginTools ?? []),
          buildLoadSkillManifestEntry(loadable),
        ]
      }
    }
    if (!boot) {
      boot = await bootstrap(params.config.cwd)
      // The transport is now live — subscribe the plugin-tool executor so the
      // model's plugin tool calls round-trip back here for execution. This MUST
      // be unconditional: `resolveSendOptions` always appends the `ask_user`
      // elicitation tool to `options.pluginTools` (it's a core, side-effect-free
      // capability, advertised on every send regardless of the plugin/web/skill
      // flags), AND its manifest disables the 120s relay timeout. So if the model
      // calls `ask_user` while no executor is subscribed, the `plugin_tool_exec`
      // event has no handler, the response never comes, and the turn hangs
      // forever. Web tools, plugin tools, and `dispatch_agent` all ride the same
      // wire, so a single subscription serves them too. Idempotent: guarded by
      // `pluginUnsub`, and a subscribe failure degrades to no plugin tools.
      if (!pluginUnsub) {
        pluginUnsub = await subscribePluginTools().catch(() => null)
      }
    }
    return options
  }

  return {
    sessionId,
    async send(prompt, opts) {
      const sendOptions = await ensureReady()
      // Non-Anthropic (ai-sdk) channel agentic step budget. The sidecar's
      // `dispatchAiSdk` runs a manual agent loop and continues across tool-call
      // legs up to this many steps; without it the channel silently stopped after
      // a single 16-step leg. Sourced from resolved config (default 256) so it
      // applies to every interactive/headless turn. An explicit `maxTurns`
      // (subagents / `/goal`) still wins inside the dispatcher.
      if (sendOptions.aiSdkMaxSteps === undefined && params.config.aiSdkMaxSteps !== undefined) {
        sendOptions.aiSdkMaxSteps = params.config.aiSdkMaxSteps
      }
      // Per-tool execution deadline for read-only built-ins on the ai-sdk
      // channel. Without it a file-walk tool (content_search / grep / glob) that
      // hangs on a huge tree keeps the stream-idle watchdog paused, so the turn
      // only dies at the 5-minute wall-clock ("session … did not end within
      // 300000ms"). Sourced from resolved config (default 120000; `0` disables).
      if (
        sendOptions.toolExecutionTimeoutMs === undefined &&
        params.config.toolExecutionTimeoutMs !== undefined
      ) {
        sendOptions.toolExecutionTimeoutMs = params.config.toolExecutionTimeoutMs
      }
      // Announce the active skills exactly once per session, so the user sees
      // which skills attached to their chat. After `invalidateOptions` (e.g. a
      // `/skill` toggle) the set re-resolves and re-announces.
      if (!skillsAnnounced && activeSkillIds.length > 0) {
        skillsAnnounced = true
        opts.onActiveSkills?.(activeSkillIds)
      }
      // Report an unsafe snapshot exactly once per session. `ensureReady` caches,
      // so the failure is detected on one turn only — but the user must hear
      // about it even though the turn itself succeeds.
      if (databaseError && !databaseErrorShown) {
        databaseErrorShown = true
        opts.onDatabaseError?.(databaseError)
      }
      // Digital-twin grounding (opt-in): REDACTED context from the running
      // desktop. Stable segment appends to the cached system prompt once;
      // the dynamic segment (per-turn RAG) is prepended to this turn's user
      // content below. Unreachable desktop → one notice, turn ungrounded.
      let twinDynamic: string | undefined
      if (twinEnabled) {
        const twin = await fetchTwin({
          characterId: params.config.twin!.characterId!,
          message: prompt,
          sessionId,
        })
        if (!twin) {
          if (!twinNoticeShown) {
            twinNoticeShown = true
            opts.onTwinNotice?.(
              "Twin context unavailable — the Cognia desktop app is not reachable; continuing without it."
            )
          }
        } else if (twin.applied) {
          const stable = twin.applied.stable ?? twin.applied.systemPrompt
          if (!twinStableInjected && stable) {
            twinStableInjected = true
            sendOptions.systemPrompt = sendOptions.systemPrompt
              ? `${sendOptions.systemPrompt}\n\n${stable}`
              : stable
          }
          twinDynamic = twin.applied.dynamic
        }
      }
      // Assemble multimodal content: encode `@image` refs, inject text/rich-doc
      // content, and resolve `@*.pdf` per the active model (native block vs
      // OCR). The transcript keeps the typed text; only the wire payload carries
      // the encoded attachments.
      const activeProvider = sendOptions.provider ?? params.config.provider ?? "anthropic"
      const built = await (buildContentOverride
        ? buildContentOverride(prompt, params.config.cwd)
        : buildAttachmentContent(prompt, params.config.cwd, {
            provider: activeProvider,
            model: sendOptions.model ?? "",
            isAnthropic: activeProvider === "anthropic",
            anthropicKey: () =>
              params.config.providers["anthropic"]?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null,
          }))
      if (
        built.imageCount > 0 ||
        built.documentCount > 0 ||
        built.injectedFiles.length > 0 ||
        built.ocr.length > 0 ||
        built.failed.length > 0 ||
        built.skipped.length > 0
      ) {
        opts.onAttachments?.({
          imageCount: built.imageCount,
          documentCount: built.documentCount,
          injectedFiles: built.injectedFiles,
          ocr: built.ocr,
          failed: built.failed,
          skipped: built.skipped,
        })
      }
      appendTranscript(
        home,
        sessionId,
        { role: "user", content: prompt },
        params.transcriptFs,
        now()
      )
      // Publish this turn's dispatch context so a model-driven `dispatch_agent`
      // call (round-tripping through `plugin_tool_exec` → the CLI handle) can
      // launch a subagent over the live sidecar with THIS turn's gate, signal,
      // and resolved provider/MCP context. Cleared in `finally` so a later turn
      // (or a stale tool-call after the turn ended) never reuses it.
      if (subagentToolEnabled && agents.length > 0) {
        registerCliSubagentContext(sessionId, {
          agents,
          config: params.config,
          home,
          cwd: params.config.cwd,
          gate: opts.gate,
          ...(opts.signal ? { signal: opts.signal } : {}),
          mcpServers: resolveMcpServers(),
          approvedTools: resolveApprovedTools(),
          disabledMcpTools: resolveDisabledMcpTools(),
        })
      }
      let result: RunAndCaptureResult
      // Per-turn twin RAG rides the user content as a <twin-context> block —
      // the cached SendOptions can't carry a fresh system prompt each turn.
      let turnContent = built.content
      if (twinDynamic) {
        const block = `<twin-context>\n${twinDynamic}\n</twin-context>`
        turnContent =
          typeof turnContent === "string"
            ? `${block}\n\n${turnContent}`
            : [{ type: "text" as const, text: block }, ...turnContent]
      }
      try {
        result = await capture(sessionId, turnContent, sendOptions, {
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
          // Idle (read) watchdog: interrupt a turn whose provider stream stalls
          // mid-flight. Sourced from resolved config (default 60s) so it applies
          // to every interactive/headless turn without per-call plumbing.
          idleTimeoutMs: params.config.streamIdleTimeoutMs,
          onPermissionRequest: opts.gate,
          onEvent: opts.onEvent,
        })
      } finally {
        clearCliSubagentContext(sessionId)
      }
      appendTranscript(
        home,
        sessionId,
        {
          role: "assistant",
          content: result.text,
          meta: {
            model: sendOptions.model,
            provider: sendOptions.provider,
            ...(result.usage ? { usage: result.usage } : {}),
          },
        },
        params.transcriptFs,
        now()
      )
      return result
    },
    invalidateOptions() {
      options = null
      // Re-resolve skills next turn and re-announce them (the user may have
      // just toggled a skill via `/skill`).
      skillsAnnounced = false
      // The rebuilt options lose the appended twin stable segment — inject it
      // again on the next twin-grounded turn.
      twinStableInjected = false
    },
    async setPermissionMode(mode) {
      // Before the sidecar has spawned there is no live session to mutate — the
      // mode is already in `params.config` and folds into the first
      // `startSession` via `resolveOptions`. Do nothing (and never respawn).
      if (closed || boot === null) return
      await setSessionMode(sessionId, mode)
      // Keep the cached options coherent so a later `invalidateOptions` +
      // re-resolve (or any local read) reflects the live mode.
      if (options) options = { ...options, permissionMode: mode }
    },
    isLive() {
      return boot !== null && !closed
    },
    async close() {
      if (closed) return
      closed = true
      // Drop any lingering dispatch context (defensive — `send` clears it per
      // turn, but a close mid-turn must not leave a stale entry behind).
      clearCliSubagentContext(sessionId)
      if (pluginUnsub) {
        try {
          await pluginUnsub()
        } catch {
          // best-effort detach
        }
        pluginUnsub = null
      }
      if (boot) await boot.shutdown()
    },
  }
}
