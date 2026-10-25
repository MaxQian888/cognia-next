// Host permission profiles and portable per-tool policies, enforced ahead of
// the Claude Agent SDK's own permission system (ADR-0224 A7).
//
// The SDK approves a call on its own before `canUseTool` is ever consulted:
// `bypassPermissions` approves everything, `acceptEdits` approves its file
// tools, and an allow rule (`allowedTools`) approves a matching tool in any
// mode. The ladder's profile steps live in `canUseTool`, so on this engine
// they would never see those calls. A PreToolUse hook runs first, in every
// mode, which is the one place the profile can hold:
//
//   - a class the profile denies is refused (a hook deny binds even under
//     `bypassPermissions`);
//   - an outbound, secret or host-configuration call asks a person through
//     the same `canUseTool` round trip the ladder would run.
//
// A hook `allow` does not stop the SDK from consulting `canUseTool` later, so
// an approval obtained here is recorded under the call's tool-use id and
// `canUseTool` honours it once instead of asking the same person twice.
//
// Outbound tools (`alwaysExplicitTools`, ADR-0239) take the same path while
// their list enforces: every call asks through `canUseTool`, in every mode.
// While it only observes, the SDK may still run a listed call without asking
// anyone (bypass, an allow rule); a PostToolUse hook reports each such call
// with an `explicit_tool_allowed` frame, unless `canUseTool` already allowed
// or reported it.

import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk"

import type { ApprovalAnswer } from "../../policy/permission/approval.ts"
import type { PermissionSendOptions } from "../../policy/permission/ladder.ts"
import { mcpToolAllowlistDenies, toolPermissionDecision } from "../../policy/permission/ladder.ts"
import {
  buildPluginClassIndex,
  explicitPolicyObserves,
  explicitToolAllowedFrame,
  explicitToolMustAsk,
  explicitToolObserved,
  profileDenialMessage,
  profileVerdict,
  readExplicitToolPolicy,
  readPermissionProfile,
} from "../../policy/permission/permission-classes.ts"
import { PLUGIN_TOOLS_SERVER_NAME } from "../../policy/tool-catalog/names.ts"
import { restorePluginToolName } from "../../policy/tool-catalog/plugin-aliases.ts"

type CanUseTool = (
  modelToolName: string,
  input: Record<string, unknown>,
  ctx: { toolUseID: string; signal?: AbortSignal }
) => Promise<ApprovalAnswer>

export interface ProfileToolHookOptions {
  sendOptions: PermissionSendOptions
  pluginToolNameAliases: Map<string, string>
  /** The session's `canUseTool`: the ladder and the approval round trip. */
  canUseTool: CanUseTool
  /** Tool-use ids a person approved here; `canUseTool` consumes each once. */
  profileApprovals: Set<string>
  /** Tool-use ids of listed calls `canUseTool` already allowed or reported. */
  explicitSeen?: Set<string>
  /** Sends the `explicit_tool_allowed` frame; required for an observed list. */
  emit?: (frame: Record<string, unknown>) => void
  sessionId?: string
}

function decision(permissionDecision: "allow" | "deny", extra: Record<string, unknown>) {
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision, ...extra },
  }
}

type ProfileHookMap = { PreToolUse: HookCallbackMatcher[]; PostToolUse?: HookCallbackMatcher[] }

/** The hooks, absent when no profile, per-tool policy or always-explicit list applies. */
export function buildProfileToolHooks({
  sendOptions,
  pluginToolNameAliases,
  canUseTool,
  profileApprovals,
  explicitSeen,
  emit,
  sessionId,
}: ProfileToolHookOptions): ProfileHookMap | undefined {
  const profile = readPermissionProfile(sendOptions.permissionProfile)
  const explicitTools = readExplicitToolPolicy(
    sendOptions.alwaysExplicitTools,
    sendOptions.alwaysExplicitToolsMode,
    sendOptions.alwaysExplicitShellWritesMode
  )
  if (
    !profile &&
    !sendOptions.toolPermissionRules &&
    !sendOptions.mcpToolAllowlist &&
    !explicitTools
  )
    return undefined
  const pluginClasses = buildPluginClassIndex(sendOptions.pluginTools)
  const restore = (modelToolName: string) =>
    restorePluginToolName(pluginToolNameAliases, PLUGIN_TOOLS_SERVER_NAME, modelToolName)
  const observing = explicitPolicyObserves(explicitTools) && typeof emit === "function"
  return {
    ...(observing
      ? {
          PostToolUse: [
            {
              hooks: [
                async (input, toolUseID) => {
                  if (!("tool_name" in input) || typeof input.tool_name !== "string") return {}
                  const toolName = restore(input.tool_name)
                  const toolInput =
                    "tool_input" in input &&
                    input.tool_input &&
                    typeof input.tool_input === "object"
                      ? input.tool_input
                      : {}
                  if (!explicitToolObserved(toolName, explicitTools, toolInput)) return {}
                  if (toolUseID && explicitSeen?.delete(toolUseID)) return {}
                  emit!(explicitToolAllowedFrame(sessionId, toolName, toolInput, toolUseID))
                  return {}
                },
              ],
            },
          ],
        }
      : {}),
    PreToolUse: [
      {
        hooks: [
          async (input, toolUseID, { signal }) => {
            if (!("tool_name" in input) || typeof input.tool_name !== "string") return {}
            const modelToolName = input.tool_name
            const toolName = restore(modelToolName)
            const verdict = profileVerdict(profile, toolName, pluginClasses)
            const toolInput =
              "tool_input" in input && input.tool_input && typeof input.tool_input === "object"
                ? (input.tool_input as Record<string, unknown>)
                : {}
            const toolPolicy = toolPermissionDecision(toolName, sendOptions.toolPermissionRules)
            // The CLI connects MCP servers itself, so a tool a mode did not
            // pick can only be stopped here, before it runs.
            if (mcpToolAllowlistDenies(toolName, sendOptions.mcpToolAllowlist)) {
              return decision("deny", {
                permissionDecisionReason: "not in this mode's MCP tool selection",
              })
            }
            if (toolPolicy === "deny") {
              return decision("deny", {
                permissionDecisionReason: "denied by tool permission policy",
              })
            }
            if (verdict.kind === "deny") {
              return decision("deny", {
                permissionDecisionReason: profileDenialMessage(toolName, verdict.cls),
              })
            }
            if (
              verdict.kind !== "always-ask" &&
              toolPolicy !== "ask" &&
              !explicitToolMustAsk(toolName, explicitTools, toolInput)
            )
              return {}
            if (!toolUseID)
              return decision("deny", {
                permissionDecisionReason: "missing tool-use id for per-call approval",
              })
            const answer = await canUseTool(modelToolName, toolInput, { toolUseID, signal })
            if (answer.behavior !== "allow") {
              return decision("deny", {
                permissionDecisionReason:
                  typeof answer.message === "string" ? answer.message : `denied: ${toolName}`,
              })
            }
            profileApprovals.add(toolUseID)
            return decision("allow", {
              permissionDecisionReason: "approved by a person for this tool call",
              ...(answer.updatedInput && typeof answer.updatedInput === "object"
                ? { updatedInput: answer.updatedInput }
                : {}),
            })
          },
        ],
      },
    ],
  }
}
