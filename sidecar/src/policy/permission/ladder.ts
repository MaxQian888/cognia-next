// The tool-permission ladder both dispatch rails decide through.
//
// A call climbs one ordered list of steps. Hard denials come first: an
// interrupted turn, PII in the input, an explicit ruleset deny, the host's
// sandbox scope, a plan-mode or credential-path violation. Then the shortcuts
// that allow a call without asking: `ask_user`, the permission mode,
// remembered grants and ruleset allows. Whatever is left asks the user.
//
// The rails share every step, but not the order or the set of steps. The
// Claude Agent SDK enforces plan, dontAsk and bypassPermissions over its own
// tools, so its profile leaves them to the SDK, while the ai-sdk rail has no
// provider-side modes and emulates them here. A `RailProfile` names each such
// difference. ./ladder.pins.test.ts holds both rails to the exact decisions,
// messages and frames they had before the ladder was shared.
//
// Deciding is synchronous and has one side effect: the doom step records the
// call in the doom-loop guard. Rendering a denial and running the approval
// round-trip belong to the rail adapters (./ai-sdk-gate.ts,
// ./sdk-can-use-tool.ts) and ./approval.ts.

import { hasNoLeakingPiiDeep } from "@cognia/redact"

import { classifyToolCallConfinement } from "../confinement/classify.ts"
import type {
  ConfinementPolicy,
  ConfinementVerdict,
  PluginAccessMap,
} from "../confinement/classify.ts"
import { assertToolCallWithinRoots } from "../confinement/enforce.ts"
import type { SandboxScopePolicy } from "../confinement/enforce.ts"
import type { DoomLoopGuard } from "../doom-loop.ts"
import { classifyPlanMode } from "../plan-mode.ts"
import { BUILTIN_SERVER_NAME, READ_ONLY_TOOL_NAMES } from "../tool-catalog/catalog.ts"
import {
  ASK_USER_TOOL_NAME,
  EXIT_PLAN_TOOL_NAME,
  PLUGIN_TOOLS_SERVER_NAME,
  qualifiedToolName,
  splitToolName,
} from "../tool-catalog/names.ts"
import { resolveForToolCall } from "./resolver.ts"
import type { Verdict } from "./resolver.ts"

/** The `SendOptions` fields the ladder and its adapters read. */
export interface PermissionSendOptions {
  permissionMode?: unknown
  permissionRuleset?: unknown
  suppressApprovalForTools?: unknown
  alwaysAllowTools?: unknown
  confinement?: ConfinementPolicy | null
  /** The whole sandbox launch policy; the ladder reads only its scope. */
  builtinProcessSandbox?: (SandboxScopePolicy & { [field: string]: unknown }) | null
  cwd?: string
  pluginTools?: unknown
  remoteExecutionContext?: unknown
}

/**
 * The session policy as one call sees it. Each adapter decides which fields it
 * reads live and which it captured when the gate was built.
 */
export interface LadderPolicy {
  mode: unknown
  ruleset: unknown
  suppress: readonly unknown[] | null
  alwaysAllow: readonly unknown[] | null
  confinement: ConfinementPolicy | null | undefined
  sandboxScope: SandboxScopePolicy | null | undefined
  cwd: string | undefined
  pluginAccess: PluginAccessMap
  /**
   * Bare plugin tool names that must ask a human on every call
   * (`buildPerCallApprovalSet`). Such a call is never allowed by a shortcut —
   * no remembered grant, ruleset allow, acceptEdits or bypass mode — and
   * dontAsk denies it.
   */
  perCallApproval?: ReadonlySet<string> | null
}

export interface LadderCall {
  toolName: string
  input: unknown
  signal?: AbortSignal | null | undefined
  policy: LadderPolicy
  doomGuard?: Pick<DoomLoopGuard, "check"> | null | undefined
  /** Whether anyone can answer a permission request (ai-sdk: emit + pending map). */
  canPrompt: boolean
}

/** Steps that can only deny; the Agent SDK rail re-runs them on approved input. */
export type HardCheck =
  "interrupted" | "input-pii" | "ruleset" | "sandbox-scope" | "plan-mode-cognia" | "credential-path"

export type LadderStep =
  | HardCheck
  /** `ask_user` is the user interaction itself: never gated behind another one. */
  | "ask-user"
  /** Record the call in the doom-loop guard; a runaway repeat disarms every shortcut. */
  | "doom"
  /** Plan mode for a rail with no provider-side plan mode: read-only tools pass, the rest is denied. */
  | "plan-mode-emulated"
  /** dontAsk for a rail with no provider-side modes: pre-approved or denied, never asked. */
  | "dont-ask"
  | "bypass"
  /** acceptEdits, suppress/always-allow grants and ruleset allows. */
  | "grants"
  /** No one can answer a request: read-only built-ins pass, the rest is denied. */
  | "approval-channel"

