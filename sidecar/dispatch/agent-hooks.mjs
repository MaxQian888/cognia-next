// General settings.json lifecycle-hook executor, run IN the sidecar as
// SDK-native `options.hooks` (the convergence of ADR-0040's HOST-side Rust/CLI
// engines into one implementation). Generalises `buildLspHooks` from a single
// hard-coded PostToolUse callback into a data-driven executor for the user's
// `hooks` config, so tool-input/output rewrite and blocking work in-process for
// BOTH the desktop and CLI shells (they drive the same sidecar).
//
// Self-contained by necessity: the sidecar is not in the pnpm workspace, so we
// cannot import `@/` or `cli/` code. The matcher + decision-parse + merge
// semantics are ported verbatim from `src-tauri/src/hooks/{mod,command,types}.rs`
// so behaviour is identical to the retired HOST engines.
//
// Exit-code / stdout-JSON contract (per Claude Code docs, mirrors command.rs):
//   2  → block; reason = first non-empty stderr (then stdout) line
//   0  → parse stdout: empty → allow; JSON → decision; else plain text → context
//   *  → non-blocking warning (soft-allow)

import { spawn } from "node:child_process"

const DEFAULT_TIMEOUT_SECS = 5
const HARD_TIMEOUT_CAP_SECS = 30

/** Events whose execution Phase 1 owns in the sidecar. */
const SUPPORTED_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"]

// --- Matcher (port of src-tauri/src/hooks/mod.rs:matcher_matches) -----------

/**
 * Test whether a hook group's matcher applies to `target`.
 *   - omitted / "*" / empty → match all
 *   - alphanumeric + `_` + `|` → exact-string-or-pipe-set match
 *   - anything else → JS regex (unanchored)
 */
export function matcherMatches(matcher, target) {
  if (matcher == null) return true
  const m = String(matcher).trim()
  if (m === "" || m === "*") return true
  if (/^[A-Za-z0-9_|]+$/.test(m)) {
    return m.split("|").some((alt) => alt === target)
  }
  try {
    return new RegExp(m).test(target)
  } catch {
    return false
  }
}

// --- Decision parsing (port of command.rs:parse_zero_exit_output/extract_decision)

