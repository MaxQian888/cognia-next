// The Claude Agent SDK rail's view of the built-in tools: one in-process SDK
// MCP server carrying the session's assembled definitions.
//
// `buildCogniaToolsServer` returns either:
//   - `null` when no categories are enabled (the caller skips registration)
//   - an `McpSdkServerConfigWithInstance` ready to be merged into the
//     `mcpServers` field of the SDK's `query()` options.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk/core"
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk"

import type { ToolDefinition, ToolHandlerExtra, WrappedToolDefinition } from "../kernel/define.ts"
import { collectCogniaToolDefs } from "../builtin/registry.ts"
import type { CollectToolDefsOptions } from "../builtin/registry.ts"
import {
  DEFAULT_BUILTIN_TOOL_TIMEOUT_MS,
  wrapDefsWithReadOnlyTimeout,
} from "../middleware/read-only-timeout.ts"
import { wrapDefsWithResultCap } from "../middleware/result-cap.ts"
import {
  BUILTIN_SERVER_NAME,
  BUILTIN_SERVER_VERSION,
  READ_ONLY_TOOL_NAMES,
} from "../../policy/tool-catalog/catalog.ts"
import { assertModelSafeToolOutput } from "../../policy/pii/tool-output.ts"

export interface BuildToolsServerOptions extends CollectToolDefsOptions {
  /**
   * When true, every tool from this server is kept resident in the prompt and
   * never deferred behind tool search (claude-agent-sdk
   * `createSdkMcpServer({ alwaysLoad })`, equivalent to the API's
   * `defer_loading: false`). When false/omitted and the CLI's tool search is
   * active, this server's tools defer until discovered.
   */
  alwaysLoad?: boolean | undefined
  /** Read-only tool deadline; `0` disables it, absent means the default. */
  toolExecutionTimeoutMs?: number | undefined
  /** Result-text budget; no cap unless the renderer resolved one. */
  maxToolResultTokens?: number | undefined
}

/** Build the in-process SDK MCP server, or `null` when it would carry no tools. */
export function buildCogniaToolsServer(options: BuildToolsServerOptions) {
  const { enabled, alwaysLoad, toolExecutionTimeoutMs, maxToolResultTokens } = options
  if (!enabled || typeof enabled !== "object") return null
  const tools = collectCogniaToolDefs(options)
  if (tools.length === 0) return null
  // Per-tool execution deadline for READ-ONLY built-ins (see
  // `src/tools/middleware/read-only-timeout.ts`). The Anthropic SDK calls each
  // tool's handler itself, so we wrap the handler at registration time —
  // mirroring the execute-time net the ai-sdk bridge applies
  // (`adapters/ai-sdk.ts`). Honour an explicit override (incl. `0` to
  // disable); default the safety net otherwise so a hung read-only tool can't
  // wedge the whole turn.
  const net =
    typeof toolExecutionTimeoutMs === "number"
      ? toolExecutionTimeoutMs
      : DEFAULT_BUILTIN_TOOL_TIMEOUT_MS
  const guarded = wrapDefsWithReadOnlyTimeout(tools, net, READ_ONLY_TOOL_NAMES)
  // Cap oversized tool-result TEXT bodies so a huge bash/grep/read output can't
  // bloat the Anthropic context window (parity with the ai-sdk compaction cap).
  // No-op unless the renderer resolved a `maxToolResultTokens` budget.
  const capped = wrapDefsWithResultCap(guarded, maxToolResultTokens)
  return createSdkMcpServer({
    name: BUILTIN_SERVER_NAME,
    version: BUILTIN_SERVER_VERSION,
    // The definitions are the SDK's own shape (see kernel/define.ts); only the
    // handler signature was widened by the middleware.
    tools: wrapNativeToolResults(capped) as unknown as SdkMcpToolDefinition[],
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
  })
}

/** Native MCP results cross the same PII gate as AI SDK results. */
export function wrapNativeToolResults<D extends ToolDefinition>(
  definitions: readonly D[]
): WrappedToolDefinition<D>[] {
  return definitions.map((definition) => ({
    ...definition,
    handler: async (args: unknown, extra?: ToolHandlerExtra) =>
      assertModelSafeToolOutput(await definition.handler(args, extra)),
  }))
}