export interface RailProfile {
  steps: readonly LadderStep[]
  /**
   * What a throwing confinement classifier means: fail the call, or treat it
   * as no verdict. The classifier only throws on non-JSON policy objects.
   */
  confinementErrors: "throw" | "ignore"
  /** The tools `acceptEdits` approves without asking. */
  acceptsEdit(toolName: string): boolean
}

export type DenyReason =
  | { code: "interrupted" }
  | { code: "input-pii" }
  | { code: "ruleset" }
  | { code: "sandbox-scope"; error: unknown }
  | { code: "plan-mode" }
  | { code: "credential-path" }
  | { code: "dont-ask" }
  | { code: "no-approval-channel" }

export type LadderOutcome =
  { kind: "allow" } | { kind: "deny"; reason: DenyReason } | { kind: "ask" }

const ASK_USER_QUALIFIED = qualifiedToolName(PLUGIN_TOOLS_SERVER_NAME, ASK_USER_TOOL_NAME)

/** Built-ins an emulated plan mode lets through: the read-only set plus the exit signal. */
const PLAN_EMULATION_BUILTINS: ReadonlySet<string> = new Set([
  ...READ_ONLY_TOOL_NAMES,
  EXIT_PLAN_TOOL_NAME,
])

function isReadOnlyBuiltin(toolName: string): boolean {
  const { server, bare } = splitToolName(toolName)
  return server === BUILTIN_SERVER_NAME && READ_ONLY_TOOL_NAMES.has(bare)
}

/** Per-call facts computed once and shared by the steps that need them. */
class CallState {
  readonly call: LadderCall
  readonly profile: RailProfile
  doomed = false
  #ruleset: Verdict | undefined
  #confinement: ConfinementVerdict | null | undefined

  constructor(call: LadderCall, profile: RailProfile) {
    this.call = call
    this.profile = profile
  }

  /** The ruleset verdict. A throwing resolver fails the call on both rails. */
  rulesetVerdict(): Verdict {
    this.#ruleset ??= resolveForToolCall(
      this.call.policy.ruleset,
      this.call.toolName,
      this.call.input
    )
    return this.#ruleset
  }

  confinementVerdict(): ConfinementVerdict | null {
    if (this.#confinement !== undefined) return this.#confinement
    const { policy, toolName, input } = this.call
    const classify = () =>
      classifyToolCallConfinement(
        policy.confinement,
        toolName,
        input,
        policy.cwd,
        policy.pluginAccess
      )
    if (this.profile.confinementErrors === "throw") this.#confinement = classify()
    else {
      try {
        this.#confinement = classify()
      } catch {
        this.#confinement = null
      }
    }
    return this.#confinement
  }

  /** Confinement "ask" (an escape from the roots) suspends every silent allow. */
  confinementBlocksShortcuts(): boolean {
    const verdict = this.confinementVerdict()
    return verdict === "ask" || verdict === "deny"
  }

  /** Suppress entries, always-allow grants and explicit ruleset allows. */
  granted(): boolean {
    const { policy, toolName } = this.call
    if (this.confinementBlocksShortcuts()) return false
    if (policy.suppress?.includes(toolName)) return true
    if (policy.alwaysAllow?.includes(toolName)) return true
    return Boolean(policy.ruleset) && this.rulesetVerdict() === "allow"
  }
}

const ALLOW: LadderOutcome = { kind: "allow" }

/**
 * Plugin tools whose approval can never be remembered, turned into a standing
 * grant, or skipped by a permission mode — each call asks a human (ADR-0201:
 * `browser_fill_credential` puts a stored password into a page;
 * `browser_set_files` hands local files to a web page). A tool is treated this
 * way only when it is in this list AND its manifest entry says
 * `requiresApproval: true`, so the catalog cannot be satisfied by a name alone.
 */
export const PER_CALL_PLUGIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "browser_fill_credential",
  "browser_set_files",
])

/** Bare names of the plugin tools whose manifest entry says `requiresApproval: true`. */
export function buildApprovalRequiredSet(pluginTools: unknown): Set<string> {
  const set = new Set<string>()
  if (!Array.isArray(pluginTools)) return set
  for (const entry of pluginTools as unknown[]) {
    const tool = entry as { name?: unknown; requiresApproval?: unknown } | null
    if (!tool || typeof tool.name !== "string" || tool.requiresApproval !== true) continue
    if (tool.name === ASK_USER_TOOL_NAME) continue
    set.add(tool.name)
  }
  return set
}

/**
 * The per-call subset: declared `requiresApproval` AND listed in
 * {@link PER_CALL_PLUGIN_TOOL_NAMES}.
 */
export function buildPerCallApprovalSet(pluginTools: unknown): Set<string> {
  const set = new Set<string>()
  for (const name of buildApprovalRequiredSet(pluginTools)) {
    if (PER_CALL_PLUGIN_TOOL_NAMES.has(name)) set.add(name)
  }
  return set
}

