// AI SDK tool bridge for the non-Anthropic dispatch path.
//
// The Anthropic dispatcher hands built-in tools + plugin tools to the Claude
// Agent SDK as in-process MCP servers. The AI SDK has no MCP-server concept for
// `streamText`, so we convert the SAME built-in tool definitions (and the
// renderer-proxied plugin tools) into native AI SDK `tool()` objects keyed by
// name. This is what lets local / OpenAI / Gemini models actually call tools in
// the main chat — previously the ai-sdk path was text-only.
//
// Tool execution runs through a permission gate that mirrors the Anthropic
// path's `canUseTool` (ADR-0043 Phase A): suppress-list + static ruleset
// short-circuit, otherwise a `permission_request` round-trip resolved via
// `pendingApprovals` — so a local model can't silently run shell/process tools.

import { tool, jsonSchema } from "ai"
import { z } from "zod"
import { randomUUID } from "node:crypto"

import {
  collectCogniaToolDefs,
  SERVER_NAME,
  READ_ONLY_TOOL_NAMES,
} from "../builtin-tools/index.mjs"
import { EXIT_PLAN_TOOL_NAME } from "../builtin-tools/exit-plan.mjs"
import { awaitPluginToolResponse } from "../builtin-tools/plugin-tools.mjs"
import { resolveForToolCall } from "./permission-resolver.mjs"
import { createDoomLoopGuard } from "./doom-loop.mjs"

const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"

/** Flatten an MCP `CallToolResult` to a plain string for the model. */
function callToolResultToText(result) {
  if (result == null) return ""
  if (typeof result === "string") return result
  if (Array.isArray(result.content)) {
    return result.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
  }
  return JSON.stringify(result)
}

/**
 * Build a permission gate for tool execution. Returns `async (toolName, input)
 * => effectiveInput` that resolves with the (possibly updated) input when
 * allowed and THROWS when denied. Mirrors `anthropic.mjs:canUseTool`.
 *
 * `toolName` should be the namespaced form (`mcp__<server>__<name>`) so it
 * matches the user's suppress list / ruleset globs / always-allow conventions.
 */
export function createToolPermissionGate({
  emit,
  sessionId,
  pendingApprovals,
  sendOptions,
  doomGuard,
}) {
  const ruleset = sendOptions?.permissionRuleset
  const suppress = Array.isArray(sendOptions?.suppressApprovalForTools)
    ? sendOptions.suppressApprovalForTools
    : null
  const alwaysAllow = Array.isArray(sendOptions?.alwaysAllowTools)
    ? sendOptions.alwaysAllowTools
    : null
  const canPrompt = typeof emit === "function" && pendingApprovals instanceof Map

  return async function gate(toolName, input) {
    // Read the permission mode LIVE (not closed-over): a `claude_set_mode`
    // control message mutates `sendOptions.permissionMode` on the running
    // session, and the next tool gate must honour it without a respawn.
    const mode = sendOptions?.permissionMode

    // Doom-loop guard: the Nth identical call must round-trip through the
    // user even when a suppress-list / ruleset (or bypass mode) would allow it
    // silently. Computed FIRST so even bypassPermissions can't disarm the
    // runaway-loop protection.
    const doomed = doomGuard ? doomGuard.check(toolName, input) === "ask" : false

    // Plan mode: enforce read-only here on the AI-SDK path (the Anthropic path
    // gets this from the SDK). Only read-only built-in tools — plus the
    // `exit_plan_mode` signal tool the model uses to submit its final plan —
    // may run; every mutating/exec built-in, plugin tool, or unknown tool is
    // denied, so a non-Anthropic provider in plan mode can't write/edit/bash.
    if (mode === "plan") {
      const parts = String(toolName).split("__")
      const server = parts.length >= 3 ? parts[1] : null
      const bare = parts.length >= 3 ? parts.slice(2).join("__") : String(toolName)
      const allowed =
        server === SERVER_NAME && (READ_ONLY_TOOL_NAMES.has(bare) || bare === EXIT_PLAN_TOOL_NAME)
      if (!allowed) {
        throw new Error(`plan mode: tool "${toolName}" is not permitted (read-only tools only)`)
      }
      return input
    }

    // bypassPermissions skips approvals — but NOT the doom guard above.
    if (mode === "bypassPermissions" && !doomed) return input

    if (!doomed) {
      if (suppress && suppress.includes(toolName)) return input
      if (alwaysAllow && alwaysAllow.includes(toolName)) return input
    }

    if (ruleset && !doomed) {
      let verdict
      try {
        verdict = resolveForToolCall(ruleset, toolName, input)
      } catch {
        verdict = undefined // resolver error → fall through to the prompt
      }
      if (verdict === "allow") return input
      if (verdict === "deny") throw new Error(`denied by permission ruleset: ${toolName}`)
    }

    // No channel to prompt the user (e.g. headless) → fail-open, matching the
    // pre-gate behaviour rather than hard-blocking every tool.
    if (!canPrompt) return input

    const requestId = randomUUID()
    emit({
      type: "permission_request",
      sessionId,
      requestId,
      toolName,
      displayName: toolName,
      input,
    })
    const decision = await new Promise((resolve) => {
      pendingApprovals.set(requestId, { resolve })
    })
    if (decision && decision.behavior === "deny") {
      throw new Error(decision.message ?? `denied: ${toolName}`)
    }
    return decision && decision.updatedInput !== undefined ? decision.updatedInput : input
  }
}