function firstNonEmptyLine(s) {
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
export function extractDecision(json) {
  const hso = json && typeof json === "object" ? json.hookSpecificOutput : undefined
  const strField = (key) => {
    const v =
      (hso && typeof hso === "object" ? hso[key] : undefined) ?? (json ? json[key] : undefined)
    return typeof v === "string" ? v : undefined
  }
  const anyField = (key) => {
    if (hso && typeof hso === "object" && hso[key] !== undefined) return hso[key]
    return json ? json[key] : undefined
  }

  const out = {}

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

  const uo = anyField("updatedToolOutput") ?? anyField("updatedMCPToolOutput")
  if (uo !== undefined) out.updatedToolOutput = uo

  const ctx = strField("additionalContext")
  if (ctx !== undefined) out.additionalContext = ctx

  return out
}

/** Parse the stdout of a zero-exit handler into an outcome. */
export function parseZeroExitOutput(stdout) {
  const trimmed = String(stdout ?? "").trim()
  if (!trimmed) return {}
  try {
    return extractDecision(JSON.parse(trimmed))
  } catch {
    return { additionalContext: trimmed }
  }
}

// --- Decision aggregation (port of HookDecision::merge) ----------------------

function emptyDecision() {
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
export function mergeOutcome(dec, outcome) {
  if (!outcome) return dec
  if (outcome.warning) dec.warnings.push(outcome.warning)
  if (outcome.block !== undefined && dec.block === undefined) dec.block = outcome.block
  if (outcome.additionalContext !== undefined) {
    dec.additionalContext =
      dec.additionalContext === undefined
        ? outcome.additionalContext
        : `${dec.additionalContext}\n\n${outcome.additionalContext}`
  }
  // Mutations: last non-empty wins (matches Claude Code's "last to finish wins").
  if (outcome.updatedInput !== undefined) dec.updatedInput = outcome.updatedInput
  if (outcome.updatedToolOutput !== undefined) dec.updatedToolOutput = outcome.updatedToolOutput
  // Permission escalation: ask is more restrictive than allow.
  if (outcome.permissionDecision === "ask") dec.permissionDecision = "ask"
  else if (outcome.permissionDecision === "allow" && dec.permissionDecision === undefined) {
    dec.permissionDecision = "allow"
  }
  return dec
}

// --- Handler execution ------------------------------------------------------

/**
 * Run one `command` handler: spawn the platform shell with the payload piped to
 * stdin, honour the exit-code/stdout-JSON contract. Never rejects — a broken
 * hook must not lock the user out of the tool.
 *
 * @returns {Promise<object>} an outcome (see extractDecision) or `{ warning }`.
 */
export function runCommandHandler(command, configuredTimeout, payloadJson, signal) {
  const timeoutSecs = Math.min(
    typeof configuredTimeout === "number" && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_TIMEOUT_SECS,
    HARD_TIMEOUT_CAP_SECS
  )

  return new Promise((resolve) => {
    let child
    try {
      // `shell: true` runs the command string through the platform shell
      // (`cmd /d /s /c` on Windows, `/bin/sh -c` on POSIX) so pipes, quoting,
      // and `$VAR` expansion behave like the retired Rust `cmd /C` / `sh -c`
      // path — without Node's per-arg quoting mangling nested quotes.
      child = spawn(command, { shell: true, windowsHide: true })
    } catch (e) {
      resolve({ warning: `hook crashed: spawn failed: ${e?.message ?? e}` })
      return
    }

    let stdout = ""
    let stderr = ""
    let settled = false
    const started = Date.now()

    const cleanup = () => {
      clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort)
      }
    }
    const finish = (outcome) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }
    const kill = () => {
      try {
        child.kill()
      } catch {
        // best-effort
      }
    }
    const onAbort = () => {
      finish({ warning: "hook aborted" })
      kill()
    }

    const timer = setTimeout(() => {
      finish({ warning: `hook timed out after ${Date.now() - started}ms (soft-allow)` })
      kill()
    }, timeoutSecs * 1000)

    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      if (typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", onAbort, { once: true })
      }
    }

    child.stdout?.on("data", (d) => {
      stdout += d.toString()
    })
    child.stderr?.on("data", (d) => {
      stderr += d.toString()
    })
    child.on("error", (e) => finish({ warning: `hook crashed: ${e?.message ?? e}` }))
    child.on("close", (code) => {
      if (code === 2) {
        finish({
          block:
            firstNonEmptyLine(stderr) ?? firstNonEmptyLine(stdout) ?? "hook denied (no message)",
        })
      } else if (code === 0) {
        finish(parseZeroExitOutput(stdout))
      } else {
        finish({ warning: firstNonEmptyLine(stderr) ?? `hook exited with code ${code}` })
      }
    })

    try {
      child.stdin?.write(payloadJson)
      child.stdin?.end()
    } catch {
      // child may have exited early; the close/error handler resolves us.
    }
  })
}

/**
 * Run one `webhook` handler: HTTP POST the payload as the JSON body, parse the
 * 2xx response body through the same decision contract. Non-2xx / network
 * errors become soft-allow warnings.
 */
export async function runWebhookHandler(url, headers, configuredTimeout, payloadJson, signal) {
  const timeoutSecs = Math.min(
    typeof configuredTimeout === "number" && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_TIMEOUT_SECS,
    HARD_TIMEOUT_CAP_SECS
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutSecs * 1000)
  const onOuterAbort = () => controller.abort()
  if (signal && typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", onOuterAbort, { once: true })
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: payloadJson,
      signal: controller.signal,
    })
    const body = await res.text()
    if (!res.ok) {
      return { warning: `hook webhook ${res.status}` }
    }
    return parseZeroExitOutput(body)
  } catch (e) {
    return { warning: `hook webhook failed: ${e?.message ?? e}` }
  } finally {
    clearTimeout(timer)
    if (signal && typeof signal.removeEventListener === "function") {
      signal.removeEventListener("abort", onOuterAbort)
    }
  }
}

function runHandler(handler, payloadJson, signal) {
  if (!handler || typeof handler !== "object") return Promise.resolve({})
  if (handler.type === "command" && typeof handler.command === "string") {
    return runCommandHandler(handler.command, handler.timeout, payloadJson, signal)
  }
  if (handler.type === "webhook" && typeof handler.url === "string") {
    return runWebhookHandler(handler.url, handler.headers, handler.timeout, payloadJson, signal)
  }
  // prompt / mcp_tool / agent / unknown — inert in this phase (round-trips in
  // settings.json without executing, matching the CLI's tolerant behaviour).
  return Promise.resolve({})
}

function groupsForEvent(hooksConfig, eventName) {
  const arr = hooksConfig ? hooksConfig[eventName] : undefined
  return Array.isArray(arr) ? arr : []
}

