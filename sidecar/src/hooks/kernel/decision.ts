import {
  asRecord,
  type HookOutcome,
  type HookDecision,
  type HookOutput,
  type HookSpecificOutput,
} from "./types.ts"

// --- Decision parsing (port of command.rs:parse_zero_exit_output/extract_decision)

export function firstNonEmptyLine(s: unknown) {
  for (const line of String(s ?? "").split(/\r?\n/)) {
    const t = line.trim()
    if (t) return t
  }
  return undefined
}

/**
 * Extract a decision from a hook's parsed JSON stdout. Fields resolve from the
 * nested `hookSpecificOutput` first, then the top level (both shapes honoured).
 * Returns a partial "outcome" object; absent fields mean "no opinion".
 */
export function extractDecision(value: unknown): HookOutcome {
  const json = asRecord(value)
  const hso = asRecord(json?.hookSpecificOutput) as HookSpecificOutput | undefined
  const strField = (key: string) => {
    const v =
      (hso && typeof hso === "object" ? hso[key] : undefined) ?? (json ? json[key] : undefined)
    return typeof v === "string" ? v : undefined
  }
  const anyField = (key: string) => {
    if (hso && typeof hso === "object" && hso[key] !== undefined) return hso[key]
    return json ? json[key] : undefined
  }

  const out: HookOutcome = {}
  // Retain the SDK's structured contract independently of Cognia's aggregate
  // decision vocabulary. Plugin/native handlers and JSON command stdout share
  // this path, so event-specific outputs must not disappear during translation.
  const sdkOutput: HookOutput = {}
  for (const key of [
    "continue",
    "suppressOutput",
    "stopReason",
    "systemMessage",
    "terminalSequence",
  ]) {
    if (json?.[key] !== undefined) sdkOutput[key] = json[key]
  }
  if (json?.decision === "approve") sdkOutput.decision = "approve"
  if (json?.decision === "approve" && json.reason !== undefined)
    sdkOutput.reason = json.reason as string
  if (hso && typeof hso === "object" && typeof hso.hookEventName === "string") {
    sdkOutput.hookSpecificOutput = { ...hso }
  }
  if (Object.keys(sdkOutput).length) out.sdkOutput = sdkOutput
  if (hso?.decision?.behavior === "deny") {
    out.block = hso.decision.message ?? "hook denied permission"
    return out
  }

  const pd = strField("permissionDecision")
  if (pd) {
    const low = pd.toLowerCase()
    if (low === "deny" || low === "block") {
      out.block =
        strField("permissionDecisionReason") ??
        strField("decisionReason") ??
        strField("reason") ??
        "hook returned permissionDecision=deny"
      return out
    }
    if (low === "ask") out.permissionDecision = "ask"
    else if (low === "allow") out.permissionDecision = "allow"
  }

  const decision = strField("decision")
  if (decision && decision.toLowerCase() === "block") {
    out.block = strField("reason") ?? "hook returned decision=block"
    return out
  }

  const ui = anyField("updatedInput")
  if (ui && typeof ui === "object") out.updatedInput = ui

  const currentOutput = anyField("updatedToolOutput")
  const uo = currentOutput !== undefined ? currentOutput : anyField("updatedMCPToolOutput")
  if (uo !== undefined) out.updatedToolOutput = uo

  const ctx = strField("additionalContext")
  if (ctx !== undefined) out.additionalContext = ctx

  return out
}

/** Parse the stdout of a zero-exit handler into an outcome. */
export function parseZeroExitOutput(stdout: unknown): HookOutcome {
  const trimmed = String(stdout ?? "").trim()
  if (!trimmed) return {}
  try {
    return extractDecision(JSON.parse(trimmed))
  } catch {
    return { additionalContext: trimmed }
  }
}

// --- Decision aggregation (port of HookDecision::merge) ----------------------

export function emptyDecision(): HookDecision {
  return {
    block: undefined,
    additionalContext: undefined,
    updatedInput: undefined,
    updatedToolOutput: undefined,
    permissionDecision: undefined,
    warnings: [],
  }
}

/** Fold one handler outcome into the running decision. First block wins. */
export function mergeOutcome(
  dec: HookDecision,
  outcome: HookOutcome | null | undefined
): HookDecision {
  if (!outcome) return dec
  if (outcome.warning) dec.warnings.push(outcome.warning)
  if (outcome.sdkOutput) {
    const previous = dec.sdkOutput ?? {}
    dec.sdkOutput = { ...previous, ...outcome.sdkOutput }
    if (previous.hookSpecificOutput || outcome.sdkOutput.hookSpecificOutput)
      dec.sdkOutput.hookSpecificOutput = {
        ...previous.hookSpecificOutput,
        ...outcome.sdkOutput.hookSpecificOutput,
      }
    // An assertion describing an earlier rewrite must not be attached to a
    // later handler's replacement. The SDK applies the same pairing rule.
    const nextSpecific = outcome.sdkOutput.hookSpecificOutput
    const replacesOutput =
      nextSpecific?.updatedToolOutput !== undefined ||
      nextSpecific?.updatedMCPToolOutput !== undefined
    if (
      replacesOutput &&
      dec.classifierContextBound &&
      nextSpecific.classifierContext === undefined
    )
      delete dec.sdkOutput?.hookSpecificOutput?.classifierContext
    if (nextSpecific?.classifierContext !== undefined) dec.classifierContextBound = replacesOutput
    if (previous.continue === false) dec.sdkOutput.continue = false
  }
  if (outcome.block !== undefined && dec.block === undefined) dec.block = outcome.block
  if (outcome.additionalContext !== undefined) {
    dec.additionalContext =
      dec.additionalContext === undefined
        ? outcome.additionalContext
        : `${dec.additionalContext}\n\n${outcome.additionalContext}`
  }
  // Mutations: last non-empty wins (matches Claude Code's "last to finish wins").
  if (outcome.updatedToolOutput !== undefined && !outcome.sdkOutput && dec.classifierContextBound) {
    delete dec.sdkOutput?.hookSpecificOutput?.classifierContext
  }
  if (outcome.updatedInput !== undefined) dec.updatedInput = outcome.updatedInput
  if (outcome.updatedToolOutput !== undefined) dec.updatedToolOutput = outcome.updatedToolOutput
  // Permission escalation: ask is more restrictive than allow.
  if (outcome.permissionDecision === "ask") dec.permissionDecision = "ask"
  else if (outcome.permissionDecision === "allow" && dec.permissionDecision === undefined) {
    dec.permissionDecision = "allow"
  }
  return dec
}