/**
 * Convert one built-in `SdkMcpToolDefinition` into an AI SDK tool. The built-in
 * handler returns an MCP `CallToolResult`; we flatten it to text and re-throw on
 * `isError` so the AI SDK surfaces a `tool-error` (which the model can recover
 * from across steps). Execution is gated through `gate` when supplied.
 */
function builtinDefToAiSdkTool(def, gate) {
  const namespaced = `mcp__${SERVER_NAME}__${def.name}`
  return tool({
    description: def.description ?? "",
    inputSchema: z.object(def.inputSchema ?? {}),
    execute: async (args) => {
      const effective = gate ? await gate(namespaced, args ?? {}) : (args ?? {})
      const result = await def.handler(effective, {})
      const text = callToolResultToText(result)
      if (result && result.isError) throw new Error(text || `${def.name} failed`)
      return text
    },
  })
}

/**
 * Convert a plugin tool manifest entry into an AI SDK tool whose `execute`
 * round-trips through the renderer over stdio: it emits `plugin_tool_exec` and
 * awaits a `plugin_tool_response` resolved via `pendingPluginToolCalls` (the
 * same Map claude-host populates for the Anthropic path). Execution is gated.
 */
function pluginToolToAiSdkTool(manifest, { emit, sessionId, pendingPluginToolCalls, gate }) {
  const namespaced = `mcp__${PLUGIN_TOOLS_SERVER_NAME}__${manifest.name}`
  return tool({
    description: manifest.description ?? "",
    inputSchema: jsonSchema(manifest.jsonSchema ?? { type: "object", properties: {} }),
    execute: async (args) => {
      const effective = gate ? await gate(namespaced, args ?? {}) : (args ?? {})
      const toolUseId = randomUUID()
      const pending = awaitPluginToolResponse(pendingPluginToolCalls, toolUseId, manifest.name)
      emit({
        type: "plugin_tool_exec",
        sessionId,
        toolUseId,
        name: manifest.name,
        args: effective,
      })
      const response = await pending
      if (response && response.error) throw new Error(String(response.error))
      const payload = response ? response.result : null
      return typeof payload === "string" ? payload : JSON.stringify(payload ?? null)
    },
  })
}

/**
 * Build the AI SDK `tools` map for a turn: built-in tools gated by enabled
 * categories (`sendOptions.builtinTools`) plus any renderer-proxied plugin
 * tools (`sendOptions.pluginTools`). Returns `{}` when nothing is available, so
 * the dispatcher can omit the `tools` option entirely.
 *
 * @param {{
 *   sendOptions: Record<string, any>,
 *   emit: (msg: any) => void,
 *   sessionId: string,
 *   pendingApprovals?: Map<string, { resolve: (r: any) => void }>,
 *   pendingPluginToolCalls?: Map<string, { resolve: (r: any) => void }>,
 *   lspResolver?: unknown,
 *   readTracker?: unknown,
 * }} params
 * @returns {Record<string, ReturnType<typeof tool>>}
 */
export function buildAiSdkTools({
  sendOptions,
  emit,
  sessionId,
  pendingApprovals,
  pendingPluginToolCalls,
  lspResolver,
  readTracker,
}) {
  /** @type {Record<string, ReturnType<typeof tool>>} */
  const tools = {}
  const doomGuard = createDoomLoopGuard()
  const gate = createToolPermissionGate({
    emit,
    sessionId,
    pendingApprovals,
    sendOptions,
    doomGuard,
  })

  // Deny-list enforcement. The Anthropic path delegates allowed/disallowed
  // tool filtering to the agent SDK; `streamText` has no such concept, so the
  // bridge must honour `disallowedTools` itself — restricted mode (untrusted
  // workspace) and the IM-channel blacklist both arrive through it. Entries
  // may be bare (`bash`) or namespaced (`mcp__cognia-tools__bash`).
  const disallowed = new Set(
    Array.isArray(sendOptions.disallowedTools) ? sendOptions.disallowedTools : []
  )
  const isDisallowed = (bareName) =>
    disallowed.has(bareName) || disallowed.has(`mcp__${SERVER_NAME}__${bareName}`)

  for (const def of collectCogniaToolDefs({
    enabled: sendOptions.builtinTools,
    lspResolver,
    readTracker,
    cwd: sendOptions.cwd,
    dispatchPath: "ai-sdk",
  })) {
    if (def && def.name && !isDisallowed(def.name)) {
      tools[def.name] = builtinDefToAiSdkTool(def, gate)
    }
  }

  if (Array.isArray(sendOptions.pluginTools) && pendingPluginToolCalls) {
    for (const manifest of sendOptions.pluginTools) {
      if (!manifest || !manifest.name) continue
      if (
        disallowed.has(manifest.name) ||
        disallowed.has(`mcp__${PLUGIN_TOOLS_SERVER_NAME}__${manifest.name}`)
      ) {
        continue
      }
      tools[manifest.name] = pluginToolToAiSdkTool(manifest, {
        emit,
        sessionId,
        pendingPluginToolCalls,
        gate,
      })
    }
  }

  // Rebuild in sorted-key order so the tools map serializes identically
  // across turns/sessions — built-in registry and pluginTools arrive in
  // registration order, and an unstable order silently breaks provider
  // prompt-cache prefix matching.
  /** @type {Record<string, ReturnType<typeof tool>>} */
  const sorted = {}
  for (const name of Object.keys(tools).sort()) sorted[name] = tools[name]
  return sorted
}

export const __testing__ = { builtinDefToAiSdkTool, pluginToolToAiSdkTool, callToolResultToText }
