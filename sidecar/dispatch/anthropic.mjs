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
import { makeInputStream } from "./input-stream.mjs"

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

  const resumeId = sendOptions.resumeSessionId ?? sendOptions.forkFromSessionId
  const isFork = sendOptions.forkFromSessionId != null

  // Built-in cognia-tools MCP server (category-toggled).
  const builtinEnabled = sendOptions.builtinTools
  const builtinServer = buildCogniaToolsServer({ enabled: builtinEnabled })
  const baseUserServers = sendOptions.mcpServers ?? {}
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

  // A2UI bridge: always-on in-process MCP server.
  const a2uiServer = buildA2UIBridgeServer({ sessionId, emit })
  const mergedMcpServers = Object.prototype.hasOwnProperty.call(withBuiltins, A2UI_SERVER_NAME)
    ? (() => {
        log(
          "warn",
          `user-defined mcp server '${A2UI_SERVER_NAME}' shadows built-in a2ui-bridge — keeping user's`
        )
        return withBuiltins
      })()
    : { ...withBuiltins, [A2UI_SERVER_NAME]: a2uiServer }

  // Defence-in-depth: stamp disabled-category tool names onto disallowedTools.
  const disallowed = new Set(sendOptions.disallowedTools ?? [])
  if (builtinEnabled !== undefined) {
    for (const name of namesForDisabledCategories(builtinEnabled)) {
      disallowed.add(name)
    }
  }

  // Allowlist construction — only fields listed below reach the SDK. This is
  // intentional: cognia-next sends a few sidecar-protocol-only fields
  // (`builtinTools`, `bareMode`, `debugMode`, `briefMode`, `aliasResolution`,
  // `routingDecision`, `provider`, `providerCredentials`) that the SDK doesn't
  // recognise. They're consumed earlier in `resolveSendOptions` (translated
  // into env / settingSources / appendSystemPrompt / etc.) or in this
  // dispatcher before this object is built (`builtinTools` → `mergedMcpServers`).
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
    env: { ...process.env, ...(sendOptions.env ?? {}) },

    canUseTool: (toolName, input, ctx) => {
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
