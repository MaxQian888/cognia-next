// Standalone (BYOK) tool bridge — projects the renderer-executable tool
// manifest onto AI SDK tool definitions so a phone with no paired desktop can
// still run a real agent loop.
//
// Why this is a bridge and not a new tool layer:
//
//  - `resolveSendOptions` (`lib/claude/build-options.ts`) already assembles
//    `sendOptions.pluginTools` — the full catalog of tools the sidecar proxies
//    BACK to the renderer (web_search / web_fetch, skills, slash commands,
//    editor, team, and every plugin-registered tool), each carrying a name, a
//    description, and a JSON Schema.
//  - `handlePluginToolExec` (`lib/claude/plugin-tool-ipc.ts`) already executes
//    exactly that catalog in the renderer, behind the `@cognia/redact` PII gate
//    and the per-plugin rate limiter.
//  - `createSdkEventMapper` already maps AI SDK `tool-call` / `tool-result` /
//    `tool-error` / `start-step` / `finish-step` parts onto the renderer's
//    `tool_use` / `tool_result` envelopes.
//
// All three halves existed; `runStandaloneTurn` was simply never handed a
// `tools` map. This module is the missing wire, so standalone mode inherits the
// same catalog, the same executor, and the same PII gate as the paired path
// rather than growing a parallel one.
//
// Platform boundary: tools whose renderer handler needs the desktop (Pro IDE
// editor reads, the terminal dock's PTY) only enter `pluginTools` when
// `resolveSendOptions` enables that capability, so a phone simply never sees
// them. If one does slip through, its handler throws and the failure surfaces
// as a labelled `tool-error` block — never a silent no-op.

import { jsonSchema, tool, type ToolSet } from "ai"

import type { SendOptions } from "@cognia/agent-config-types"
import { handlePluginToolExec } from "@/lib/claude/plugin-tool-ipc"

/**
 * Step ceiling for a standalone turn.
 *
 * The sidecar path has the Agent SDK's own budget; here the loop is ours to
 * bound. Eight steps is enough for the search → fetch → answer shapes BYOK
 * mode is actually used for, while keeping a mis-prompted model from burning a
 * phone's battery and the user's own API credits in a runaway loop.
 */
export const STANDALONE_MAX_STEPS = 8

/**
 * Providers constrain tool names to `[a-zA-Z0-9_-]{1,128}`. A plugin is free to
 * register something outside that set, and sending it produces a provider-side
 * 400 that fails the WHOLE turn rather than the one tool. Dropping the entry is
 * the only behaviour that keeps the rest of the catalog usable.
 */
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/

export function isUsableStandaloneToolName(name: string): boolean {
  return VALID_TOOL_NAME.test(name)
}

export interface StandaloneToolsResult {
  tools: ToolSet
  /** Names dropped for an unusable identifier — surfaced so callers can log. */
  rejected: string[]
}

/**
 * Build the AI SDK tool map for one standalone turn.
 *
 * Returns `undefined` when the turn has no usable tools so the caller can omit
 * `tools`/`stopWhen` entirely and keep the single-shot completion path
 * byte-identical to what shipped before.
 */
export function buildStandaloneTools(
  sendOptions: Pick<SendOptions, "pluginTools">,
  sessionId: string
): StandaloneToolsResult | undefined {
  const entries = sendOptions.pluginTools
  if (!entries || entries.length === 0) return undefined

  const tools: ToolSet = {}
  const rejected: string[] = []

  for (const entry of entries) {
    if (!isUsableStandaloneToolName(entry.name)) {
      rejected.push(entry.name)
      continue
    }
    // First registration wins — `resolveSendOptions` appends several manifest
    // sources and the promoted built-ins are meant to supersede a plugin's
    // duplicate of the same name, matching `handlePluginToolExec`'s own
    // resolution order.
    if (entry.name in tools) continue

    tools[entry.name] = tool({
      description: entry.description,
      inputSchema: jsonSchema(entry.jsonSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (args, options) => {
        const response = await handlePluginToolExec({
          type: "plugin_tool_exec",
          sessionId,
          toolUseId: options.toolCallId,
          name: entry.name,
          args: (args ?? {}) as Record<string, unknown>,
        })
        // `handlePluginToolExec` never throws — it reports failure on `error`.
        // Rethrowing turns it into an AI SDK `tool-error` part, which the event
        // mapper already renders as a failed tool block and the model can react
        // to on the next step.
        if (response.error) throw new Error(response.error)
        return response.result
      },
    })
  }

  const names = Object.keys(tools)
  if (names.length === 0) return undefined
  return { tools, rejected }
}
