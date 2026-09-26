// Synthetic `cognia-plugin-tools` in-process MCP server (M2).
//
// Mirrors the shape of the cognia-tools builtin server but instead of running
// tools locally, every call here proxies back to the
// renderer process over the parent stdio protocol. The dispatcher builds
// one of these servers per session when the renderer has surfaced a
// non-empty `pluginTools` manifest in SendOptions.
//
// Wire protocol — sidecar → parent:
//   { type: "plugin_tool_exec", sessionId, turnId?, attemptId?, toolUseId, name, args }
// Wire protocol — parent → sidecar (via claude-host.mjs):
//   { type: "plugin_tool_response", sessionId, toolUseId, result?, error? }
//
// The pending-promise map lives on the session object so concurrent tool
// calls don't trample each other and the parent can resolve them via the
// `toolUseId` key.

import { randomUUID } from "node:crypto"

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

import { permissionDecisionHasUnprovenRewrite } from "../../policy/permission/delegated-approval.ts"
import { planPluginToolNames } from "../../policy/tool-catalog/plugin-aliases.ts"
import { PLUGIN_TOOLS_SERVER_NAME } from "../../policy/tool-catalog/names.ts"
import { toolError, toolText } from "../kernel/result.ts"
import { jsonSchemaToZodShape } from "./json-schema-zod.ts"

export const SERVER_NAME = PLUGIN_TOOLS_SERVER_NAME
export const SERVER_VERSION = "0.1.0"

const DEFAULT_PLUGIN_TOOL_TIMEOUT_MS = 120_000

/** One entry of the renderer's plugin tool manifest. */
export interface PluginToolManifestEntry {
  name: string
  description?: string | undefined
  /** The tool's arguments as JSON Schema; converted to a zod shape for `tool()`. */
  jsonSchema?: unknown
  pluginId?: string | undefined
  /** Per-tool timeout override; `0` means no timeout. */
  timeoutMs?: unknown
}

/** What the renderer answers a `plugin_tool_exec` with. */
export interface PluginToolResponse {
  result?: unknown
  error?: string
}

/** Pending calls keyed by toolUseId; the host resolves them on `plugin_tool_response`. */
export type PendingPluginToolCalls = Map<
  string,
  { resolve: (response: PluginToolResponse) => void }
>

/**
 * True when a plugin tool returned a ready MCP `CallToolResult` rather than a
 * plain value. Plugin results otherwise get `JSON.stringify`-ed into a single
 * text block, which makes it *structurally impossible* for a plugin tool to
 * return an image / audio / embedded resource — the model would only ever see
 * base64 text, and the chat would only ever render a wall of it. Built-in tools
 * already return this shape (see `toolImage` in ../kernel/result.ts), so the
 * check is the same one the built-in path relies on.
 */
export function isCallToolResult(result: unknown): result is CallToolResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false
  const content = (result as { content?: unknown }).content
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (b: unknown) =>
        !!b && typeof b === "object" && typeof (b as { type?: unknown }).type === "string"
    )
  )
}

/**
 * Register a resolver for `toolUseId` in `pending` and return a promise that
 * settles when the renderer writes the matching `plugin_tool_response` (resolved
 * by `claude-host.mjs:handlePluginToolResponse` via the registered `{ resolve }`),
 * OR after `timeoutMs` with an error envelope. The timeout is the agent-loop
 * safety net: a stalled / closed renderer must surface a clean tool error rather
 * than hang the SDK turn forever. The resolver is registered SYNCHRONOUSLY so the
 * caller can `emit` the request immediately after calling this.
 *
 * A `timeoutMs <= 0` (or non-finite) disables the timer entirely — for tools
 * that legitimately block on a human (`ask_user`) or run their own bounded long
 * task (`dispatch_agent`), where a fixed safety-net timeout would sever a call
 * that is still perfectly valid.
 *
 * `name` is the bare tool name, for the timeout message.
 */
export function awaitPluginToolResponse(
  pending: PendingPluginToolCalls,
  toolUseId: string,
  name: string,
  timeoutMs: number = DEFAULT_PLUGIN_TOOL_TIMEOUT_MS
): Promise<PluginToolResponse> {
  return new Promise((resolve) => {
    const noTimeout = !Number.isFinite(timeoutMs) || timeoutMs <= 0
    const timer = noTimeout
      ? null
      : setTimeout(() => {
          pending.delete(toolUseId)
          resolve({ error: `plugin tool '${name}' timed out after ${timeoutMs}ms` })
        }, timeoutMs)
    if (timer && typeof timer.unref === "function") timer.unref()
    pending.set(toolUseId, {
      resolve: (r) => {
        if (timer) clearTimeout(timer)
        pending.delete(toolUseId)
        resolve(r)
      },
    })
  })
}

