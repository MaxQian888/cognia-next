/**
 * Renderer-side IPC handler for `plugin_tool_exec` events from the SDK
 * sidecar (M2 of the plugin-first Computer Use plan).
 *
 * Flow:
 *   1. The sidecar's synthetic `cognia-plugin-tools` MCP server proxies a
 *      tool call back to the renderer as a `plugin_tool_exec` event.
 *   2. The renderer listens on the `claude://message` channel and routes
 *      every `plugin_tool_exec` payload through {@link handlePluginToolExec}.
 *   3. This handler resolves the plugin tool through the live plugin
 *      registry (the same registry the AI-SDK bridge uses, so a plugin
 *      registered ONCE via `ctx.agent.registerTool()` lights up both
 *      runtimes), executes it, and returns a `plugin_tool_response`.
 *   4. The caller is responsible for writing the response back to the
 *      sidecar (a future `claude_plugin_tool_response` Tauri command will
 *      forward it onto the sidecar's stdin, where `claude-host.mjs`
 *      resolves the pending `pendingPluginToolCalls` entry).
 *
 * Errors are caught here and surfaced as a structured `error: string` on
 * the response — never thrown — so a faulty plugin can't blow up the
 * renderer-side event router.
 */

import type { PluginToolContext } from "@/types/plugin"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { WORKFLOW_RUNNER_TOOL_NAME } from "@/lib/workflow/publish/runner-tool"
import { ASK_USER_TOOL_NAME } from "./ask-user-tool"
import { DISPATCH_AGENT_TOOL_NAME, TASK_TOOL_NAME } from "./agents/dispatch-agent-tool"
import { isWebBuiltinTool, runWebBuiltinTool, type WebToolRunDeps } from "./web-builtin-tools"
import {
  isSkillBuiltinTool,
  runSkillBuiltinTool,
  type SkillToolRunDeps,
} from "./skill-builtin-tools"
import {
  isSlashCommandBuiltinTool,
  runSlashCommandBuiltinTool,
  type SlashToolRunDeps,
} from "./slash-builtin-tools"
import {
  isEditorBuiltinTool,
  runEditorBuiltinTool,
  type EditorToolRunDeps,
} from "./editor-builtin-tools"
import { isTeamBuiltinTool, runTeamBuiltinTool } from "./team-builtin-tools"
import {
  VECTOR_BUILTIN_PLUGIN_ID,
  isVectorBuiltinTool,
  runVectorBuiltinTool,
  type VectorToolRunDeps,
} from "./vector-builtin-tools"
import { getTeamDispatchContext } from "./agents/dispatch-context-registry"
import { isWorkingSetTool, runWorkingSetTool } from "./working-set-tool"
import {
  isSpawnTaskBuiltinTool,
  runSpawnTaskBuiltinTool,
  type SpawnTaskToolRunDeps,
} from "./spawn-task-builtin-tools"
import {
  isSessionPeerBuiltinTool,
  runSessionPeerBuiltinTool,
  type SessionPeerToolRunDeps,
} from "./session-peer-builtin-tools"
import type { RemoteExecutionContext } from "./remote-execution"

const PLUGIN_TOOL_RESULT_PII_ERROR = "Plugin tool result blocked by the PII redaction gate"

function assertSafePluginToolResult<T>(result: T): T {
  if (!hasNoLeakingPiiDeep(result)) {
    throw new Error(PLUGIN_TOOL_RESULT_PII_ERROR)
  }
  return result
}

// NOTE on the audit's P0-3 ("host-routed tools cannot return a tool error").
//
// The finding is accurate as a description: `error` on this response is only
// ever produced by the outer catch, so a host-routed tool that fails in its
// payload (`ok: false`, or a string starting with "Error: ") reaches the model
// as a SUCCESSFUL tool result.
//
// It is NOT safe to fix by blanket-mapping `ok: false` onto `error`. That
// contradicts a deliberate, tested design decision — see
// `plugin-tool-ipc.test.ts` "returns a structured refusal (not an error) when a
// permission is missing" and "rejects a team tool from a non-team session":
// a refusal is meant to be a structured result the model can read and adapt to,
// not a tool error that aborts the step.
//
// Closing this properly needs a per-tool decision about which failures are
// refusals and which are errors, plus a unified result envelope across the
// family (audit P1-2). Left open on purpose rather than papered over.

