import type { HookDeps, HookCallback, HookMap, HooksConfig } from "./kernel/types.ts"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { resolveToolProvenance } from "./tool-provenance.ts"
import { SUPPORTED_EVENTS, hookMatchTarget } from "./events.ts"
import { resolveAgentIdentity } from "./matcher.ts"
import { groupsForEvent, runGroups } from "./run-groups.ts"
import { mapDecisionToOutput } from "./sdk-output.ts"
import { buildHookFirePayload, buildHookAuditPayload } from "./timeline.ts"
import { HOOK_PII_BLOCK_REASON } from "./kernel/types.ts"
export {
  SUPPORTED_EVENTS,
  HOOK_MATCH_FIELDS,
  HOOK_EVENTS_WITHOUT_MATCHERS,
  hookMatchTarget,
} from "./events.ts"
export { matcherMatches, resolveAgentIdentity, agentsMatch } from "./matcher.ts"
export { extractDecision, parseZeroExitOutput, mergeOutcome } from "./kernel/decision.ts"
export { runCommandHandler } from "./handlers/command.ts"
export { runWebhookHandler } from "./handlers/webhook.ts"
export { runGroups } from "./run-groups.ts"
export { mapDecisionToOutput } from "./sdk-output.ts"
export { hookFireOutcome, buildHookFirePayload, buildHookAuditPayload } from "./timeline.ts"
export { HOOK_PII_BLOCK_REASON } from "./kernel/types.ts"

// --- SDK hooks-object assembly ----------------------------------------------

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return "{}"
  }
}

function makeEventCallback(
  eventName: string,
  hooksConfig: HooksConfig,
  deps: HookDeps
): HookCallback {
  return async (input, _toolUseId, ctx) => {
    const groups = groupsForEvent(hooksConfig, eventName)
    if (groups.length === 0) return {}
    // Merged BEFORE the payload is serialized so a hook script reads
    // `agent_kind` / `agent_ref` as top-level fields, exactly as the Rust rail
    // emits them.
    const agentIdentity = resolveAgentIdentity(input, deps)
    // `tool_provenance` joins the identity fields: resolved host-side from the
    // tool name + the session's plugin manifest, metadata only (never args).
    // Merged BEFORE serialization for the same reason `agent_kind` is — a hook
    // script reads it as a top-level field. Absent when the event carries no
    // resolvable tool name.
    const toolProvenance = resolveToolProvenance(input?.tool_name, {
      pluginTools: deps?.pluginTools,
      mcpDeclaredBy: deps?.mcpDeclaredBy,
    })
    const identifiedInput = {
      ...input,
      ...agentIdentity,
      ...(toolProvenance ? { tool_provenance: toolProvenance } : {}),
    }
    const target = hookMatchTarget(eventName, identifiedInput)
    const payloadJson = safeStringify(identifiedInput)!
    const hookDepth =
      input?.hook_origin === "hook" ? Math.max(1, Number(input?.hook_recursion_depth ?? 1) || 1) : 0
    const dec = await runGroups(groups, target, payloadJson, ctx?.signal, deps?.cwd, {
      eventName,
      provider: deps?.provider ?? "claude",
      sessionId: deps?.sessionId,
      agentIdentity,
      hookDepth,
      // Plugin-handler round-trip seam (`{ type: "plugin" }`).
      emitRaw: deps?.emit,
      pendingPluginHookCalls: deps?.pendingPluginHookCalls,
      newId: deps?.newId,
      executeNativeHandler: deps?.executeNativeHandler,
      onAudit:
        typeof deps?.emitAudit === "function"
          ? (audit) => deps.emitAudit!(buildHookAuditPayload(deps?.sessionId, audit))
          : undefined,
    })
    if (dec.warnings.length > 0 && typeof deps?.log === "function") {
      // Host log signature: (level, message).
      for (const w of dec.warnings) deps.log("warn", `agent-hook ${eventName}: ${w}`)
    }
    const fire = buildHookFirePayload(deps?.sessionId, eventName, input?.tool_name ?? null, dec)
    if (fire && typeof deps?.emit === "function") deps.emit(fire)
    const output = mapDecisionToOutput(eventName, dec)
    return hasNoLeakingPiiDeep(output)
      ? output
      : mapDecisionToOutput(eventName, { block: HOOK_PII_BLOCK_REASON })
  }
}

/**
 * Build the SDK `options.hooks` fragment for the user's settings.json hooks.
 * Returns `undefined` when no supported event has any configured group, so the
 * caller can omit the field.
 *
 * @param {object|undefined} hooksConfig  `HooksConfig` (event → HookGroup[])
 * @param {{ emit: Function, emitAudit?: Function, log?: Function, sessionId: string, cwd?: string, provider?: string, agentKind?: string, agentRef?: string, pluginTools?: readonly { name?: unknown, pluginId?: unknown }[], executeNativeHandler?: Function, pendingPluginHookCalls?: Map<string, any>, newId?: () => string }} deps
 */
export function buildAgentHooks(
  hooksConfig: HooksConfig | undefined | null,
  deps: HookDeps
): HookMap | undefined {
  if (!hooksConfig || typeof hooksConfig !== "object") return undefined
  const map: HookMap = {}
  for (const eventName of SUPPORTED_EVENTS) {
    if (groupsForEvent(hooksConfig, eventName).length > 0) {
      if (eventName === "PreModelSwitch" || eventName === "PostModelSwitch") {
        map[eventName] = groupsForEvent(hooksConfig, eventName).map((group) => ({
          ...(group.matcher ? { matcher: group.matcher } : {}),
          hooks: [makeEventCallback(eventName, { [eventName]: [group] }, deps)],
        }))
      } else map[eventName] = [{ hooks: [makeEventCallback(eventName, hooksConfig, deps)] }]
    }
  }
  return Object.keys(map).length > 0 ? map : undefined
}

/**
 * Merge multiple SDK hooks objects (e.g. LSP + agent hooks) by concatenating
 * the matcher arrays per event. `undefined` inputs are skipped; returns
 * `undefined` when nothing is contributed so the `options.hooks` key is omitted.
 */
export function mergeHookMaps(...maps: (HookMap | undefined | null)[]): HookMap | undefined {
  const out: HookMap = {}
  for (const m of maps) {
    if (!m || typeof m !== "object") continue
    for (const [event, arr] of Object.entries(m)) {
      if (!Array.isArray(arr)) continue
      out[event] = (out[event] ?? []).concat(arr)
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}
