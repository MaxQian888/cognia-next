// The Claude Agent SDK rail's `canUseTool` callback.
//
// The SDK enforces plan, dontAsk and bypassPermissions over its own native
// tools and only calls `canUseTool` for what it would ask about, so this rail
// climbs a shorter ladder than the ai-sdk one: the hard denials (plan mode
// only for the two Cognia servers), then `ask_user`, the doom guard and the
// grants. Approved input is re-checked against the hard denials, because the
// renderer may answer with a rewritten input.

import { randomUUID } from "node:crypto"

import { buildPluginAccessMap } from "../confinement/classify.ts"
import type { DoomLoopGuard } from "../doom-loop.ts"
import { BUILTIN_SERVER_NAME } from "../tool-catalog/catalog.ts"
import { PLUGIN_TOOLS_SERVER_NAME, qualifiedToolName } from "../tool-catalog/names.ts"
import { restorePluginToolName } from "../tool-catalog/plugin-aliases.ts"
import { awaitApproval } from "./approval.ts"
import type { ApprovalAnswer, PendingApproval } from "./approval.ts"
import {
  buildApprovalRequiredSet,
  buildPerCallApprovalSet,
  decidePermission,
  firstHardDenial,
  requiresPerCallApproval,
} from "./ladder.ts"
import type {
  DenyReason,
  HardCheck,
  LadderPolicy,
  PermissionSendOptions,
  RailProfile,
} from "./ladder.ts"

/** Hard authority shared by `canUseTool`, approved-input re-checks and delegated approval. */
const HARD_CHECKS: readonly HardCheck[] = [
  "interrupted",
  "input-pii",
  "ruleset",
  "sandbox-scope",
  "plan-mode-cognia",
  "credential-path",
]

/**
 * The file-edit tools this rail's `acceptEdits` approves. The SDK's native
 * `acceptEdits` covers its own Write/Edit family; these are the Cognia
 * built-ins and first-party sandbox editors it does not know about.
 */
const ACCEPT_EDITS_TOOLS: ReadonlySet<string> = new Set([
  ...["directory_create", "file_copy", "file_move", "file_rename"].map((name) =>
    qualifiedToolName(BUILTIN_SERVER_NAME, name)
  ),
  ...["sandbox_write", "sandbox_edit", "sandbox_text_editor"].map((name) =>
    qualifiedToolName(PLUGIN_TOOLS_SERVER_NAME, name)
  ),
])

export const CLAUDE_AGENT_SDK_RAIL: RailProfile = {
  steps: [
    ...HARD_CHECKS,
    // `ask_user` is the user interaction itself; each call is human-gated, so
    // it passes ahead of even the doom-loop guard.
    "ask-user",
    // The Nth identical call must round-trip through the user even when a
    // grant or ruleset would allow it silently.
    "doom",
    "grants",
  ],
  confinementErrors: "throw",
  acceptsEdit: (toolName) => ACCEPT_EDITS_TOOLS.has(toolName),
}

/** Every option read live: a `claude_set_mode` lands on the next call. */
function livePolicy(sendOptions: PermissionSendOptions): LadderPolicy {
  return {
    mode: sendOptions.permissionMode,
    ruleset: sendOptions.permissionRuleset,
    suppress: Array.isArray(sendOptions.suppressApprovalForTools)
      ? (sendOptions.suppressApprovalForTools as unknown[])
      : null,
    alwaysAllow: Array.isArray(sendOptions.alwaysAllowTools)
      ? (sendOptions.alwaysAllowTools as unknown[])
      : null,
    confinement: sendOptions.confinement,
    sandboxScope: sendOptions.builtinProcessSandbox,
    cwd: sendOptions.cwd,
    pluginAccess: buildPluginAccessMap(sendOptions.pluginTools),
    perCallApproval: buildPerCallApprovalSet(sendOptions.pluginTools),
  }
}