export interface PluginToolExecRequest {
  type: "plugin_tool_exec"
  sessionId: string
  toolUseId: string
  name: string
  args: Record<string, unknown>
  sandboxRuntimeRef?: string
  /** Cooperative cancellation for direct renderer callers such as live voice. */
  abortSignal?: AbortSignal
  remoteExecutionContext?: RemoteExecutionContext
}

export interface PluginToolExecResponse {
  type: "plugin_tool_response"
  sessionId: string
  toolUseId: string
  result?: unknown
  error?: string
}

/**
 * Resolver for the live plugin registry. Lifted to a module-level slot so
 * unit tests can swap a mock implementation in without touching the real
 * plugin manager singleton (which throws when uninitialised in jsdom).
 */
export interface PluginToolResolver {
  /**
   * Look up a plugin tool by its bare name. Returns `undefined` when the
   * tool is unknown or its owning plugin is disabled.
   */
  getTool(name: string):
    | {
        pluginId: string
        execute: (args: Record<string, unknown>, context: PluginToolContext) => Promise<unknown>
      }
    | undefined
  /**
   * Per-plugin runtime config snapshot, surfaced inside the
   * {@link PluginToolContext} passed to `execute`. Returning `undefined`
   * is treated as "no config" and the context falls through to `{}`.
   */
  getPluginConfig?: (pluginId: string) => Record<string, unknown> | undefined
}

let resolverOverride: PluginToolResolver | null = null

/**
 * Resolver for the promoted web tools' host-side dependencies (search provider
 * settings, user agent). Default reads the renderer settings store; the CLI
 * host overrides it from config. Swappable for tests.
 */
let webToolDepsOverride: (() => Promise<WebToolRunDeps> | WebToolRunDeps) | null = null

let spawnTaskDepsOverride: (() => Promise<SpawnTaskToolRunDeps> | SpawnTaskToolRunDeps) | null =
  null
let sessionPeerDepsOverride:
  (() => Promise<SessionPeerToolRunDeps> | SessionPeerToolRunDeps) | null = null

export function __setSpawnTaskToolDepsForTesting(
  fn: (() => Promise<SpawnTaskToolRunDeps> | SpawnTaskToolRunDeps) | null
): void {
  spawnTaskDepsOverride = fn
}

async function resolveSpawnTaskToolDeps(): Promise<SpawnTaskToolRunDeps> {
  if (spawnTaskDepsOverride) return spawnTaskDepsOverride()
  const { dispatchSpawnTask } = await import("@/lib/tasks/spawn-task-dispatch")
  return { gate: hasNoLeakingPiiDeep, dispatch: dispatchSpawnTask }
}

export function __setSessionPeerToolDepsForTesting(
  fn: (() => Promise<SessionPeerToolRunDeps> | SessionPeerToolRunDeps) | null
): void {
  sessionPeerDepsOverride = fn
}

async function resolveSessionPeerToolDeps(): Promise<SessionPeerToolRunDeps> {
  if (sessionPeerDepsOverride) return sessionPeerDepsOverride()
  const [{ listReachableSessions, sendSessionPeerMessage }, { useChatStore }] = await Promise.all([
    import("@/lib/chat/session-peer-messaging"),
    import("@/stores/chat/chat-store"),
  ])
  return {
    gate: hasNoLeakingPiiDeep,
    listReachable: async (senderSessionId) =>
      (await listReachableSessions(senderSessionId)).map((session) => ({
        id: session.id,
        title: session.title,
        status: useChatStore.getState().sessions[session.id]?.status ?? "idle",
      })),
    send: sendSessionPeerMessage,
  }
}

/** Inject web-tool deps (tests / CLI host). Pass `null` to restore default. */
export function __setWebToolDepsForTesting(
  fn: (() => Promise<WebToolRunDeps> | WebToolRunDeps) | null
): void {
  webToolDepsOverride = fn
}

