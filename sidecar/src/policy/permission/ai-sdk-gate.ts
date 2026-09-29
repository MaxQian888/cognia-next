// The ai-sdk rail's permission gate (ADR-0043 Phase A).
//
// `streamText` has no provider-side permission modes, so this rail climbs the
// full ladder: plan, dontAsk and bypassPermissions are emulated here, and a
// gate with no way to ask the user lets only read-only built-ins through. The
// gate resolves with the input to run and throws to deny, which the AI SDK
// surfaces as a `tool-error` the model can recover from.

import { randomUUID } from "node:crypto"

import { buildPluginAccessMap } from "../confinement/classify.ts"
import type { DoomLoopGuard } from "../doom-loop.ts"
import { BUILTIN_SERVER_NAME } from "../tool-catalog/catalog.ts"
import { PLUGIN_TOOLS_SERVER_NAME, splitToolName } from "../tool-catalog/names.ts"
import { awaitApproval } from "./approval.ts"
import type { PendingApproval } from "./approval.ts"
import {
  buildApprovalRequiredSet,
  buildPerCallApprovalSet,
  decidePermission,
  requiresPerCallApproval,
} from "./ladder.ts"
import type { DenyReason, PermissionSendOptions, RailProfile } from "./ladder.ts"

/**
 * Built-in file-edit-class tools auto-approved in `acceptEdits` mode — the
 * write/edit family a user who "accepted edits" implicitly trusts. Mirrors the
 * Anthropic SDK's native `acceptEdits` and the ACP client's edit auto-approval
 * (`lib/ai/agent/external/runtimes/acp/acp-client.ts`) so the AI-SDK path stops prompting for
 * every edit. DELIBERATELY excludes exec/process/git-mutation tools (bash,
 * shell, start_process, git_commit, …) — those
 * still route through the normal approval policy. Read-only tools are already
 * auto-approved upstream, so they aren't listed here. */
const ACCEPT_EDITS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "multi_edit",
  "apply_patch",
  "NotebookEdit",
  "file_append",
  "file_binary_write",
  "directory_create",
  "file_copy",
  "file_move",
  "file_rename",
])

/** The first-party sandboxed-tools plugin's file editors. */
const ACCEPT_EDITS_PLUGIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "sandbox_write",
  "sandbox_edit",
  "sandbox_text_editor",
])

export const AI_SDK_RAIL: RailProfile = {
  steps: [
    "interrupted",
    // Explicit policy decisions precede every mode and remembered grant.
    "ruleset",
    "sandbox-scope",
    "ask-user",
    // Consulted before the modes so even bypassPermissions cannot disarm the
    // runaway-loop protection.
    "doom",
    // A credential-path write is denied in every mode, bypass included.
    "credential-path",
    "plan-mode-emulated",
    "dont-ask",
    // "auto" is not special-cased: it asks, and the renderer's Layer-B
    // auto-mode runner answers instead of a human (ADR-0041).
    "bypass",
    "grants",
    "approval-channel",
  ],
  confinementErrors: "ignore",
  acceptsEdit(toolName) {
    const { server, bare } = splitToolName(toolName)
    return (
      (server === BUILTIN_SERVER_NAME && ACCEPT_EDITS_TOOL_NAMES.has(bare)) ||
      (server === PLUGIN_TOOLS_SERVER_NAME && ACCEPT_EDITS_PLUGIN_TOOL_NAMES.has(bare))
    )
  },
}

/** The error a denied call throws; a sandbox-scope refusal rethrows its own error. */
function denialError(reason: DenyReason, toolName: string): unknown {
  switch (reason.code) {
    case "interrupted":
      return new Error(`denied: tool call interrupted: ${toolName}`)
    case "input-pii":
      return new Error("tool input blocked by the PII gate")
    case "ruleset":
      return new Error(`denied by permission ruleset: ${toolName}`)
    case "sandbox-scope":
      return reason.error
    case "plan-mode":
      return new Error(`plan mode: tool "${toolName}" is not permitted (read-only tools only)`)
    case "credential-path":
      return new Error(
        `denied: "${toolName}" resolves into a protected credential path (workspace confinement)`
      )
    case "dont-ask":
      return new Error(
        `dontAsk mode: tool "${toolName}" is not pre-approved (no allow rule), so it was denied without prompting. Proceed without it, or ask the user to add an allow rule or switch permission modes.`
      )
    case "no-approval-channel":
      // Headless callers that need more opt in explicitly with
      // bypassPermissions, a suppress entry, an always-allow grant or an allow
      // rule; the ladder has already tried all of them.
      return new Error(
        `denied: no approval channel to authorize "${toolName}" — set bypassPermissions or an allow rule to run tools in a headless context`
      )
  }
}

