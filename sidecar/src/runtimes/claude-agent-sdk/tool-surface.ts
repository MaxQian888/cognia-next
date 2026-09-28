import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { SendOptions } from "../../shared/wire/inbound.ts"
import { anthropicPluginToolBridgeOptions } from "./plugin-bridge.ts"
import type { SurfaceContext } from "./runtime-types.ts"

import { buildCogniaToolsServer } from "../../tools/adapters/sdk-mcp.ts"
import {
  BUILTIN_SERVER_NAME,
  namesForDisabledCategories,
} from "../../policy/tool-catalog/catalog.ts"
import { PLUGIN_TOOLS_SERVER_NAME } from "../../policy/tool-catalog/names.ts"
import { buildA2UIBridgeServer, SERVER_NAME as A2UI_SERVER_NAME } from "../../tools/a2ui/server.ts"
import { buildPluginToolsServer } from "../../tools/plugin/server.ts"
import { modelPluginToolNameList } from "../../policy/tool-catalog/plugin-aliases.ts"

import {
  makeServerAlwaysLoad,
  alwaysLoadToolSet,
  stampUserServersAlwaysLoad,
} from "../../policy/tool-search.ts"

import { guardAnthropicRemoteMcpServers } from "../../mcp/relay/sdk-servers.ts"

/**
 * Apply the runtime-wide deny-all contract at the final SDK boundary.
 *
 * Claude Agent SDK treats `allowedTools: []` as an omitted filter, while its
 * `tools: []` option emits `--tools ""` and disables native tools. Keeping this
 * clamp after the nested SDK overlay prevents any renderer, plugin, or future
 * option merge from reopening a Support session's tool surface.
 *
 */
export function enforceAnthropicToolSurface<T extends Options>(
  options: T,
  sendOptions: Pick<SendOptions, "toolSurface">
): T {
  if (sendOptions?.toolSurface !== "none") return options
  return {
    ...options,
    tools: [],
    allowedTools: [],
    mcpServers: {},
    agents: undefined,
    agent: undefined,
    hooks: undefined,
  }
}