/** Whether `toolName` is a plugin tool in `names` (a set of bare plugin tool names). */
export function requiresPerCallApproval(
  toolName: string,
  perCallApproval: ReadonlySet<string> | null | undefined
): boolean {
  if (!perCallApproval || perCallApproval.size === 0) return false
  const { server, bare } = splitToolName(toolName)
  return server === PLUGIN_TOOLS_SERVER_NAME && perCallApproval.has(bare)
}

function deny(reason: DenyReason): LadderOutcome {
  return { kind: "deny", reason }
}

/** One step's verdict, or undefined to climb on. */
function runStep(step: LadderStep, state: CallState): LadderOutcome | undefined {
  const { call } = state
  const { policy, toolName, input } = call
  switch (step) {
    case "interrupted":
      return call.signal?.aborted ? deny({ code: "interrupted" }) : undefined
    case "input-pii":
      return hasNoLeakingPiiDeep(input) ? undefined : deny({ code: "input-pii" })
    case "ruleset":
      return state.rulesetVerdict() === "deny" ? deny({ code: "ruleset" }) : undefined
    case "sandbox-scope":
      try {
        assertToolCallWithinRoots(
          policy.sandboxScope,
          toolName,
          input,
          policy.cwd,
          policy.pluginAccess
        )
        return undefined
      } catch (error) {
        return deny({ code: "sandbox-scope", error })
      }
    case "plan-mode-cognia":
      // The Agent SDK owns plan mode for its native tools; only the two
      // Cognia servers are governed here.
      return policy.mode === "plan" &&
        toolName !== ASK_USER_QUALIFIED &&
        classifyPlanMode(toolName, {
          builtinServerName: BUILTIN_SERVER_NAME,
          pluginServerName: PLUGIN_TOOLS_SERVER_NAME,
          readOnlyBuiltins: READ_ONLY_TOOL_NAMES,
          governOnlyCogniaServers: true,
        }) === "deny"
        ? deny({ code: "plan-mode" })
        : undefined
    case "credential-path":
      return state.confinementVerdict() === "deny" ? deny({ code: "credential-path" }) : undefined
    case "ask-user":
      return toolName === ASK_USER_QUALIFIED ? ALLOW : undefined
    case "doom":
      state.doomed = call.doomGuard ? call.doomGuard.check(toolName, input) === "ask" : false
      return undefined
    case "plan-mode-emulated": {
      if (policy.mode !== "plan") return undefined
      const allowed =
        classifyPlanMode(toolName, {
          builtinServerName: BUILTIN_SERVER_NAME,
          pluginServerName: PLUGIN_TOOLS_SERVER_NAME,
          readOnlyBuiltins: PLAN_EMULATION_BUILTINS,
        }) === "allow" || toolName === ASK_USER_QUALIFIED
      return allowed ? ALLOW : deny({ code: "plan-mode" })
    }
    case "dont-ask":
      if (policy.mode !== "dontAsk") return undefined
      if (requiresPerCallApproval(toolName, policy.perCallApproval)) {
        return deny({ code: "dont-ask" })
      }
      // A doomed repeat cannot be asked about here, so it is denied outright.
      if (!state.doomed && (isReadOnlyBuiltin(toolName) || state.granted())) return ALLOW
      return deny({ code: "dont-ask" })
    case "bypass":
      if (requiresPerCallApproval(toolName, policy.perCallApproval)) return undefined
      return policy.mode === "bypassPermissions" && !state.doomed ? ALLOW : undefined
    case "grants":
      if (state.doomed) return undefined
      if (requiresPerCallApproval(toolName, policy.perCallApproval)) return undefined
      if (
        policy.mode === "acceptEdits" &&
        state.profile.acceptsEdit(toolName) &&
        !state.confinementBlocksShortcuts()
      )
        return ALLOW
      return state.granted() ? ALLOW : undefined
    case "approval-channel":
      if (call.canPrompt) return undefined
      return isReadOnlyBuiltin(toolName) ? ALLOW : deny({ code: "no-approval-channel" })
  }
}

/** Climb the rail's ladder: allow, deny with a reason, or ask the user. */
export function decidePermission(profile: RailProfile, call: LadderCall): LadderOutcome {
  const state = new CallState(call, profile)
  for (const step of profile.steps) {
    const outcome = runStep(step, state)
    if (outcome) return outcome
  }
  return { kind: "ask" }
}

/**
 * The first hard denial among `checks`, or undefined. Unlike
 * `decidePermission` this never consults the doom guard, so re-checking an
 * input does not count as another call.
 */
export function firstHardDenial(
  profile: RailProfile,
  checks: readonly HardCheck[],
  call: LadderCall
): DenyReason | undefined {
  const state = new CallState(call, profile)
  for (const step of checks) {
    const outcome = runStep(step, state)
    if (outcome?.kind === "deny") return outcome.reason
  }
  return undefined
}
