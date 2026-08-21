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

import { HOOK_EVENTS } from "@anthropic-ai/claude-agent-sdk"
import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"
import { runPluginHookHandler } from "./plugin-hook-exec.mjs"

const DEFAULT_TIMEOUT_SECS = 5
const HARD_TIMEOUT_CAP_SECS = 30
export const HOOK_PII_BLOCK_REASON = "Hook data blocked by the PII redaction gate"

/**
 * Every lifecycle event the SDK can fire, taken from the SDK itself.
 *
 * This used to be a hand-written list of three, so the other 28 events could be
 * configured in settings.json and would simply never run — no error, no log,
 * just a hook that did nothing. Importing the SDK's own export means the list
 * cannot drift: a release that adds an event adds it here, and
 * `check:sdk-surface` fails if the manifest has not triaged it.
 */
export const SUPPORTED_EVENTS = HOOK_EVENTS

/**
 * Which field of a hook's input the `matcher` is tested against.
 *
 * Tool events match on the tool name; the rest each have their own natural
 * discriminator (a session's `source`, a compaction's `trigger`, a changed
 * file's path). An event absent from this map matches unconditionally —
 * correct for events with nothing to discriminate on, like `Stop`.
 */
export const HOOK_MATCH_FIELDS = {
  PreToolUse: "tool_name",
  PostToolUse: "tool_name",
  PostToolUseFailure: "tool_name",
  PermissionRequest: "tool_name",
  PermissionDenied: "tool_name",
  Notification: "notification_type",
  UserPromptExpansion: "command",
  SessionStart: "source",
  SessionEnd: "reason",
  Setup: "trigger",
  StopFailure: "error",
  PreCompact: "trigger",
  PostCompact: "trigger",
  SubagentStart: "agent_type",
  SubagentStop: "agent_type",
  FileChanged: "file_path",
  DirectoryAdded: "source",
  ConfigChange: "source",
  InstructionsLoaded: "load_reason",
  Elicitation: "mcp_server_name",
  ElicitationResult: "mcp_server_name",
}

export const HOOK_EVENTS_WITHOUT_MATCHERS = new Set([
  "UserPromptSubmit",
  "PostToolBatch",
  "Stop",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "WorktreeCreate",
  "WorktreeRemove",
  "MessageDisplay",
  "CwdChanged",
])

/**
 * The value a hook group's `matcher` is compared against for this event.
 *
 * Returns `null` when the event does not support matchers. Claude Code ignores
 * a configured matcher for those events and always runs the group.
 */
export function hookMatchTarget(eventName, input) {
  if (HOOK_EVENTS_WITHOUT_MATCHERS.has(eventName)) return null
  const field = HOOK_MATCH_FIELDS[eventName]
  if (!field) return null
  const value = input?.[field]
  return typeof value === "string" ? value : ""
}

// --- Matcher (port of src-tauri/src/hooks/mod.rs:matcher_matches) -----------

/**
 * Test whether a hook group's matcher applies to `target`.
 *   - omitted / "*" / empty → match all
 *   - alphanumeric + `_` + `|` → exact-string-or-pipe-set match
 *   - anything else → JS regex (unanchored)
 */
const matcherRegexCache = new Map()

export function matcherMatches(matcher, target, narrowExactSet = false) {
  if (matcher == null) return true
  const m = String(matcher).trim()
  if (m === "" || m === "*") return true
  const exactPattern = narrowExactSet ? /^[A-Za-z0-9_|]+$/ : /^[A-Za-z0-9_\-, |]+$/
  if (exactPattern.test(m)) {
    const separator = narrowExactSet ? /\|/ : /[|,]/
    return m.split(separator).some((alt) => alt.trim() === target)
  }
  // Compiled once per pattern — this runs for every tool call of the session.
  let re = matcherRegexCache.get(m)
  if (re === undefined) {
    try {
      re = new RegExp(m)
    } catch {
      re = null
    }
    matcherRegexCache.set(m, re)
  }
  return re ? re.test(target) : false
}

/**
 * Resolve the agent identity for one hook fire.
 *
 * cognia does not launch the SDK with `--agent`, so the SDK only fills
 * `agent_id` / `agent_type` INSIDE a Task-dispatched subagent — every other
 * turn (a teammate, a plan step, a connector auto-reply) is indistinguishable
 * from a plain chat turn as far as the SDK is concerned. So the session's own
 * identity is injected host-side via `deps`, and the SDK's subagent identity
 * layers on top when present: a Task subagent spawned inside a teammate turn is
 * a subagent, not a teammate.
 */
export function resolveAgentIdentity(input, deps = {}) {
  const sdkAgentId = typeof input?.agent_id === "string" ? input.agent_id : undefined
  const sdkAgentType = typeof input?.agent_type === "string" ? input.agent_type : undefined
  const kind = sdkAgentId ? "subagent" : deps.agentKind
  const agentRef = sdkAgentType ?? sdkAgentId ?? deps.agentRef
  return {
    ...(kind ? { agent_kind: kind } : {}),
    ...(agentRef ? { agent_ref: agentRef } : {}),
  }
}