export interface ToolPermissionGateOptions {
  emit?: ((frame: Record<string, unknown>) => void) | undefined
  sessionId?: string | undefined
  pendingApprovals?: Map<string, PendingApproval> | undefined
  sendOptions?: PermissionSendOptions | undefined
  doomGuard?: Pick<DoomLoopGuard, "check"> | null | undefined
}

export type ToolPermissionGate = (
  toolName: string,
  input: unknown,
  signal?: AbortSignal
) => Promise<unknown>

/**
 * Build the gate for one session. `toolName` is the namespaced form
 * (`mcp__<server>__<name>`) so it matches the suppress list, ruleset globs and
 * always-allow grants. `signal` is the step's abort signal: it settles a
 * pending approval as denied so a renderer that never answers cannot hang the
 * `streamText` leg.
 *
 * The permission mode, confinement, sandbox scope and cwd are read on every
 * call, so a `claude_set_mode` takes effect on the next tool call. The ruleset
 * and the grant lists are the ones the session started with.
 */
export function createToolPermissionGate({
  emit,
  sessionId,
  pendingApprovals,
  sendOptions,
  doomGuard,
}: ToolPermissionGateOptions): ToolPermissionGate {
  const ruleset = sendOptions?.permissionRuleset
  const suppress = Array.isArray(sendOptions?.suppressApprovalForTools)
    ? (sendOptions.suppressApprovalForTools as unknown[])
    : null
  const alwaysAllow = Array.isArray(sendOptions?.alwaysAllowTools)
    ? (sendOptions.alwaysAllowTools as unknown[])
    : null
  const approvals = pendingApprovals instanceof Map ? pendingApprovals : null
  const canPrompt = typeof emit === "function" && approvals !== null
  // Plugin-declared filesystem access classes + path params, so a cliTool or
  // `registerTool` entry that declared `access` gets the same confinement
  // classification the built-in read/write sets get.
  const pluginAccess = buildPluginAccessMap(sendOptions?.pluginTools)
  // Plugin tools that declared `requiresApproval`: asked on every call.
  const perCallApproval = buildPerCallApprovalSet(sendOptions?.pluginTools)
  const approvalRequired = buildApprovalRequiredSet(sendOptions?.pluginTools)

  return async function gate(toolName, input, signal) {
    const outcome = decidePermission(AI_SDK_RAIL, {
      toolName,
      input,
      signal,
      doomGuard,
      canPrompt,
      policy: {
        mode: sendOptions?.permissionMode,
        ruleset,
        suppress,
        alwaysAllow,
        confinement: sendOptions?.confinement,
        sandboxScope: sendOptions?.builtinProcessSandbox,
        cwd: sendOptions?.cwd,
        pluginAccess,
        perCallApproval,
      },
    })
    if (outcome.kind === "allow") return input
    if (outcome.kind === "deny") throw denialError(outcome.reason, toolName)
    // Only "ask" is left, and the approval-channel step only asks when both
    // the emitter and the pending map exist.
    const requestId = randomUUID()
    emit!({
      type: "permission_request",
      sessionId,
      requestId,
      toolName,
      displayName: toolName,
      input,
      ...(requiresPerCallApproval(toolName, approvalRequired) ? { requiresApproval: true } : {}),
      ...(requiresPerCallApproval(toolName, perCallApproval)
        ? { requiresPerCallApproval: true, suppressAlwaysAllowRule: true, defaultToNo: true }
        : {}),
      ...(sendOptions!.remoteExecutionContext
        ? { remoteExecutionContext: sendOptions!.remoteExecutionContext }
        : {}),
    })
    // The original input rides along so an approved-unmodified call resolves
    // with a concrete `updatedInput`, as on the Agent SDK rail.
    const decision = await awaitApproval({
      pendingApprovals: approvals!,
      requestId,
      entry: { input },
      signal,
    })
    if (decision && decision.behavior === "deny") {
      throw new Error((decision.message as string | undefined) ?? `denied: ${toolName}`)
    }
    return decision && decision.updatedInput !== undefined ? decision.updatedInput : input
  }
}
