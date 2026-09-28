import type { HookOutcome, HookOutput, HookSpecificOutput } from "./kernel/types.ts"

// --- Decision → SDK HookJSONOutput mapping ----------------------------------

/** Map an aggregated decision to the SDK's per-event HookJSONOutput. */
export function mapDecisionToOutput(eventName: string, dec: HookOutcome): HookOutput {
  const preserved = dec.sdkOutput ?? {}
  if (preserved.hookSpecificOutput && preserved.hookSpecificOutput.hookEventName !== eventName) {
    return mapDecisionToOutput(eventName, {
      block: "Hook output event does not match the invoked event",
    })
  }
  const mapped = mapLegacyDecisionToOutput(eventName, dec)
  const result = { ...preserved, ...mapped }
  if (preserved.hookSpecificOutput || mapped.hookSpecificOutput)
    result.hookSpecificOutput = {
      ...preserved.hookSpecificOutput,
      ...mapped.hookSpecificOutput,
    }
  if (eventName === "PermissionRequest" && dec.block !== undefined) {
    const original = preserved.hookSpecificOutput?.decision
    delete result.decision
    delete result.reason
    result.hookSpecificOutput = {
      hookEventName: eventName,
      decision: {
        ...(original?.behavior === "deny" ? original : {}),
        behavior: "deny",
        message: dec.block,
      },
    }
  }
  return result
}

function mapLegacyDecisionToOutput(eventName: string, dec: HookOutcome): HookOutput {
  if (eventName === "PreToolUse" || eventName === "PreModelSwitch") {
    if (dec.block !== undefined) {
      return {
        hookSpecificOutput: {
          hookEventName: eventName,
          permissionDecision: "deny",
          permissionDecisionReason: dec.block,
        },
      }
    }
    const hso: HookSpecificOutput = { hookEventName: eventName }
    let enriched = false
    if (dec.updatedInput !== undefined) {
      hso.permissionDecision = dec.permissionDecision ?? "allow"
      hso.updatedInput = dec.updatedInput
      enriched = true
    } else if (dec.permissionDecision !== undefined) {
      hso.permissionDecision = dec.permissionDecision
      enriched = true
    }
    if (dec.additionalContext !== undefined) {
      hso.additionalContext = dec.additionalContext
      enriched = true
    }
    return enriched ? { hookSpecificOutput: hso } : {}
  }

  if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") {
    if (dec.block !== undefined) return { decision: "block", reason: dec.block }
    const hso: HookSpecificOutput = { hookEventName: eventName }
    let enriched = false
    if (dec.updatedToolOutput !== undefined) {
      hso.updatedToolOutput = dec.updatedToolOutput
      enriched = true
    }
    if (dec.additionalContext !== undefined) {
      hso.additionalContext = dec.additionalContext
      enriched = true
    }
    return enriched ? { hookSpecificOutput: hso } : {}
  }

  // Legacy Cognia outputs remain supported; structured SDK fields are merged
  // by the caller without flattening event-specific decisions.
  if (dec.block !== undefined) return { decision: "block", reason: dec.block }
  if (eventName === "WorktreeCreate" && dec.additionalContext !== undefined) {
    return { hookSpecificOutput: { hookEventName: eventName, worktreePath: dec.additionalContext } }
  }
  if (dec.additionalContext !== undefined) {
    return {
      hookSpecificOutput: { hookEventName: eventName, additionalContext: dec.additionalContext },
    }
  }
  return {}
}
