// Delegated approval on the Claude Agent SDK rail.
//
// With `permissionPromptToolName` set, the SDK asks an MCP tool instead of
// calling `canUseTool`. Cognia's hard authority must still hold there, so it
// moves into PreToolUse hooks: every existing hook is wrapped to deny first,
// re-check any input the hook rewrites, and lose its power to pre-approve;
// a final hook applies the same checks to calls no other hook matched.

import { PLUGIN_TOOLS_SERVER_NAME } from "../tool-catalog/names.ts"
import { restorePluginToolName } from "../tool-catalog/plugin-aliases.ts"
import type { PermissionSendOptions } from "./ladder.ts"
import { anthropicToolDenial } from "./sdk-can-use-tool.ts"

/** The PreToolUse hook input fields this wrapper reads. */
export interface PreToolUseInput {
  tool_name: string
  tool_input?: unknown
  [field: string]: unknown
}

export interface HookContext {
  signal: AbortSignal
}

export interface HookOutput {
  hookSpecificOutput?: {
    permissionDecision?: unknown
    permissionDecisionReason?: unknown
    updatedInput?: unknown
    [field: string]: unknown
  }
  [field: string]: unknown
}

export type PreToolUseHook = (
  input: PreToolUseInput,
  id: string | undefined,
  context: HookContext
) => Promise<HookOutput | undefined> | HookOutput | undefined

export interface HookMatcher {
  hooks: PreToolUseHook[]
  [field: string]: unknown
}

/** The Agent SDK options this rewrites. */
export interface DelegatingSdkOptions {
  permissionPromptToolName?: string
  mcpServers?: Record<string, unknown>
  hooks?: { PreToolUse?: HookMatcher[]; [event: string]: unknown }
  canUseTool?: unknown
  [option: string]: unknown
}

/** Keep Cognia authority without bypassing the SDK's configured permission delegate. */
export function enforceAnthropicPermissionChannel(
  options: DelegatingSdkOptions,
  sendOptions: PermissionSendOptions = {},
  aliases?: ReadonlyMap<string, string> | null
): DelegatingSdkOptions {
  const promptTool = options.permissionPromptToolName
  if (!promptTool) return options
  if (
    options.mcpServers &&
    !Object.keys(options.mcpServers).some((name) => promptTool.startsWith(`mcp__${name}__`))
  )
    throw new Error(
      "Permission prompt tool must belong to a managed MCP server so delegated input remains policy-checked"
    )
  const denial = (
    input: PreToolUseInput,
    signal: AbortSignal,
    updatedInput: unknown = input.tool_input
  ): HookOutput | undefined => {
    const toolName = restorePluginToolName(aliases, PLUGIN_TOOLS_SERVER_NAME, input.tool_name)
    const reason = anthropicToolDenial(sendOptions, toolName, updatedInput, signal)
    return reason
      ? {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }
      : undefined
  }
  const previous = options.hooks?.PreToolUse ?? []
  options.hooks = {
    ...options.hooks,
    PreToolUse: [
      ...previous.map((matcher) => ({
        ...matcher,
        hooks: matcher.hooks.map((hook): PreToolUseHook => async (input, id, context) => {
          const blocked = denial(input, context.signal)
          if (blocked) return blocked
          const result = await hook(input, id, context)
          const updatedInput = result?.hookSpecificOutput?.updatedInput
          const rewrittenDenial =
            updatedInput !== undefined && denial(input, context.signal, updatedInput)
          if (rewrittenDenial) return rewrittenDenial
          // An existing allow hook must not short-circuit the configured delegate.
          if (result?.hookSpecificOutput?.permissionDecision === "allow") {
            const {
              permissionDecision: _decision,
              permissionDecisionReason: _reason,
              ...rest
            } = result.hookSpecificOutput
            return { ...result, hookSpecificOutput: rest }
          }
          return result
        }),
      })),
      { hooks: [async (input, _id, context) => denial(input, context.signal) ?? {}] },
    ],
  }
  delete options.canUseTool
  return options
}