/** Resolver for the Skill tool's host-side deps. Swappable for tests / CLI. */
let skillToolDepsOverride: (() => Promise<SkillToolRunDeps> | SkillToolRunDeps) | null = null

/** Inject Skill-tool deps (tests / CLI host). Pass `null` to restore default. */
export function __setSkillToolDepsForTesting(
  fn: (() => Promise<SkillToolRunDeps> | SkillToolRunDeps) | null
): void {
  skillToolDepsOverride = fn
}

async function resolveSkillToolDeps(): Promise<SkillToolRunDeps> {
  if (skillToolDepsOverride) return skillToolDepsOverride()
  const { getCatalogSkill } = await import("@/lib/skills/built-in-catalog")
  return {
    getCatalogSkill: (id: string) => {
      const e = getCatalogSkill(id)
      return e ? { id: e.id, name: e.name, content: e.content } : undefined
    },
    loadCustomSkill: async (key: string) => {
      try {
        const { getSkill, listSkills } = await import("@/lib/db/skills")
        const byId = await getSkill(key)
        if (byId) return { id: byId.id, name: byId.name, content: byId.content }
        const all = await listSkills()
        const hit = all.find((s) => s.id === key || s.name === key)
        return hit ? { id: hit.id, name: hit.name, content: hit.content } : undefined
      } catch {
        // No Dexie (CLI host) — built-in catalog resolution already tried.
        return undefined
      }
    },
  }
}

/** Resolver for the SlashCommand tool's host-side deps. Swappable for tests. */
let slashToolDepsOverride: (() => Promise<SlashToolRunDeps> | SlashToolRunDeps) | null = null

/** Inject SlashCommand-tool deps (tests / CLI host). Pass `null` to restore. */
export function __setSlashToolDepsForTesting(
  fn: (() => Promise<SlashToolRunDeps> | SlashToolRunDeps) | null
): void {
  slashToolDepsOverride = fn
}

async function resolveSlashToolDeps(): Promise<SlashToolRunDeps> {
  if (slashToolDepsOverride) return slashToolDepsOverride()
  try {
    const { dispatchSlashCommand } = await import("@/lib/slash-commands/registry")
    return {
      dispatch: (line, ctx) => dispatchSlashCommand(line, ctx),
    }
  } catch {
    return {}
  }
}

async function resolveEditorToolDeps(): Promise<EditorToolRunDeps> {
  const [
    { readActiveFromProjectEditor },
    { getSession },
    { resolveSessionProjectRoot },
    { useProjectStore },
    { hasNoLeakingPiiDeep },
    { codeServerClient },
    { getActiveProIdeRoot },
  ] = await Promise.all([
    import("@/lib/files/project-editor-bridge"),
    import("@/lib/db/sessions"),
    import("@/lib/workspace/roots"),
    import("@/stores/project/project-store"),
    import("@cognia/redact"),
    import("@/lib/codeserver/client"),
    import("@/lib/codeserver/pane-manager"),
  ])
  return {
    resolveRoot: async (sessionId) => {
      const session = await getSession(sessionId).catch(() => null)
      const projects = useProjectStore.getState().projects
      return resolveSessionProjectRoot(session, projects).root?.path ?? null
    },
    // Through the bridge, not `codeServerClient`: whichever engine is mounted
    // answers. Reading code-server directly made the tool return
    // `{available:false}` for every user who never switched to Pro IDE — i.e.
    // almost all of them — while Monaco could answer the whole time.
    readActive: readActiveFromProjectEditor,
    gate: (payload) => hasNoLeakingPiiDeep(payload),
    // The write half goes direct to code-server rather than through the bridge:
    // a native diff view, an undo-able external-edit reflection and an explorer
    // reveal have no Monaco equivalent for the bridge to dispatch to.
    proIde: {
      resolveProIdeRoot: getActiveProIdeRoot,
      open: (root, path, line, column) => codeServerClient.driveOpen(root, path, line, column),
      reveal: (root, path) => codeServerClient.reveal(root, path),
      showDiff: (root, path, content, title) =>
        codeServerClient.showDiff(root, path, content, title),
      applyEdit: (root, path, line, column) =>
        codeServerClient.driveApplyEdit(root, path, line, column),
      saveAll: (root, path) => codeServerClient.saveAll(root, path),
    },
  }
}