function renderDenial(reason: DenyReason, toolName: string): string {
  switch (reason.code) {
    case "interrupted":
      return "tool call interrupted"
    case "input-pii":
      return "tool input blocked by the PII gate"
    case "ruleset":
      return "denied by permission ruleset"
    case "sandbox-scope": {
      const error = reason.error as { message?: unknown } | null | undefined
      return String(error?.message ?? error)
    }
    case "plan-mode":
      return `plan mode: tool "${toolName}" is not permitted (read-only tools only)`
    case "credential-path":
      return "denied: path escapes the workspace into a protected credential location"
    // Not steps of this rail: the SDK enforces dontAsk itself (a per-call
    // tool is refused below as defence in depth), and a `canUseTool` call
    // always has the renderer to ask.
    case "dont-ask":
      return `dontAsk mode: tool "${toolName}" is not pre-approved`
    case "no-approval-channel":
      return `denied: no approval channel to authorize "${toolName}"`
  }
}

/**
 * Why the hard authority refuses this call, or undefined. The same checks
 * gate normal approvals, the renderer's rewritten input and the SDK's
 * delegated permission tool.
 */
export function anthropicToolDenial(
  sendOptions: PermissionSendOptions,
  toolName: string,
  input: unknown,
  signal?: AbortSignal | null
): string | undefined {
  const reason = firstHardDenial(CLAUDE_AGENT_SDK_RAIL, HARD_CHECKS, {
    toolName,
    input,
    signal,
    canPrompt: true,
    policy: livePolicy(sendOptions),
  })
  return reason && renderDenial(reason, toolName)
}

/** The permission-relevant slice of the Agent SDK's `canUseTool` options. */
export interface CanUseToolContext {
  signal?: AbortSignal
  toolUseID?: string
  title?: unknown
  displayName?: unknown
  description?: unknown
  blockedPath?: unknown
  decisionReason?: unknown
  suggestions?: unknown
  defaultToNo?: unknown
  suppressAlwaysAllowRule?: unknown
}

export interface AnthropicCanUseToolOptions {
  sendOptions: PermissionSendOptions
  sessionId: string
  emit: (frame: Record<string, unknown>) => void
  log: (level: "info" | "warn" | "error", message: string) => void
  pendingApprovals: Map<string, PendingApproval>
  pluginToolNameAliases: ReadonlyMap<string, string> | null | undefined
  doomGuard: Pick<DoomLoopGuard, "check">
}

/**
 * The Agent SDK `canUseTool` callback, as a standalone factory so the whole
 * permission path — ruleset, confinement, plugin-access classification, plan
 * mode, doom guard, approval round-trip — is testable without a live
 * `query()`.
 */