export interface PluginToolsServerOptions {
  /**
   * Plugin tool manifest forwarded from the renderer. The `execute` function
   * is intentionally absent — functions don't cross the stdio boundary, so we
   * synthesize one here that proxies back over IPC.
   */
  tools: readonly PluginToolManifestEntry[] | null | undefined
  /** sidecar → parent stdout writer. */
  emit: (frame: Record<string, unknown>) => void
  /** Session id, used to scope responses. */
  sessionId: string
  sandboxRuntimeRef?: unknown
  /**
   * Pending-promise map keyed by toolUseId. The parent resolves entries here
   * when it receives the matching plugin_tool_response.
   */
  pendingPluginToolCalls: PendingPluginToolCalls
  /**
   * Server-level always-load — when true every plugin tool stays resident
   * (never deferred behind tool search). Mirrors `createSdkMcpServer({ alwaysLoad })`.
   */
  alwaysLoad?: boolean | undefined
  /**
   * Per-tool always-load allowlist (bare names). Tools whose name is in this
   * set are pinned resident even when the server defers the rest — applied via
   * `tool({ alwaysLoad })`, which the SDK OR's with the server-level flag.
   */
  alwaysLoadToolNames?: ReadonlySet<string> | Iterable<string> | null | undefined
  remoteExecutionContext?: unknown
  turnId?: string | undefined
  attemptId?: string | undefined
  /**
   * Filled with `modelName → originalName` for every tool whose manifest name
   * the bundled Claude Code would rewrite for the API (`ocr.extract` registers
   * as `ocr_extract`). The renderer, the permission lists and the
   * `plugin_tool_exec` round-trip keep the original name, so the dispatcher
   * uses this table to translate at the SDK boundary.
   */
  toolNameAliases?: Map<string, string> | null | undefined
  permissionPromptToolName?: string | undefined
}

/**
 * Build an in-process MCP server that proxies tool calls back to the
 * renderer process via the existing claude-host stdio protocol.
 */
export function buildPluginToolsServer({
  tools,
  emit,
  sessionId,
  sandboxRuntimeRef,
  pendingPluginToolCalls,
  alwaysLoad,
  alwaysLoadToolNames,
  remoteExecutionContext,
  turnId,
  attemptId,
  toolNameAliases,
  permissionPromptToolName,
}: PluginToolsServerOptions): McpSdkServerConfigWithInstance | null {
  if (!Array.isArray(tools) || tools.length === 0) return null
  if (!hasNoLeakingPiiDeep(tools)) throw new Error("Plugin tool metadata blocked by the PII gate")

  const perToolAlways: ReadonlySet<string> =
    alwaysLoadToolNames instanceof Set ? alwaysLoadToolNames : new Set(alwaysLoadToolNames ?? [])

  // Register the model-facing name ourselves, with the same replacement Claude
  // Code applies, so the alias table is exact rather than a guess about what
  // the SDK will do to the name downstream.
  const { modelNameOf, aliases } = planPluginToolNames(tools)
  if (toolNameAliases instanceof Map) {
    for (const [model, original] of aliases) toolNameAliases.set(model, original)
  }

  const wrappedTools = tools.map((t) => {
    const zodShape = jsonSchemaToZodShape(t.jsonSchema)
    const toolExtras = perToolAlways.has(t.name) ? { alwaysLoad: true } : undefined
    return tool(
      modelNameOf.get(t.name) ?? t.name,
      t.description ?? "",
      zodShape,
      async (args): Promise<CallToolResult> => {
        const toolUseId = randomUUID()
        // Honor a per-tool timeout override from the manifest (`t.timeoutMs`);
        // `0` means "no timeout" for human-blocking / long-running tools.
        const pending = awaitPluginToolResponse(
          pendingPluginToolCalls,
          toolUseId,
          t.name,
          typeof t.timeoutMs === "number" ? t.timeoutMs : undefined
        )
        emit({
          type: "plugin_tool_exec",
          sessionId,
          toolUseId,
          name: t.name,
          args,
          ...(turnId ? { turnId } : {}),
          ...(attemptId ? { attemptId } : {}),
          ...(sandboxRuntimeRef ? { sandboxRuntimeRef } : {}),
          ...(remoteExecutionContext ? { remoteExecutionContext } : {}),
        })
        const response = await pending
        if (response && response.error) {
          return toolError(response.error, "plugin tool")
        }
        const result = response?.result ?? null
        if (
          permissionPromptToolName ===
            `mcp__${SERVER_NAME}__${modelNameOf.get(t.name) ?? t.name}` &&
          permissionDecisionHasUnprovenRewrite(result, args.input)
        )
          return toolError(
            "Permission delegate cannot rewrite tool input after policy validation",
            "plugin tool"
          )
        if (!hasNoLeakingPiiDeep(result))
          return toolError("Plugin tool result blocked by the PII gate", "plugin tool")
        // A plugin that already speaks MCP (image / audio / resource blocks)
        // passes through untouched; everything else keeps the JSON-text shape.
        return isCallToolResult(result) ? result : toolText(result)
      },
      toolExtras
    )
  })

  return createSdkMcpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools: wrappedTools,
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
  })
}