/** Resolver for the vector tools' host-side deps. Swappable for tests / CLI. */
let vectorToolDepsOverride: (() => Promise<VectorToolRunDeps> | VectorToolRunDeps) | null = null

/** Inject vector-tool deps (tests / CLI host). Pass `null` to restore default. */
export function __setVectorToolDepsForTesting(
  fn: (() => Promise<VectorToolRunDeps> | VectorToolRunDeps) | null
): void {
  vectorToolDepsOverride = fn
}

/**
 * Build the vector tools' host deps: the native-only vector service bound to
 * the user's configured embedding settings, the session→project resolver, and
 * the permission check.
 *
 * Permissions live in the shared `PluginAPIPermission` space under the
 * synthetic `cognia-vector-builtin` subject. Enabling `selfInvokeTools.vector`
 * is the consent event, so the three permissions are seeded on first use; a
 * host policy that revokes one through the permission guard still wins,
 * because `hasApiOrGuardPermission` consults both.
 */
async function resolveVectorToolDeps(): Promise<VectorToolRunDeps> {
  if (vectorToolDepsOverride) return vectorToolDepsOverride()
  const [
    { createAgentVectorService },
    { isTauri },
    { useSettingsStore },
    { useVectorStore },
    { DEFAULT_EMBEDDING_MODELS, resolveEmbeddingApiKey },
    { hasApiOrGuardPermission },
    { ensureVectorBuiltinPermissions },
  ] = await Promise.all([
    import("@/lib/vector/agent-vector-service"),
    import("@/lib/tauri"),
    import("@/stores/settings"),
    import("@/stores"),
    import("@cognia/vector/embedding"),
    import("@/lib/plugin/api/api-permission-gate"),
    import("@/lib/vector/agent-tool-permissions"),
  ])
  ensureVectorBuiltinPermissions()

  return {
    service: createAgentVectorService({
      isTauri,
      resolveEmbedding: () => {
        const providerSettings = (useSettingsStore.getState().settings?.providerSettings ??
          {}) as Parameters<typeof resolveEmbeddingApiKey>[1]
        const vectorSettings = useVectorStore.getState().settings
        const provider = (vectorSettings.embeddingProvider ||
          "openai") as keyof typeof DEFAULT_EMBEDDING_MODELS
        const defaults = DEFAULT_EMBEDDING_MODELS[provider]
        if (!defaults) return null
        return {
          embeddingConfig: {
            provider,
            model: vectorSettings.embeddingModel || defaults.model,
            dimensions: defaults.dimensions,
          },
          embeddingApiKey: resolveEmbeddingApiKey(provider, providerSettings),
        }
      },
    }),
    resolveProjectId: async (sessionId) => {
      const [{ getSession }, { useProjectStore }] = await Promise.all([
        import("@/lib/db/sessions"),
        import("@/stores/project/project-store"),
      ])
      const session = await getSession(sessionId).catch(() => null)
      return session?.projectId ?? useProjectStore.getState().activeProjectId ?? null
    },
    hasPermission: (permission) => hasApiOrGuardPermission(VECTOR_BUILTIN_PLUGIN_ID, permission),
  }
}