export function createAnthropicCanUseTool({
  sendOptions,
  sessionId,
  emit,
  log,
  pendingApprovals,
  pluginToolNameAliases,
  doomGuard,
}: AnthropicCanUseToolOptions): (
  modelToolName: string,
  input: Record<string, unknown>,
  ctx: CanUseToolContext
) => Promise<ApprovalAnswer> {
  // Verbose canUseTool tracing (shares the host's COGNIA_SIDECAR_VERBOSE gate).
  // Surfaces as frontend `log` events so a tool-call hang can be diagnosed
  // without stderr access.
  const verbose =
    process.env.COGNIA_SIDECAR_VERBOSE === "1" || process.env.COGNIA_SIDECAR_VERBOSE === "true"

  return (modelToolName, input, ctx) => {
    // Everything below (ruleset, plan-mode policy, suppress and always-allow
    // lists, the permission request the renderer answers) keys on the
    // original plugin tool name, not the one the SDK just called it by.
    const toolName = restorePluginToolName(
      pluginToolNameAliases,
      PLUGIN_TOOLS_SERVER_NAME,
      modelToolName
    )
    const outcome = decidePermission(CLAUDE_AGENT_SDK_RAIL, {
      toolName,
      input,
      signal: ctx?.signal,
      doomGuard,
      canPrompt: true,
      policy: livePolicy(sendOptions),
    })
    if (outcome.kind === "deny") {
      return Promise.resolve({ behavior: "deny", message: renderDenial(outcome.reason, toolName) })
    }
    if (outcome.kind === "allow") return Promise.resolve({ behavior: "allow", updatedInput: input })

    const perCall = requiresPerCallApproval(
      toolName,
      buildPerCallApprovalSet(sendOptions.pluginTools)
    )
    // The SDK enforces dontAsk before calling here, so this is defence in
    // depth: an approve-every-call tool is never asked about under dontAsk,
    // it is denied (ADR-0201).
    if (perCall && sendOptions.permissionMode === "dontAsk") {
      return Promise.resolve({
        behavior: "deny",
        message: renderDenial({ code: "dont-ask" }, toolName),
      })
    }
    // Declared `requiresApproval`: the auto-mode runner must defer to a human.
    const declared = requiresPerCallApproval(
      toolName,
      buildApprovalRequiredSet(sendOptions.pluginTools)
    )
    const requestId = randomUUID()
    // Boundary instrumentation (COGNIA_SIDECAR_VERBOSE=1): the Agent SDK path
    // forces a `canUseTool` round-trip for every gated tool, so when a turn
    // "hangs at the tool call" these three log lines localise the stall —
    // entry (the SDK called us), emit (the request left the sidecar), resolve
    // (the renderer answered). A missing "resolved" line means the round-trip
    // never came back (no dialog / swallowed approval).
    if (verbose) log("info", `[canUseTool] enter tool=${toolName} requestId=${requestId}`)
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
      defaultToNo: perCall ? true : ctx.defaultToNo,
      // A per-call tool must not be turned into a standing grant.
      suppressAlwaysAllowRule: perCall ? true : ctx.suppressAlwaysAllowRule,
      ...(declared ? { requiresApproval: true } : {}),
      ...(perCall ? { requiresPerCallApproval: true } : {}),
      ...(sendOptions.remoteExecutionContext
        ? { remoteExecutionContext: sendOptions.remoteExecutionContext }
        : {}),
    })
    if (verbose) {
      log("info", `[canUseTool] permission_request emitted tool=${toolName} requestId=${requestId}`)
    }
    return awaitApproval({
      pendingApprovals,
      requestId,
      // The original input comes back as `updatedInput` when the user approves
      // it unmodified — the SDK requires a record on an allow. `suggestions`
      // is kept for the same reason: an "always allow" must answer with the
      // SDK's OWN suggested permission updates, and this context is gone by
      // the time the renderer replies. Taking them from the reply instead
      // would let the renderer author permission rules.
      entry: {
        input,
        suggestions: ctx.suggestions,
        // A per-call tool's "always allow" must never persist the SDK's
        // suggested rule: a stored allow rule would let the SDK skip this
        // callback entirely on the next call (ADR-0201).
        suppressAlwaysAllowRule: perCall ? true : ctx.suppressAlwaysAllowRule,
      },
      signal: ctx.signal,
      // A distinct terminal: the renderer learns the waiter is gone and can
      // show "interrupted" instead of a silently vanishing prompt. The SDK
      // still gets its required deny.
      onAbort: () =>
        emit({ type: "permission_interrupted", sessionId, requestId, reason: "aborted" }),
      review: (answer) => {
        if (verbose) {
          log(
            "info",
            `[canUseTool] resolved tool=${toolName} requestId=${requestId} behavior=${answer?.behavior ?? "?"}`
          )
        }
        if (answer?.behavior === "allow") {
          const reason = anthropicToolDenial(
            sendOptions,
            toolName,
            answer.updatedInput ?? input,
            ctx?.signal
          )
          if (reason) return { behavior: "deny", message: reason }
        }
        return answer
      },
    })
  }
}