export function buildToolSurface({
  sendOptions,
  sessionId,
  emit,
  log,
  toolSession,
  pendingPluginToolCalls,
}: SurfaceContext) {
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
  // `../src/policy/tool-search.ts` for the (unit-tested) decision logic.
  const serverAlwaysLoad = makeServerAlwaysLoad(sendOptions)
  const alwaysLoadToolNames = alwaysLoadToolSet(sendOptions)

  // Built-in cognia-tools MCP server (category-toggled).
  const builtinEnabled = sendOptions.builtinTools

  const { lsp, codeGraph } = toolSession
  const { lspEnabled, lspResolver } = lsp

  const builtinServer = buildCogniaToolsServer({
    enabled: builtinEnabled,
    builtinProcessSandbox: sendOptions.builtinProcessSandbox,
    alwaysLoad: serverAlwaysLoad(BUILTIN_SERVER_NAME),
    ...toolSession.toolContext(),
    cwd: sendOptions.cwd,
    dispatchPath: "anthropic",
    model: sendOptions.model,
    provider: sendOptions.provider ?? "anthropic",
    // ADR-0117: the frozen composition decides which tool surface the model
    // sees. Read from the send spec rather than re-derived here, so renderer
    // and sidecar cannot disagree about what this turn is.
    toolPresentation: sendOptions.execution?.composition?.toolPresentation,
    // ADR-0045 plan authoring (`create_plan` / `update_plan`). On unless the
    // user turned it off (`planSettings.agentAuthoring: false`).
    planTools: sendOptions.planTools !== false,
    // Per-tool deadline for read-only built-ins on this channel too (parity with
    // the ai-sdk bridge). `undefined` ⇒ buildCogniaToolsServer's 120s default;
    // `0` disables.
    toolExecutionTimeoutMs: sendOptions.toolExecutionTimeoutMs,
    // Cap oversized built-in tool-result bodies (parity with the ai-sdk
    // compaction cap). Undefined ⇒ no cap. See src/tools/middleware/result-cap.ts.
    maxToolResultTokens: sendOptions.compaction?.maxToolResultTokens,
  })
  // Stamp `alwaysLoad` onto user-configured MCP servers per the tool-search
  // policy (the map is keyed by server name, matching alwaysLoadServers).
  const baseUserServers = guardAnthropicRemoteMcpServers(
    stampUserServersAlwaysLoad(sendOptions.mcpServers, serverAlwaysLoad) as Parameters<
      typeof guardAnthropicRemoteMcpServers
    >[0],
    { permissionPromptToolName: sendOptions.claudeAgentSdk?.permissionPromptToolName }
  )
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
  const a2uiServer = buildA2UIBridgeServer({
    sessionId,
    emit: (payload) => emit(payload as Record<string, unknown>),
    alwaysLoad: true,
  })
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
  // Plugin tool names the bundled Claude Code would rewrite for the API
  // (`ocr.extract` → `ocr_extract`), as `modelName → originalName`. Filled by
  // the server builder, consumed wherever the SDK's vocabulary meets ours:
  // the allow/deny lists below, `canUseTool`, and every streamed message.
  const pluginToolNameAliases = new Map<string, string>()
  if (Array.isArray(sendOptions.pluginTools) && sendOptions.pluginTools.length > 0) {
    const pluginToolsServer = buildPluginToolsServer(
      anthropicPluginToolBridgeOptions({
        tools: sendOptions.pluginTools,
        emit,
        sessionId,
        sandboxRuntimeRef: sendOptions.sandboxRuntimeRef,
        pendingPluginToolCalls,
        alwaysLoad: serverAlwaysLoad(PLUGIN_TOOLS_SERVER_NAME),
        alwaysLoadToolNames: alwaysLoadToolNames as Set<string>,
        remoteExecutionContext: sendOptions.remoteExecutionContext,
        turnId: sendOptions.turnId,
        attemptId: sendOptions.execution?.identity?.attemptId,
        toolNameAliases: pluginToolNameAliases,
        permissionPromptToolName: sendOptions.claudeAgentSdk?.permissionPromptToolName,
      })
    )
    if (pluginToolNameAliases.size > 0) {
      log(
        "info",
        `renamed ${pluginToolNameAliases.size} plugin tool name(s) for the model: ${[
          ...pluginToolNameAliases,
        ]
          .map(([model, original]) => `${original} → ${model}`)
          .join(", ")}`
      )
    }
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

  // The lists the SDK compares tool names against must speak its vocabulary.
  const modelAllowedTools = modelPluginToolNameList(
    pluginToolNameAliases,
    PLUGIN_TOOLS_SERVER_NAME,
    sendOptions.allowedTools
  )
  // Defence-in-depth: stamp disabled-category tool names onto disallowedTools.
  const disallowed = new Set(
    modelPluginToolNameList(
      pluginToolNameAliases,
      PLUGIN_TOOLS_SERVER_NAME,
      sendOptions.disallowedTools ?? []
    )
  )
  if (builtinEnabled !== undefined) {
    // Pass the resolvers so an enabled-but-unresolvable `lsp` / `codeGraph`
    // category is denied rather than silently absent (registration guards on
    // `flag && resolver`, so those tools would otherwise be neither served nor
    // rejected at the SDK boundary).
    // Mirror the registration guards above EXACTLY (`buildCogniaToolsServer`
    // receives these same two values) so a category is denied iff it was not
    // registered — over-denying would break a working session.
    for (const name of namesForDisabledCategories(builtinEnabled, {
      lspResolver,
      codeGraphResolver: codeGraph.codeGraphResolver,
    })) {
      disallowed.add(name)
    }
  }

  return {
    mergedMcpServers: mergedMcpServers as Options["mcpServers"],
    pluginToolNameAliases,
    modelAllowedTools,
    disallowed,
    lspEnabled,
    lspResolver,
  }
}