async function resolveWebToolDeps(): Promise<WebToolRunDeps> {
  if (webToolDepsOverride) return webToolDepsOverride()
  try {
    const { useSettingsStore } = await import("@/stores/settings")
    const s = useSettingsStore.getState().settings
    const deps: WebToolRunDeps = {
      providerSettings: s?.searchProviders,
      searchMaxResults: s?.searchMaxResults,
      searchFallbackEnabled: s?.searchFallbackEnabled,
      searchMaxRetries: s?.searchMaxRetries,
      // Forward the user's Settings → Search defaults so the agent honors them
      // (previously only provider + maxResults reached the search service).
      searchOptions: {
        ...(s?.defaultSearchType ? { searchType: s.defaultSearchType } : {}),
        ...(s?.defaultSearchDepth ? { searchDepth: s.defaultSearchDepth } : {}),
        ...(s?.defaultSearchRecency ? { recency: s.defaultSearchRecency } : {}),
        ...(s?.defaultSearchCountry ? { country: s.defaultSearchCountry } : {}),
        ...(s?.defaultSearchLanguage ? { language: s.defaultSearchLanguage } : {}),
        ...(s?.defaultIncludeDomains?.length ? { includeDomains: s.defaultIncludeDomains } : {}),
        ...(s?.defaultExcludeDomains?.length ? { excludeDomains: s.defaultExcludeDomains } : {}),
        ...(typeof s?.defaultIncludeAnswer === "boolean"
          ? { includeAnswer: s.defaultIncludeAnswer }
          : {}),
        ...(s?.defaultIncludeRawContent != null
          ? { includeRawContent: s.defaultIncludeRawContent }
          : {}),
      },
      sourceVerification: s?.sourceVerificationSettings,
      // SSRF guard opt-out + always-distill isolation, from Settings → Search.
      allowPrivateHosts: s?.webTools?.allowPrivateHosts === true,
      alwaysDistill: s?.webTools?.alwaysDistill === true,
    }
    // Reuse the search-result cache (shared with the search UI) unless the user
    // turned it off; apply their TTL / size config.
    if (s?.searchCacheEnabled !== false) {
      try {
        const { getSearchCache } = await import("@cognia/web-search/search-cache")
        const cache = getSearchCache()
        cache.setConfig({
          ...(s?.searchCacheTTL ? { defaultTTL: s.searchCacheTTL } : {}),
          ...(s?.searchCacheMaxEntries ? { maxSize: s.searchCacheMaxEntries } : {}),
        })
        deps.searchCache = cache
      } catch {
        // Cache is optional.
      }
    }
    // Query-focused web_fetch extraction — when the model passes a `prompt`, the
    // page is distilled to just the relevant content via the cheap utility
    // model. Best-effort: if no model resolves (web mode without a key) the dep
    // is omitted and web_fetch returns the full (truncated) page text instead.
    try {
      const { buildUtilityLlmClient } = await import("@/lib/ai/generation/utility-client")
      const { buildFetchExtractor } = await import("@/lib/web/web-tools-core")
      const client = buildUtilityLlmClient({
        session: null,
        appSettings: s,
        featureId: "web_fetch_extract",
      })
      if (client) deps.summarize = buildFetchExtractor(client)
    } catch {
      // No renderer LLM stack available — skip query-focused extraction.
    }
    // Short TTL cache so a repeated GET of the same URL in one turn isn't
    // re-fetched and re-billed.
    try {
      const { getFetchCache } = await import("@/lib/web/fetch-cache")
      deps.cache = getFetchCache()
    } catch {
      // Cache is optional.
    }
    // CORS-free outbound fetch so web_fetch (plus the platform scrapers and the
    // Jina fallback) can reach arbitrary hosts: native CapacitorHttp on mobile,
    // the Rust `proxy_http_request` on desktop, plain fetch in the browser. The
    // Jina fallback is only enabled where a CORS-free bridge exists.
    try {
      const { isCapacitor } = await import("@/lib/platform/detect")
      const { isTauri } = await import("@/lib/native/utils")
      if (isCapacitor()) {
        const { pinnedFetch } = await import("@/lib/tauri/pinned-fetch")
        deps.fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
          pinnedFetch(typeof input === "string" ? input : input.toString(), {
            method: init?.method,
            headers: init?.headers,
            body: typeof init?.body === "string" ? init.body : undefined,
          })) as typeof fetch
        deps.jinaFallback = true
      } else if (isTauri()) {
        const { createProxyFetch } = await import("@/lib/network/proxy-fetch")
        const base = createProxyFetch()
        // Defense-in-depth: also ask the Rust backend to reject private hosts
        // (mirrors the TS `web_fetch` guard) unless the user opted in.
        const blockPrivateHosts = deps.allowPrivateHosts !== true
        deps.fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
          base(input, { ...init, blockPrivateHosts })) as typeof fetch
        deps.jinaFallback = true
      }
      // Browser: leave fetchImpl unset (global fetch, CORS-limited); Jina off.
    } catch {
      // No native fetch bridge — fall back to global fetch.
    }
    return deps
  } catch {
    // No store (CLI host without an override) — web_search returns a clean
    // "no provider configured" error rather than crashing.
    return {}
  }
}