/** Run every matching handler for an event, folding into one decision. */
export async function runGroups(groups, target, payloadJson, signal) {
  const dec = emptyDecision()
  for (const group of groups) {
    if (!group || typeof group !== "object") continue
    if (!matcherMatches(group.matcher, target)) continue
    for (const handler of Array.isArray(group.hooks) ? group.hooks : []) {
      const outcome = await runHandler(handler, payloadJson, signal)
      mergeOutcome(dec, outcome)
      if (dec.block !== undefined) return dec // first block wins, short-circuit
    }
  }
  return dec
}

// --- Decision → SDK HookJSONOutput mapping ----------------------------------

/** Map an aggregated decision to the SDK's per-event HookJSONOutput. */
export function mapDecisionToOutput(eventName, dec) {
  if (eventName === "PreToolUse") {
    if (dec.block !== undefined) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: dec.block,
        },
      }
    }
    const hso = { hookEventName: "PreToolUse" }
    let enriched = false
    if (dec.updatedInput !== undefined) {
      hso.permissionDecision = dec.permissionDecision ?? "allow"
      hso.updatedInput = dec.updatedInput
      enriched = true
    } else if (dec.permissionDecision === "ask") {
      hso.permissionDecision = "ask"
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
    const hso = { hookEventName: eventName }
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

  // Generic lifecycle mapping (Phase 2 extends this).
  if (dec.block !== undefined) return { decision: "block", reason: dec.block }
  if (dec.additionalContext !== undefined) {
    return {
      hookSpecificOutput: { hookEventName: eventName, additionalContext: dec.additionalContext },
    }
  }
  return {}
}

// --- Timeline projection (mirror of sidecar.rs:build_hook_fire_payload) ------

/** Derive the timeline outcome by precedence: block > context > warning. */
export function hookFireOutcome(dec) {
  if (dec.block !== undefined) return "blocked"
  if (dec.additionalContext !== undefined) return "context"
  if (dec.warnings && dec.warnings.length > 0) return "warning"
  return null
}

/**
 * Build the synthetic `hook_fire` SDK-system envelope, or `null` for a no-op
 * fire. Shape matches the Rust `build_hook_fire_payload` inner event so the
 * renderer's `hook-notice-part` renders sidecar- and Rust-emitted fires alike.
 */
export function buildHookFirePayload(sessionId, eventName, toolName, dec) {
  const outcome = hookFireOutcome(dec)
  if (!outcome) return null
  return {
    type: "event",
    sessionId,
    event: {
      type: "system",
      subtype: "hook_fire",
      hook_event: eventName,
      tool_name: toolName ?? null,
      outcome,
      block: dec.block ?? null,
      additional_context: dec.additionalContext ?? null,
      warnings: dec.warnings ?? [],
    },
  }
}

// --- SDK hooks-object assembly ----------------------------------------------

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return "{}"
  }
}

function makeEventCallback(eventName, hooksConfig, deps) {
  return async (input, _toolUseId, ctx) => {
    const groups = groupsForEvent(hooksConfig, eventName)
    if (groups.length === 0) return {}
    const target = typeof input?.tool_name === "string" ? input.tool_name : ""
    const payloadJson = safeStringify(input)
    const dec = await runGroups(groups, target, payloadJson, ctx?.signal)
    const fire = buildHookFirePayload(deps?.sessionId, eventName, input?.tool_name ?? null, dec)
    if (fire && typeof deps?.emit === "function") deps.emit(fire)
    return mapDecisionToOutput(eventName, dec)
  }
}

/**
 * Build the SDK `options.hooks` fragment for the user's settings.json hooks.
 * Returns `undefined` when no supported event has any configured group, so the
 * caller can omit the field.
 *
 * @param {object|undefined} hooksConfig  `HooksConfig` (event → HookGroup[])
 * @param {{ emit: Function, log?: Function, sessionId: string, cwd?: string }} deps
 */
export function buildAgentHooks(hooksConfig, deps) {
  if (!hooksConfig || typeof hooksConfig !== "object") return undefined
  const map = {}
  for (const eventName of SUPPORTED_EVENTS) {
    if (groupsForEvent(hooksConfig, eventName).length > 0) {
      map[eventName] = [{ hooks: [makeEventCallback(eventName, hooksConfig, deps)] }]
    }
  }
  return Object.keys(map).length > 0 ? map : undefined
}

/**
 * Merge multiple SDK hooks objects (e.g. LSP + agent hooks) by concatenating
 * the matcher arrays per event. `undefined` inputs are skipped; returns
 * `undefined` when nothing is contributed so the `options.hooks` key is omitted.
 */
export function mergeHookMaps(...maps) {
  const out = {}
  for (const m of maps) {
    if (!m || typeof m !== "object") continue
    for (const [event, arr] of Object.entries(m)) {
      if (!Array.isArray(arr)) continue
      out[event] = (out[event] ?? []).concat(arr)
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}
