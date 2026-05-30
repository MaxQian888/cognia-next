// Anthropic dispatch: thin wrapper around `@anthropic-ai/claude-agent-sdk`'s
// `query()` plus the in-process MCP servers (cognia-tools + a2ui-bridge).
//
// Returns the `Session` shape consumed by `claude-host.mjs`:
//   { q, pushUserMessage, closeInput, pendingApprovals }
//
// Behaviour parity: this module is a straight extraction of what the
// pre-port `startSession` did when no provider field was set. The protocol
// emitted on stdout is unchanged (sdk_session_id / event / permission_request
// / session_ended).

import { query } from "@anthropic-ai/claude-agent-sdk"
import { randomUUID } from "node:crypto"
import {
  buildCogniaToolsServer,
  namesForDisabledCategories,
  SERVER_NAME as BUILTIN_SERVER_NAME,
} from "../builtin-tools/index.mjs"
import { buildA2UIBridgeServer, SERVER_NAME as A2UI_SERVER_NAME } from "../a2ui-tools/index.mjs"
import {
  buildPluginToolsServer,
  SERVER_NAME as PLUGIN_TOOLS_SERVER_NAME,
} from "../builtin-tools/plugin-tools.mjs"
import { makeInputStream } from "./input-stream.mjs"
import {
  makeServerAlwaysLoad,
  alwaysLoadToolSet,
  stampUserServersAlwaysLoad,
} from "./tool-search-policy.mjs"

/**
 * @param {{
 *   sessionId: string,
 *   firstPrompt: any,
 *   sendOptions: Record<string, any>,
 *   emit: (msg: any) => void,
 *   log: (level: "info"|"warn"|"error", message: string) => void,
 * }} params
 */