/**
 * Test a group's `agents` selector against the resolved identity. Absent
 * selector → match all, so every pre-existing config is untouched. A present
 * selector matches when it applies to EITHER `agent_kind` or `agent_ref`.
 *
 * An unidentified event never matches a present selector: a hook that asked to
 * be narrowed must not fire on a turn whose agent we cannot name.
 */
export function agentsMatch(selector, identity) {
  if (selector == null) return true
  const sel = String(selector).trim()
  if (sel === "" || sel === "*") return true
  return [identity?.agent_kind, identity?.agent_ref]
    .filter((v) => typeof v === "string" && v.length > 0)
    .some((target) => matcherMatches(sel, target))
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
export function runCommandHandler(command, configuredTimeout, payloadJson, signal, cwd) {
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
      // `cwd` is the SESSION working directory, not the sidecar's — hooks that
      // run `git diff` / relative-path checks must see the chat's workspace.
      child = spawn(command, {
        shell: true,
        windowsHide: true,
        ...(typeof cwd === "string" && cwd ? { cwd } : {}),
      })
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
        if (process.platform === "win32" && child.pid) {
          // `child.kill()` only terminates the `cmd.exe` wrapper spawned by
          // `shell: true`; the actual hook process survives the timeout and
          // leaks. taskkill /T fells the whole tree.
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).on("error", () => {})
        } else {
          child.kill()
        }
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

    // A hook that exits without reading stdin (very common) fails the write
    // ASYNCHRONOUSLY with EPIPE, emitted as an 'error' event on the stdin
    // stream — NOT on the child (so `child.on("error")` never sees it) and NOT
    // in the sync try/catch below. Unhandled, it crashes the whole sidecar.
    child.stdin?.on("error", () => {})
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
  // Outbound hooks never receive the original sensitive payload. Redact first;
  // then apply the deep gate to the redacted representation and fail closed if
  // a detector still finds data that the redactor could not remove.
  const redactedPayloadJson = redactText(payloadJson).redacted
  if (!hasNoLeakingPiiDeep(redactedPayloadJson)) {
    return { block: HOOK_PII_BLOCK_REASON }
  }
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
      body: redactedPayloadJson,
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

function runHandler(handler, payloadJson, signal, cwd, deps = {}) {
  if (!handler || typeof handler !== "object") {
    return Promise.resolve({ warning: "invalid hook handler configuration" })
  }
  if (handler.type === "command" && typeof handler.command === "string") {
    return runCommandHandler(handler.command, handler.timeout, payloadJson, signal, cwd)
  }
  if ((handler.type === "http" || handler.type === "webhook") && typeof handler.url === "string") {
    return runWebhookHandler(handler.url, handler.headers, handler.timeout, payloadJson, signal)
  }
  if (handler.type === "plugin") {
    // The settings.json ⇄ plugin bridge. Redact before the payload leaves the
    // sidecar: a plugin handler is third-party code, so it gets the same
    // outbound treatment as an HTTP hook rather than the raw turn.
    const redactedPayloadJson = redactText(payloadJson).redacted
    if (!hasNoLeakingPiiDeep(redactedPayloadJson)) {
      return Promise.resolve({ block: HOOK_PII_BLOCK_REASON })
    }
    return runPluginHookHandler(handler, redactedPayloadJson, {
      emit: deps.emitRaw,
      sessionId: deps.sessionId,
      pendingPluginHookCalls: deps.pendingPluginHookCalls,
      newId: deps.newId,
    }).catch((e) => ({ warning: `plugin hook failed: ${e?.message ?? e}` }))
  }
  if (
    (handler.type === "prompt" || handler.type === "agent" || handler.type === "mcp_tool") &&
    typeof deps.executeNativeHandler === "function"
  ) {
    const redactedPayloadJson = redactText(payloadJson).redacted
    if (!hasNoLeakingPiiDeep(redactedPayloadJson)) {
      return Promise.resolve({ block: HOOK_PII_BLOCK_REASON })
    }
    return Promise.resolve()
      .then(() =>
        deps.executeNativeHandler(handler, redactedPayloadJson, {
          signal,
          depth: deps.hookDepth ?? 0,
        })
      )
      .then((result) => {
        if (result && typeof result.output === "string") return parseZeroExitOutput(result.output)
        return result ?? {}
      })
      .catch((error) => ({
        warning: `hook ${handler.type} failed: ${error?.message ?? error}`,
      }))
  }
  if (handler.type === "prompt" || handler.type === "agent" || handler.type === "mcp_tool") {
    return Promise.resolve({ warning: `hook ${handler.type} runtime adapter unavailable` })
  }
  return Promise.resolve({})
}

function handlerPolicyClass(handler) {
  return handler?.policyClass === "managed" ? "managed" : "user"
}

function applyFailurePolicy(handler, outcome) {
  if (handlerPolicyClass(handler) !== "managed" || !outcome?.warning || outcome.block) {
    return outcome
  }
  return { ...outcome, block: `Managed hook failed closed: ${outcome.warning}` }
}

function auditOutcome(outcome) {
  if (outcome?.block) return "blocked"
  if (outcome?.warning) return "warning"
  if (outcome?.additionalContext) return "context"
  return "allowed"
}

/**
 * Groups configured for `eventName` that actually contain a handler.
 *
 * The emptiness filter used to be implicit: only three events were supported,
 * so a `Stop: [{ hooks: [] }]` entry was skipped for the wrong reason. Now that
 * every event is supported, "configured but empty" has to be rejected on its
 * own terms — registering a callback for it would run the whole matcher and
 * decision path on every fire to arrive at no decision.
 */
function groupsForEvent(hooksConfig, eventName) {
  const arr = hooksConfig ? hooksConfig[eventName] : undefined
  if (!Array.isArray(arr)) return []
  return arr.filter((g) => Array.isArray(g?.hooks) && g.hooks.length > 0)
}

/**
 * Run every matching handler for an event, folding into one decision.
 *
 * Handlers run in PARALLEL (matching Claude Code, where N matching hooks cost
 * max(runtime) not sum — this sits inside the canUseTool-blocking path), but
 * outcomes are merged in ARRAY order so the result is deterministic: first
 * block in config order wins, last mutation in config order wins.
 */
export async function runGroups(groups, target, payloadJson, signal, cwd, deps = {}) {
  const pending = []
  let handlerIndex = 0
  for (const group of groups) {
    if (!group || typeof group !== "object") continue
    if (
      target !== null &&
      !matcherMatches(
        group.matcher,
        target,
        deps.eventName === "FileChanged" || deps.eventName === "StopFailure"
      )
    )
      continue
    // Orthogonal to `matcher`: `matcher` narrows by tool, `agents` by producer.
    // Applies to EVERY event, including the matcher-less ones.
    if (!agentsMatch(group.agents, deps.agentIdentity)) continue
    for (const handler of Array.isArray(group.hooks) ? group.hooks : []) {
      const index = handlerIndex++
      const startedAt = Date.now()
      pending.push(
        runHandler(handler, payloadJson, signal, cwd, deps).then((rawOutcome) => {
          const outcome = applyFailurePolicy(handler, rawOutcome)
          deps.onAudit?.({
            hookId: `${deps.sessionId ?? "session"}:${deps.eventName ?? "event"}:${startedAt}:${index}`,
            hookEvent: deps.eventName ?? "unknown",
            provider: deps.provider ?? "unknown",
            handlerType: handler?.type ?? "unknown",
            policyClass: handlerPolicyClass(handler),
            outcome: auditOutcome(outcome),
            latencyMs: Math.max(0, Date.now() - startedAt),
            redacted: ["http", "webhook", "prompt", "agent", "mcp_tool", "plugin"].includes(
              handler?.type
            ),
            blockReason: outcome?.block,
            error: outcome?.warning,
          })
          return outcome
        })
      )
    }
  }
  const dec = emptyDecision()
  for (const outcome of await Promise.all(pending)) {
    if (dec.block !== undefined) break // first block (in config order) wins
    mergeOutcome(dec, outcome)
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

  // Every other lifecycle event. `block` and `additionalContext` are the two
  // outputs the generic contract defines for all of them; per-event extras
  // (SessionStart's `watchPaths`, MessageDisplay's `displayContent`) are not
  // expressible in the settings.json decision vocabulary, so a hook that wants
  // them uses the SDK/plugin handler path rather than a command hook.
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

export function buildHookAuditPayload(sessionId, audit) {
  return {
    type: "event",
    sessionId,
    event: {
      type: "system",
      subtype: "hook_audit",
      ...audit,
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
    // Merged BEFORE the payload is serialized so a hook script reads
    // `agent_kind` / `agent_ref` as top-level fields, exactly as the Rust rail
    // emits them.
    const agentIdentity = resolveAgentIdentity(input, deps)
    const identifiedInput = { ...input, ...agentIdentity }
    const target = hookMatchTarget(eventName, identifiedInput)
    const payloadJson = safeStringify(identifiedInput)
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
          ? (audit) => deps.emitAudit(buildHookAuditPayload(deps?.sessionId, audit))
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
 * @param {{ emit: Function, emitAudit?: Function, log?: Function, sessionId: string, cwd?: string, provider?: string, agentKind?: string, agentRef?: string, executeNativeHandler?: Function, pendingPluginHookCalls?: Map<string, any>, newId?: () => string }} deps
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