/**
 * Inject a custom resolver. Intended for tests — when set, resolution AND
 * execution short-circuit through the injected object (the historical
 * contract). Production code routes through the unified
 * `invokePluginTool` seam instead. Pass `null` to restore the default.
 */
export function __setPluginToolResolverForTesting(resolver: PluginToolResolver | null): void {
  resolverOverride = resolver
}

/**
 * Dispatch a `plugin_tool_exec` event from the sidecar through the live
 * plugin registry and produce the matching `plugin_tool_response`.
 *
 * Never throws — every failure mode (tool not found, plugin disabled,
 * execute() rejection, manager not initialised) is collapsed onto the
 * `error` field of the response so the sidecar-side promise always
 * resolves and the MCP tool can return a clean error envelope.
 */
export async function handlePluginToolExec(
  request: PluginToolExecRequest
): Promise<PluginToolExecResponse> {
  const baseResponse = {
    type: "plugin_tool_response" as const,
    sessionId: request.sessionId,
    toolUseId: request.toolUseId,
  }
  try {
    request.abortSignal?.throwIfAborted()
    // ── Promoted web built-ins — web_search / web_fetch ────────────────────
    // Resolved BEFORE the plugin registry so the first-class built-in
    // supersedes any duplicate the web-tools plugin still registers. Always
    // available (ungated by pluginTools); host-side because they reuse
    // lib/search + lib/document, which the .mjs sidecar can't import.
    if (isWebBuiltinTool(request.name)) {
      const result = await runWebBuiltinTool(request.name, request.args, await resolveWebToolDeps())
      return { ...baseResponse, result: assertSafePluginToolResult(result) }
    }
    // ── Promoted editor built-in — read_active_editor (Pro IDE → agent) ────
    // Host-routed: needs the renderer transport (codeserver_agent_read_active)
    // and the `@cognia/redact` PII gate, neither reachable from the .mjs sidecar.
    if (isEditorBuiltinTool(request.name)) {
      const result = await runEditorBuiltinTool(
        request.name,
        request.args,
        await resolveEditorToolDeps(),
        { sessionId: request.sessionId }
      )
      return { ...baseResponse, result: assertSafePluginToolResult(result) }
    }
    // ── Promoted spawn_task built-in — stage a user-started sidechat ──────
    if (isSpawnTaskBuiltinTool(request.name)) {
      const result = await runSpawnTaskBuiltinTool(
        request.name,
        request.args,
        await resolveSpawnTaskToolDeps(),
        { sessionId: request.sessionId }
      )
      return { ...baseResponse, result: assertSafePluginToolResult(result) }
    }
    // ── Independent-session discovery and messaging ──────────────────────
    if (isSessionPeerBuiltinTool(request.name)) {
      const result = await runSessionPeerBuiltinTool(
        request.name,
        request.args,
        await resolveSessionPeerToolDeps(),
        { sessionId: request.sessionId }
      )
      return { ...baseResponse, result: assertSafePluginToolResult(result) }
    }
    // Session-owned RLM-style working state. The Host remains authoritative:
    // the sidecar only receives a bounded manifest and every mutation reaches
    // the shared Dexie CAS service through this existing tool round trip.
    if (isWorkingSetTool(request.name)) {
      const result = await runWorkingSetTool(request.args, { sessionId: request.sessionId })
      return { ...baseResponse, result: assertSafePluginToolResult(result) }
    }
    // ── Promoted vector built-ins — project-scoped vector memory ───────────
    // Host-routed: the native sqlite-vec store is a Tauri command surface and
    // the service reaches `@/stores` for the embedding config — neither is
    // importable from the .mjs sidecar. Opt-in via selfInvokeTools.vector.
    // The runner never throws; it returns a structured {ok:false,code,error}.
    if (isVectorBuiltinTool(request.name)) {
      const result = await runVectorBuiltinTool(
        request.name,
        request.args,
        await resolveVectorToolDeps(),
        { sessionId: request.sessionId }
      )
      return { ...baseResponse, result: assertSafePluginToolResult(result) }
    }
    // ── Promoted Skill built-in — load a skill's instructions ──────────────
    // Host-routed (reaches the built-in catalog + Dexie custom skills, which
    // the .mjs sidecar can't import). Opt-in via selfInvokeTools.skill.
    if (isSkillBuiltinTool(request.name)) {
      const result = await runSkillBuiltinTool(
        request.name,
        request.args,
        await resolveSkillToolDeps(),
        { sessionId: request.sessionId }
      )
      return { ...baseResponse, result: assertSafePluginToolResult(result) }
    }
    // ── Promoted SlashCommand built-in — run a registered slash command ────
    if (isSlashCommandBuiltinTool(request.name)) {
      const result = await runSlashCommandBuiltinTool(
        request.name,
        request.args,
        await resolveSlashToolDeps(),
        { sessionId: request.sessionId }
      )
      return { ...baseResponse, result: assertSafePluginToolResult(result) }
    }
    // ── Promoted team-collaboration built-ins — message / blackboard /
    // consensus / delegate. Host-routed; the caller's teammate identity is
    // resolved from the per-session team-dispatch-context registry. A call from
    // a non-team session (no identity) is rejected rather than mis-attributed.
    if (isTeamBuiltinTool(request.name)) {
      const caller = getTeamDispatchContext(request.sessionId)
      const result = caller
        ? await runTeamBuiltinTool(request.name, request.args, caller)
        : `Error: ${request.name} is only available to a teammate during a team run.`
      return { ...baseResponse, result: assertSafePluginToolResult(result) }
    }
    if (resolverOverride) {
      // Test seam — execute through the injected resolver directly so
      // suites that stub resolution + execution in one object keep their
      // historical contract. Production never takes this branch.
      const tool = resolverOverride.getTool(request.name)
      if (tool) {
        const context: PluginToolContext = {
          sessionId: request.sessionId,
          sandboxRuntimeRef: request.sandboxRuntimeRef,
          config: resolverOverride.getPluginConfig?.(tool.pluginId) ?? {},
          signal: request.abortSignal,
        }
        const result = await tool.execute(request.args, context)
        return { ...baseResponse, result: assertSafePluginToolResult(result) }
      }
    } else {
      // Production path — resolve the owning plugin by bare tool name,
      // then route through the unified invocation seam so lazy
      // `onTool:` activation, the permission consent gate, and error
      // normalization match every other plugin-tool call site (workflow
      // `action.plugin.invoke`, quick actions).
      const { resolvePluginToolByName, invokePluginTool } =
        await import("@/lib/plugin/core/invoke-plugin-tool")
      const resolved = await resolvePluginToolByName(request.name)
      if (resolved) {
        const { result } = await invokePluginTool(resolved.pluginId, request.name, request.args, {
          signal: request.abortSignal,
          sessionId: request.sessionId,
          sandboxRuntimeRef: request.sandboxRuntimeRef,
          reason: `chat:plugin_tool_exec:${request.name}`,
        })
        return { ...baseResponse, result: assertSafePluginToolResult(result) }
      }
    }
    // ── Typed workflow runner fallback ─────────────────────────────────
    // Graph-bodied skills (`kind:"workflow"`) point the model at the shared
    // runner; `build-options.ts` manifests it even when the workflow-ai
    // plugin is disabled, so resolution through the plugin registry can
    // legitimately miss. Execute the shared lib core directly — same code
    // the plugin registration wraps.
    if (request.name === WORKFLOW_RUNNER_TOOL_NAME) {
      const { executeRunWorkflowTyped } =
        await import("@/lib/workflow/publish/run-workflow-typed-tool")
      const result = await executeRunWorkflowTyped(request.args)
      return { ...baseResponse, result: assertSafePluginToolResult(result) }
    }
    // ── ADR-0026 — built-in skill fallback ────────────────────────────
    // Tool not in the plugin registry — try the built-in skill registry.
    // The sidecar surfaces built-in skill MCP tool names verbatim from
    // `BuiltInSkill.mcpToolName`; we resolve by that field.
    const builtIn = await resolveBuiltInSkillByMcpName(request.name)
    if (builtIn) {
      const { runBuiltInSkill } = await import("@/lib/skills/built-in/dispatcher")
      // Hydrate the IM binding + override row from the session (W2). A bare
      // `{sessionId}` context used to bypass EVERY dispatcher gate (imAccess,
      // per-chat allowlist, HITL) for IM-bound sessions — the ADR-0026 trust
      // model only held on the slash-command path.
      const { resolveBuiltInSkillContext } = await import("@/lib/skills/built-in/context")
      const skillCtx = await resolveBuiltInSkillContext(request.sessionId)
      const result = await runBuiltInSkill(builtIn.id, request.args, skillCtx)
      // The dispatcher returns a discriminated union; on `denied` /
      // `pending_hitl` / `error` we surface the structured payload so the
      // model can see the reason. The SDK turns this into a tool result
      // string verbatim — opaque to the model is fine.
      return { ...baseResponse, result: assertSafePluginToolResult(result) }
    }
    // ── Wave 1 — Terminal dock fallback ────────────────────────────────
    // The 4 synthetic `terminal_dock_*` tools are manifested by
    // `lib/plugin/bridge/sidecar-tools-bridge.ts:buildTerminalDockManifestEntries`
    // when `settings.terminal.exposeDockToAgents` is true. They proxy
    // through the same `plugin_tool_exec` wire as plugin tools; resolve
    // them here so the model's tool call lands in the user's visible
    // dock PTY rather than a sidecar `child_process` ghost.
    // ── Wave 1 — ask_user elicitation tool ─────────────────────────────
    // Surfaced by `buildAskUserManifestEntry()`; round-trips through the same
    // `plugin_tool_exec` wire. Resolve it to the renderer's ask-user dialog,
    // which blocks until the user answers and returns the formatted result.
    if (request.name === ASK_USER_TOOL_NAME) {
      const { runAskUser } = await import("@/stores/agent/ask-user-store")
      const result = await runAskUser(request.args, { sessionId: request.sessionId })
      return { ...baseResponse, result: assertSafePluginToolResult(result) }
    }
    // ── Nested dispatch — `dispatch_agent` ─────────────────────────────────
    // Surfaced by `buildDispatchAgentManifestEntries` (gated by nesting depth);
    // round-trips through this same wire and executes in the renderer where
    // `dispatchSubagent` lives. Threads depth/cycle/budget via the session's
    // registered dispatch context.
    if (request.name === DISPATCH_AGENT_TOOL_NAME || request.name === TASK_TOOL_NAME) {
      const { runDispatchAgentTool } = await import("@/lib/claude/agents/dispatch-agent-handler")
      const result = await runDispatchAgentTool({
        sessionId: request.sessionId,
        args: request.args,
      })
      return { ...baseResponse, result: assertSafePluginToolResult(result) }
    }
    if (request.name.startsWith("terminal_dock_")) {
      const { runTerminalDockAction } = await import("@/lib/terminal/dock-tool-handler")
      const action = request.name.slice("terminal_dock_".length) as
        "spawn" | "write" | "read_recent" | "wait_for_exit"
      const result = await runTerminalDockAction({
        action,
        args: request.args,
        chatSessionId: request.sessionId,
      })
      return { ...baseResponse, result: assertSafePluginToolResult(result) }
    }
    return { ...baseResponse, error: `plugin tool not found: ${request.name}` }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return {
      ...baseResponse,
      error: hasNoLeakingPiiDeep(error) ? error : PLUGIN_TOOL_RESULT_PII_ERROR,
    }
  }
}

async function resolveBuiltInSkillByMcpName(
  mcpToolName: string
): Promise<{ id: string } | undefined> {
  try {
    await import("@/lib/skills/built-in")
    const { getSharedBuiltInSkillRegistry } = await import("@/lib/skills/built-in/registry")
    const reg = getSharedBuiltInSkillRegistry()
    for (const skill of reg.list()) {
      if (skill.mcpToolName === mcpToolName) {
        return { id: skill.id }
      }
    }
    return undefined
  } catch {
    return undefined
  }
}