export function dispatchAnthropic({ sessionId, firstPrompt, sendOptions, emit, log }) {
  const inputStream = makeInputStream()
  /** @type {Map<string, { resolve: (r: any) => void }>} */
  const pendingApprovals = new Map()
  /**
   * Plugin tool calls awaiting a `plugin_tool_response` from the renderer.
   * Keyed by `toolUseId`. Drained by `claude-host.mjs` when a response
   * arrives over stdin. See `sidecar/builtin-tools/plugin-tools.mjs`.
   * @type {Map<string, { resolve: (r: any) => void }>}
   */
  const pendingPluginToolCalls = new Map()

  const resumeId = sendOptions.resumeSessionId ?? sendOptions.forkFromSessionId
  const isFork = sendOptions.forkFromSessionId != null

  // --- Runtime tool-search (deferred loading) policy -----------------------
  // claude-agent-sdk `alwaysLoad` semantics: when tool search is enabled the
  // bundled CLI defers MCP-server tools behind tool search, keeping only the
  // `alwaysLoad` servers/tools resident. `resolveSendOptions` decides the
  // policy from AppSettings/Character; here we apply it to every in-process
  // server and to the user-configured `mcpServers` map.
  //
  // When tool search is OFF we mark *every* server `alwaysLoad` so all tools
  // stay resident — reproducing the legacy behaviour even if the bundled CLI
  // would otherwise auto-defer once deferred-tool tokens cross its ~10%
  // context threshold. These are sidecar-protocol fields: they are NOT in the
  // `options` allowlist below, so they never reach `query()` verbatim. See
  // `./tool-search-policy.mjs` for the (unit-tested) decision logic.
  const serverAlwaysLoad = makeServerAlwaysLoad(sendOptions)
  const alwaysLoadToolNames = alwaysLoadToolSet(sendOptions)

  // Built-in cognia-tools MCP server (category-toggled).
  const builtinEnabled = sendOptions.builtinTools
  const builtinServer = buildCogniaToolsServer({
    enabled: builtinEnabled,
    alwaysLoad: serverAlwaysLoad(BUILTIN_SERVER_NAME),
  })
  // Stamp `alwaysLoad` onto user-configured MCP servers per the tool-search
  // policy (the map is keyed by server name, matching alwaysLoadServers).
  const baseUserServers = stampUserServersAlwaysLoad(sendOptions.mcpServers, serverAlwaysLoad)
  const withBuiltins = builtinServer
    ? Object.prototype.hasOwnProperty.call(baseUserServers, BUILTIN_SERVER_NAME)
      ? (() => {
          log(
            "warn",
            `user-defined mcp server '${BUILTIN_SERVER_NAME}' shadows built-in tools — keeping user's`
          )
          return baseUserServers
        })()
      : { ...baseUserServers, [BUILTIN_SERVER_NAME]: builtinServer }
    : { ...baseUserServers }

  // A2UI bridge: always-on in-process MCP server. Interactive surfaces must
  // never be deferred behind tool search, so this server is always-load
  // regardless of the runtime policy (the builder defaults alwaysLoad=true).
  const a2uiServer = buildA2UIBridgeServer({ sessionId, emit, alwaysLoad: true })
  const withA2UI = Object.prototype.hasOwnProperty.call(withBuiltins, A2UI_SERVER_NAME)
    ? (() => {
        log(
          "warn",
          `user-defined mcp server '${A2UI_SERVER_NAME}' shadows built-in a2ui-bridge — keeping user's`
        )
        return withBuiltins
      })()
    : { ...withBuiltins, [A2UI_SERVER_NAME]: a2uiServer }

  // Plugin tools bridge (M2). When the renderer passes a plugin tools
  // manifest, synthesize an in-process MCP server that proxies invocations
  // back over stdio via `plugin_tool_exec` events. The `pendingPluginToolCalls`
  // map is shared with `claude-host.mjs` so the renderer-side response can
  // resolve the in-flight tool call.
  let mergedMcpServers = withA2UI
  if (Array.isArray(sendOptions.pluginTools) && sendOptions.pluginTools.length > 0) {
    const pluginToolsServer = buildPluginToolsServer({
      tools: sendOptions.pluginTools,
      emit,
      sessionId,
      pendingPluginToolCalls,
      alwaysLoad: serverAlwaysLoad(PLUGIN_TOOLS_SERVER_NAME),
      alwaysLoadToolNames,
    })
    if (pluginToolsServer) {
      mergedMcpServers = Object.prototype.hasOwnProperty.call(withA2UI, PLUGIN_TOOLS_SERVER_NAME)
        ? (() => {
            log(
              "warn",
              `user-defined mcp server '${PLUGIN_TOOLS_SERVER_NAME}' shadows plugin-tools — keeping user's`
            )
            return withA2UI
          })()
        : { ...withA2UI, [PLUGIN_TOOLS_SERVER_NAME]: pluginToolsServer }
    }
  }

  // Defence-in-depth: stamp disabled-category tool names onto disallowedTools.
  const disallowed = new Set(sendOptions.disallowedTools ?? [])
  if (builtinEnabled !== undefined) {
    for (const name of namesForDisabledCategories(builtinEnabled)) {
      disallowed.add(name)
    }
  }

  // Plugin-first Computer Use M4 — Anthropic Agent Skills passthrough.
  // The agent SDK reads the public `anthropic-beta` header from
  // `ANTHROPIC_DEFAULT_HEADERS` (comma-separated list of `key=value` pairs)
  // when present. We only set it when the renderer actually attached
  // container skills so non-skills sends stay on stable behaviour.
  //
  // ADR-0028 — per-`query()` env is the per-session account/proxy isolation
  // mechanism. `sendOptions.env` (built by `lib/claude/build-options.ts`)
  // carries the resolved account env (`CLAUDE_CODE_OAUTH_TOKEN`,
  // `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL`, …) plus proxy env. The
  // claude-agent-sdk v0.2.111+ overlays this onto the spawned CLI
  // subprocess's environment; an earlier v0.2.113 brief replace-not-overlay
  // regime is also handled correctly by our explicit `process.env` spread
  // below — DO NOT collapse this to `sendOptions.env` alone or essential
  // host vars like PATH will be lost on Windows.
  const baseEnv = { ...process.env, ...(sendOptions.env ?? {}) }
  if (Array.isArray(sendOptions.containerSkillIds) && sendOptions.containerSkillIds.length > 0) {
    const existingHeaders = baseEnv.ANTHROPIC_DEFAULT_HEADERS
    const skillsHeader = "anthropic-beta=skills-2025-10-02"
    baseEnv.ANTHROPIC_DEFAULT_HEADERS = existingHeaders
      ? `${existingHeaders},${skillsHeader}`
      : skillsHeader
  }

  // M5 Computer Use — merge `sendOptions.appendHeaders` into
  // ANTHROPIC_DEFAULT_HEADERS. The renderer's `resolveSendOptions` populates
  // `appendHeaders["anthropic-beta"]` (typically `computer-use-2025-11-24`)
  // when the active character has `enableComputerUse === true` and at least
  // one native Anthropic tool is registered. The merging is comma-joined and
  // the per-key prefix matches the existing skills-header pattern.
  if (sendOptions.appendHeaders && typeof sendOptions.appendHeaders === "object") {
    const additions = []
    for (const [key, value] of Object.entries(sendOptions.appendHeaders)) {
      if (typeof key !== "string" || typeof value !== "string") continue
      if (!key || !value) continue
      additions.push(`${key}=${value}`)
    }
    if (additions.length > 0) {
      const existing = baseEnv.ANTHROPIC_DEFAULT_HEADERS
      baseEnv.ANTHROPIC_DEFAULT_HEADERS = existing
        ? `${existing},${additions.join(",")}`
        : additions.join(",")
    }
  }

  // Allowlist construction — only fields listed below reach the SDK. This is
  // intentional: cognia-next sends a few sidecar-protocol-only fields
  // (`builtinTools`, `bareMode`, `debugMode`, `briefMode`, `aliasResolution`,
  // `routingDecision`, `provider`, `providerCredentials`,
  // `containerSkillIds`) that the SDK doesn't recognise. They're consumed
  // earlier in `resolveSendOptions` (translated into env / settingSources /
  // appendSystemPrompt / etc.) or in this dispatcher before this object is
  // built (`builtinTools` → `mergedMcpServers`,
  // `containerSkillIds` → env header + SDK `containerSkillIds` field).
  const options = {
    cwd: sendOptions.cwd,
    model: sendOptions.model,
    fallbackModel: sendOptions.fallbackModel,
    systemPrompt: sendOptions.systemPrompt,
    appendSystemPrompt: sendOptions.appendSystemPrompt,
    allowedTools: sendOptions.allowedTools,
    disallowedTools: disallowed.size > 0 ? [...disallowed] : sendOptions.disallowedTools,
    additionalDirectories: sendOptions.additionalDirectories,
    permissionMode: sendOptions.permissionMode,
    mcpServers: mergedMcpServers,
    maxTurns: sendOptions.maxTurns,
    maxThinkingTokens: sendOptions.maxThinkingTokens,
    includePartialMessages: sendOptions.includePartialMessages,
    settingSources: sendOptions.settingSources,
    agents: sendOptions.agents,
    strictMcpConfig: sendOptions.strictMcpConfig,
    effort: sendOptions.effort,
    resume: resumeId,
    forkSession: isFork ? true : undefined,
    // Anthropic Agent Skills: forwarded to the SDK as-is. When unset the SDK
    // omits the field and the request is plain Claude. The SDK accepts the
    // shape `{ skill_id: string; version?: string }[]`.
    containerSkillIds: sendOptions.containerSkillIds,
    env: baseEnv,

    canUseTool: (toolName, input, ctx) => {
      // ADR-0020 W3 — short-circuit the chat-side approval modal when
      // the renderer has pre-approved this tool for the session. The
      // Rust permission gate runs its own check on every `desktop.*`
      // call, so suppressing here only skips the *redundant* second
      // prompt. Populated by `applyComputerUseTools` from
      // per-session grants when `chatConsentMode === "session-grant"`.
      const suppressList = Array.isArray(sendOptions.suppressApprovalForTools)
        ? sendOptions.suppressApprovalForTools
        : null
      if (suppressList && suppressList.includes(toolName)) {
        return Promise.resolve({ behavior: "allow", updatedInput: input })
      }
      const requestId = randomUUID()
      emit({
        type: "permission_request",
        sessionId,
        requestId,
        toolUseID: ctx.toolUseID,
        toolName,
        input,
        title: ctx.title,
        displayName: ctx.displayName,
        description: ctx.description,
        blockedPath: ctx.blockedPath,
        decisionReason: ctx.decisionReason,
        suggestions: ctx.suggestions,
      })
      return new Promise((resolve) => {
        pendingApprovals.set(requestId, { resolve })
        if (ctx.signal) {
          const onAbort = () => {
            if (pendingApprovals.delete(requestId)) {
              resolve({ behavior: "deny", message: "aborted" })
            }
          }
          if (ctx.signal.aborted) onAbort()
          else ctx.signal.addEventListener("abort", onAbort, { once: true })
        }
      })
    },
  }

  // Strip undefined/null so the SDK uses its defaults instead of choking on
  // `null.type` lookups.
  for (const k of Object.keys(options)) {
    if (options[k] === undefined || options[k] === null) delete options[k]
  }

  const q = query({ prompt: inputStream.iterable, options })

  const session = {
    q,
    pushUserMessage: (content) =>
      inputStream.push({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: sessionId,
      }),
    closeInput: inputStream.close,
    pendingApprovals,
    pendingPluginToolCalls,
    sendOptions,
  }

  // Push the first turn immediately.
  session.pushUserMessage(firstPrompt)

  // Pipe SDK events to the parent. Captures the SDK-issued session id on the
  // first event that carries one (powers resume continuity).
  let sdkSessionIdSeen = false
  ;(async () => {
    try {
      for await (const evt of q) {
        if (!sdkSessionIdSeen && evt && typeof evt.session_id === "string") {
          sdkSessionIdSeen = true
          emit({
            type: "sdk_session_id",
            sessionId,
            sdkSessionId: evt.session_id,
          })
        }
        emit({ type: "event", sessionId, event: evt })
      }
      emit({ type: "session_ended", sessionId })
    } catch (err) {
      emit({
        type: "session_ended",
        sessionId,
        error: err?.message ?? String(err),
      })
    } finally {
      session._ended = true
    }
  })()

  return session
}
