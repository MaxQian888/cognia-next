// AI SDK tool bridge for the non-Anthropic dispatch path.
//
// The Anthropic dispatcher hands built-in tools + plugin tools to the Claude
// Agent SDK as in-process MCP servers. The AI SDK has no MCP-server concept for
// `streamText`, so we convert the SAME built-in tool definitions (and the
// renderer-proxied plugin tools) into native AI SDK `tool()` objects keyed by
// name. This is what lets local / OpenAI / Gemini models actually call tools in
// the main chat — previously the ai-sdk path was text-only.
//
// Tool execution runs through a permission gate that mirrors the Anthropic
// path's `canUseTool` (ADR-0043 Phase A): suppress-list + static ruleset
// short-circuit, otherwise a `permission_request` round-trip resolved via
// `pendingApprovals` — so a local model can't silently run shell/process tools.

import { tool, jsonSchema } from "ai"
import { z } from "zod"
import { randomUUID } from "node:crypto"
import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"

import {
  collectCogniaToolDefs,
  SERVER_NAME,
  READ_ONLY_TOOL_NAMES,
} from "../builtin-tools/index.mjs"
import { EXIT_PLAN_TOOL_NAME } from "../builtin-tools/exit-plan.mjs"
import { PLAN_ALLOWED_PLUGIN_TOOLS } from "./plan-mode-policy.mjs"
import {
  DEFAULT_BUILTIN_TOOL_TIMEOUT_MS,
  toolBudgetMessage,
} from "../builtin-tools/read-only-timeout.mjs"

/** The `ask_user` elicitation tool name (a plugin tool, namespaced
 * `mcp__cognia-plugin-tools__ask_user`). It only pauses to ask the user a
 * question — no file/exec side effects — so it is permitted in plan mode for
 * parity with the Anthropic SDK, letting the agent clarify before it plans. */
const ASK_USER_TOOL_NAME = "ask_user"
import { awaitPluginToolResponse } from "../builtin-tools/plugin-tools.mjs"
import { resolveForToolCall } from "./permission-resolver.mjs"
import { classifyToolCallConfinement } from "../builtin-tools/confinement.mjs"
import { createDoomLoopGuard } from "./doom-loop.mjs"
import { markAiSdkToolSource } from "./ai-sdk-tool-search.mjs"

const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"
const TOOL_RESULT_PII_ERROR = "Tool result blocked by the PII redaction gate"

/**
 * Plugin tools that MUST remain callable in plan mode: subagent dispatch
 * (`dispatch_agent` / its `Task` alias) and `load_skill`. Plan mode's
 * `PLAN_MODE_PROMPT_SECTION` explicitly tells the model to dispatch the
 * read-only `Explore` / `Plan` subagents, so blocking these would break the
 * explore→plan flow on every non-Anthropic provider.
 *
 * The set itself now lives in `./plan-mode-policy.mjs` (imported at the top of
 * this file) — the Anthropic rail applies the SAME set to the cognia-owned MCP
 * servers, and the hand-maintained copies had already drifted from the CLI's
 * `PLAN_ALLOWED_HOST_TOOLS`.
 */

/**
 * Built-in file-edit-class tools auto-approved in `acceptEdits` mode — the
 * write/edit family a user who "accepted edits" implicitly trusts. Mirrors the
 * Anthropic SDK's native `acceptEdits` and the ACP client's edit auto-approval
 * (`lib/ai/agent/external/acp-client.ts`) so the AI-SDK path stops prompting for
 * every edit. DELIBERATELY excludes exec/process/git-mutation tools (bash,
 * shell, start_process, git_commit, …) and directory/rename/move ops — those
 * still route through the normal approval policy. Read-only tools are already
 * auto-approved upstream, so they aren't listed here. */
const ACCEPT_EDITS_TOOL_NAMES = new Set([
  "write",
  "edit",
  "multi_edit",
  "apply_patch",
  "NotebookEdit",
  "file_append",
  "file_binary_write",
])

// Per-tool execution deadline for READ-ONLY built-ins on the ai-sdk path. The
// constant, the read-only gate, and the recoverable message all live in
// `../builtin-tools/read-only-timeout.mjs` so this channel and the Anthropic
// channel (`builtin-tools/index.mjs`) never drift. Here we bound the handler at
// EXECUTE time and REJECT on timeout so the AI SDK surfaces a `tool-error`; the
// Anthropic side wraps at registration time and returns an `isError` result.
// Exec tools (bash / shell / process / git-run) self-bound and are excluded.
// `0` disables it.

/**
 * Run a built-in tool handler under an optional execution deadline. Only
 * read-only tools are bounded (see {@link DEFAULT_BUILTIN_TOOL_TIMEOUT_MS});
 * everything else runs unbounded exactly as before. On timeout we reject so the
 * AI SDK surfaces a `tool-error`; the orphaned handler is left to settle and be
 * GC'd (read-only tools have no side effects to unwind). The gate runs BEFORE
 * this, so a slow human approval is never counted against the budget.
 *
 * @param {{ name: string, handler: Function }} def
 * @param {Record<string, unknown>} effective  gated/validated args
 * @param {number} timeoutMs                    0 / non-finite ⇒ no net
 * @param {AbortSignal} [signal]  The step's abort signal. Forwarded as
 *   `extra.signal` so a handler can actually stop work on a user interrupt —
 *   `core/rg.mjs` and `ast-grep/run.mjs` both accept one and, until now, no
 *   caller ever supplied it, so an interrupt abandoned the promise while the
 *   child process kept running.
 */
function runBuiltinHandler(def, effective, timeoutMs, signal) {
  const net = READ_ONLY_TOOL_NAMES.has(def.name) ? timeoutMs : 0
  const call = () => def.handler(effective, { signal })
  if (!Number.isFinite(net) || net <= 0) return call()
  let timer = null
  const deadline = new Promise((_, reject) => {
    // Keep the timer REF'd: while a read-only handler is in flight we owe the AI
    // SDK a result, so the deadline must hold the event loop open until it fires
    // (or `call()` settles and we clearTimeout). An unref'd timer let the loop
    // drain mid-wait — the process could exit before the budget rejection was
    // ever surfaced, defeating the backstop. The timer is always cleared on
    // settle (the .finally below), so it never lingers; graceful shutdown is
    // driven by stdin-close → process.exit(), not timer GC.
    timer = setTimeout(() => {
      reject(new Error(toolBudgetMessage(def.name, net)))
    }, net)
  })
  return Promise.race([call(), deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

// Claude-Code canonical name → cognia AI-SDK bare name, for the core file
// tools whose name diverges across the two dispatch paths. `allowedTools` (a
// character/skill/mode tool whitelist) is authored in Claude-Code naming
// (`Read`, `Grep`, `Bash`, …) because it targets the native Anthropic path; on
// the AI-SDK path the equivalent built-in tools carry cognia bare names
// (`read`, `grep`, `bash`, …). Without this bridge an allow list like
// `["Read"]` would match nothing and filter every tool out — the opposite of
// the intended "scope the palette to Read" semantics. Tools that share a name
// across both paths (plugin tools, TodoWrite, git_*, …) need no entry.
const CLAUDE_TOOL_NAME_BY_COGNIA_BARE = Object.freeze({
  read: "Read",
  write: "Write",
  edit: "Edit",
  multi_edit: "MultiEdit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  ls: "LS",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
})

/**
 * Decide whether a tool with the given candidate allow-names passes the
 * `allowedTools` whitelist. An absent/empty whitelist means "no restriction"
 * (every enabled tool is exposed). A non-empty whitelist exposes a tool only
 * when at least one of its candidate names appears in the list.
 *
 * @param {Set<string>|null} allowSet
 * @param {string[]} candidateNames  bare, namespaced, and (for core tools) the
 *   Claude-Code alias — any match admits the tool.
 */
function passesAllowList(allowSet, candidateNames) {
  if (!allowSet || allowSet.size === 0) return true
  return candidateNames.some((n) => allowSet.has(n))
}

/** Flatten an MCP `CallToolResult` to a plain string for the model. */
function callToolResultToText(result) {
  if (result == null) return ""
  if (typeof result === "string") return result
  if (Array.isArray(result.content)) {
    return result.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
  }
  return JSON.stringify(result)
}

/**
 * Build a permission gate for tool execution. Returns `async (toolName, input)
 * => effectiveInput` that resolves with the (possibly updated) input when
 * allowed and THROWS when denied. Mirrors `anthropic.mjs:canUseTool`.
 *
 * `toolName` should be the namespaced form (`mcp__<server>__<name>`) so it
 * matches the user's suppress list / ruleset globs / always-allow conventions.
 */
export function createToolPermissionGate({
  emit,
  sessionId,
  pendingApprovals,
  sendOptions,
  doomGuard,
}) {
  const ruleset = sendOptions?.permissionRuleset
  const suppress = Array.isArray(sendOptions?.suppressApprovalForTools)
    ? sendOptions.suppressApprovalForTools
    : null
  const alwaysAllow = Array.isArray(sendOptions?.alwaysAllowTools)
    ? sendOptions.alwaysAllowTools
    : null
  const canPrompt = typeof emit === "function" && pendingApprovals instanceof Map

  /**
   * @param {string} toolName   namespaced tool name
   * @param {any} input         tool args
   * @param {AbortSignal} [signal]  the step's abort signal (AI SDK execute
   *   options) — settles a pending approval as denied on interrupt so the tool
   *   execute (and the whole streamText leg) can't hang on a renderer that
   *   never answers.
   */
  return async function gate(toolName, input, signal) {
    // The `ask_user` elicitation tool is the user interaction itself: the
    // renderer's AskUserDialog blocks until the user answers, so it must never
    // be routed through the generic tool-approval modal — in ANY mode. Each
    // call is inherently human-gated (no runaway loop without a human answer),
    // so allow it unconditionally, ahead of the doom-loop guard. The plan-mode
    // branch below also permits it; this generalises that to every mode.
    {
      const parts = String(toolName).split("__")
      const bareName = parts.length >= 3 ? parts.slice(2).join("__") : String(toolName)
      if (bareName === ASK_USER_TOOL_NAME) return input
    }

    // Read the permission mode LIVE (not closed-over): a `claude_set_mode`
    // control message mutates `sendOptions.permissionMode` on the running
    // session, and the next tool gate must honour it without a respawn.
    const mode = sendOptions?.permissionMode

    // Doom-loop guard: the Nth identical call must round-trip through the
    // user even when a suppress-list / ruleset (or bypass mode) would allow it
    // silently. Computed FIRST so even bypassPermissions can't disarm the
    // runaway-loop protection.
    const doomed = doomGuard ? doomGuard.check(toolName, input) === "ask" : false

    // Workspace confinement (ADR-0028 lite): resolve once and reuse across the
    // mode branches. A "deny" (write into / symlink-escape toward a credential
    // path) is a hard security invariant enforced in EVERY mode, including
    // bypassPermissions — mirroring how deny rules survive bypass. An "ask"
    // (mutator escaping the workspace roots) suppresses the auto-approvals below
    // so the call round-trips through the user instead of being auto-allowed.
    let confVerdict = null
    try {
      confVerdict = classifyToolCallConfinement(
        sendOptions?.confinement,
        toolName,
        input,
        sendOptions?.cwd
      )
    } catch {
      confVerdict = null
    }
    if (confVerdict === "deny") {
      throw new Error(
        `denied: "${toolName}" resolves into a protected credential path (workspace confinement)`
      )
    }

    // Plan mode: enforce read-only here on the AI-SDK path (the Anthropic path
    // gets this from the SDK). Only read-only built-in tools — plus the
    // `exit_plan_mode` signal tool the model uses to submit its final plan, the
    // read-only-safe subagent-dispatch / `load_skill` plugin tools the plan
    // prompt instructs the model to use (see PLAN_ALLOWED_PLUGIN_TOOLS), and the
    // side-effect-free `ask_user` elicitation tool — may run; every
    // mutating/exec built-in, other plugin tool, or unknown tool is denied, so a
    // non-Anthropic provider in plan mode can't write/edit/bash.
    if (mode === "plan") {
      const parts = String(toolName).split("__")
      const server = parts.length >= 3 ? parts[1] : null
      const bare = parts.length >= 3 ? parts.slice(2).join("__") : String(toolName)
      const allowed =
        (server === SERVER_NAME &&
          (READ_ONLY_TOOL_NAMES.has(bare) || bare === EXIT_PLAN_TOOL_NAME)) ||
        (server === PLUGIN_TOOLS_SERVER_NAME && PLAN_ALLOWED_PLUGIN_TOOLS.has(bare)) ||
        bare === ASK_USER_TOOL_NAME
      if (!allowed) {
        throw new Error(`plan mode: tool "${toolName}" is not permitted (read-only tools only)`)
      }
      return input
    }

    // dontAsk: never prompt. Only pre-approved tools run — read-only built-ins
    // (auto-allowed in every mode), suppress/alwaysAllow entries, and ruleset
    // `allow` verdicts. Everything else is DENIED without prompting, surfaced
    // as a recoverable tool-error the model can react to (same mechanism as the
    // plan gate above). The Anthropic path gets these semantics natively from
    // the Agent SDK. `ask_user` stays allowed — it is short-circuited before
    // the mode read (it IS the user interaction, not an escalation). A doomed
    // Nth identical call is denied outright: we cannot prompt in dontAsk.
    if (mode === "dontAsk") {
      if (!doomed) {
        const parts = String(toolName).split("__")
        const server = parts.length >= 3 ? parts[1] : null
        const bare = parts.length >= 3 ? parts.slice(2).join("__") : String(toolName)
        if (server === SERVER_NAME && READ_ONLY_TOOL_NAMES.has(bare)) return input
        if (suppress && suppress.includes(toolName)) return input
        if (alwaysAllow && alwaysAllow.includes(toolName)) return input
        if (ruleset) {
          let verdict
          try {
            verdict = resolveForToolCall(ruleset, toolName, input)
          } catch {
            verdict = undefined
          }
          // A confinement "ask" cannot be honoured in dontAsk (no prompt), so an
          // out-of-workspace mutator stays denied even with an allow rule.
          if (verdict === "allow" && confVerdict !== "ask") return input
        }
      }
      throw new Error(
        `dontAsk mode: tool "${toolName}" is not pre-approved (no allow rule), so it was denied without prompting. Proceed without it, or ask the user to add an allow rule or switch permission modes.`
      )
    }

    // "auto" mode is deliberately NOT special-cased here: it falls through to
    // suppress/alwaysAllow/ruleset and then emits a `permission_request`, which
    // the RENDERER answers via the Layer-B auto-mode runner (command judge /
    // safety classifier) instead of a human prompt (ADR-0041).

    // bypassPermissions skips approvals — but NOT the doom guard above.
    if (mode === "bypassPermissions" && !doomed) return input

    // acceptEdits: auto-approve the file-edit-class built-ins (see
    // ACCEPT_EDITS_TOOL_NAMES) so the AI-SDK path matches the Anthropic SDK's
    // native acceptEdits — a user who accepted edits isn't re-prompted per
    // write/edit. Also what lets `/agents run` in acceptEdits actually write
    // (its headless gate has no interactive prompt). Exec/process/git/unknown
    // tools fall through to the normal policy; the doom guard still fires.
    if (mode === "acceptEdits" && !doomed) {
      const parts = String(toolName).split("__")
      const server = parts.length >= 3 ? parts[1] : null
      const bare = parts.length >= 3 ? parts.slice(2).join("__") : String(toolName)
      // A confinement "ask" (edit escaping the workspace roots) overrides the
      // acceptEdits auto-approval and falls through to the prompt.
      if (server === SERVER_NAME && ACCEPT_EDITS_TOOL_NAMES.has(bare) && confVerdict !== "ask") {
        return input
      }
    }

    if (!doomed) {
      if (suppress && suppress.includes(toolName)) return input
      if (alwaysAllow && alwaysAllow.includes(toolName)) return input
    }

    if (ruleset && !doomed) {
      let verdict
      try {
        verdict = resolveForToolCall(ruleset, toolName, input)
      } catch {
        verdict = undefined // resolver error → fall through to the prompt
      }
      // A confinement "ask" (out-of-workspace mutator) overrides a ruleset
      // allow and falls through to the approval round-trip below.
      if (verdict === "allow" && confVerdict !== "ask") return input
      if (verdict === "deny") throw new Error(`denied by permission ruleset: ${toolName}`)
    }

    // No channel to prompt the user (headless / no responder). We CANNOT
    // obtain consent, so we must NOT silently run arbitrary tools — the prior
    // fail-OPEN here let a local model run shell/process/edit tools unprompted
    // (it directly contradicted this module's stated goal). Allow only
    // read-only built-ins, which cannot mutate the host; deny every
    // mutating/exec, plugin, or unknown tool. A headless caller that genuinely
    // needs those opts in explicitly via `bypassPermissions`, a suppress entry,
    // an `alwaysAllow` entry, or an `allow` ruleset — all handled above, so by
    // here none applied.
    if (!canPrompt) {
      const parts = String(toolName).split("__")
      const isReadOnlyBuiltin =
        parts.length >= 3 &&
        parts[1] === SERVER_NAME &&
        READ_ONLY_TOOL_NAMES.has(parts.slice(2).join("__"))
      if (isReadOnlyBuiltin) return input
      throw new Error(
        `denied: no approval channel to authorize "${toolName}" — set bypassPermissions or an allow rule to run tools in a headless context`
      )
    }

    const requestId = randomUUID()
    emit({
      type: "permission_request",
      sessionId,
      requestId,
      toolName,
      displayName: toolName,
      input,
      ...(sendOptions.remoteExecutionContext
        ? { remoteExecutionContext: sendOptions.remoteExecutionContext }
        : {}),
    })
    const decision = await new Promise((resolve) => {
      let onAbort = null
      const settle = (result) => {
        if (onAbort && signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", onAbort)
        }
        resolve(result)
      }
      // Stash the original input so an approved-unmodified call resolves with a
      // concrete `updatedInput` (parity with the Agent-SDK path's host handler).
      pendingApprovals.set(requestId, { resolve: settle, input })
      if (signal) {
        onAbort = () => {
          if (pendingApprovals.delete(requestId)) {
            settle({ behavior: "deny", message: "aborted" })
          }
        }
        if (signal.aborted) onAbort()
        else if (typeof signal.addEventListener === "function") {
          signal.addEventListener("abort", onAbort, { once: true })
        }
      }
    })
    if (decision && decision.behavior === "deny") {
      throw new Error(decision.message ?? `denied: ${toolName}`)
    }
    return decision && decision.updatedInput !== undefined ? decision.updatedInput : input
  }
}

/**
 * Convert one built-in `SdkMcpToolDefinition` into an AI SDK tool. The built-in
 * handler returns an MCP `CallToolResult`; we flatten it to text and re-throw on
 * `isError` so the AI SDK surfaces a `tool-error` (which the model can recover
 * from across steps). Execution is gated through `gate` when supplied.
 */
/** Does an MCP CallToolResult carry an image block (multimodal read)? */
function hasImageBlock(result) {
  return Array.isArray(result?.content) && result.content.some((b) => b && b.type === "image")
}

/**
 * Does an MCP CallToolResult carry content that must remain structured for the
 * model-output mapper? Text-only results keep their legacy flattened behavior.
 */
function hasRichContentBlock(result) {
  return (
    Array.isArray(result?.content) &&
    result.content.some(
      (b) =>
        b &&
        (b.type === "image" ||
          b.type === "audio" ||
          b.type === "resource" ||
          b.type === "resource_link")
    )
  )
}

/**
 * AI SDK 7 collapsed the `image-*` / `file-*` tool-result content variants into
 * one canonical `file` part carrying a TAGGED data union — images are just files
 * with an image media type, so the image/non-image split is gone. `{ type:
 * 'data', data }` is the inline-bytes/base64 arm; `url`, `reference` and `text`
 * are the others. v7 still auto-migrates the legacy shapes at runtime, but only
 * until the next major.
 */
function binaryModelPart(data, mediaType, filename) {
  return {
    type: "file",
    mediaType,
    data: { type: "data", data },
    ...(filename ? { filename } : {}),
  }
}

function isTextualMediaType(mediaType) {
  const mime = String(mediaType ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase()
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript" ||
    mime === "application/x-www-form-urlencoded"
  )
}

function decodeBase64Utf8(data) {
  const compact = data.replace(/\s/g, "")
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error(TOOL_RESULT_PII_ERROR)
  }
  const bytes = Buffer.from(compact, "base64")
  const canonical = bytes.toString("base64").replace(/=+$/, "")
  if (canonical !== compact.replace(/=+$/, "")) throw new Error(TOOL_RESULT_PII_ERROR)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(TOOL_RESULT_PII_ERROR)
  }
}

function redactTextualResourceBlobs(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== "object") return value
  if (value instanceof Date) return value
  if (seen.has(value)) return "[circular tool output omitted]"
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => redactTextualResourceBlobs(item, seen))
  }
  if (value instanceof Map) {
    return new Map(
      [...value.entries()].map(([key, inner]) => [
        redactTextualResourceBlobs(key, seen),
        redactTextualResourceBlobs(inner, seen),
      ])
    )
  }
  if (value instanceof Set) {
    return new Set([...value].map((item) => redactTextualResourceBlobs(item, seen)))
  }
  const copy = {}
  for (const [key, inner] of Object.entries(value)) {
    copy[key] = redactTextualResourceBlobs(inner, seen)
  }
  if (
    value.type === "resource" &&
    value.resource &&
    typeof value.resource === "object" &&
    typeof value.resource.blob === "string" &&
    isTextualMediaType(value.resource.mimeType)
  ) {
    const decoded = decodeBase64Utf8(value.resource.blob)
    copy.resource.blob = Buffer.from(redactText(decoded).redacted, "utf8").toString("base64")
  }
  return copy
}

function redactToolOutputDeep(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    const trimmed = value.trim()
    // Text-only tools often flatten structured output to JSON. Redacting the
    // entire serialized string can classify long numeric timestamps as PII and
    // splice placeholders into number tokens, producing invalid JSON. Parse
    // object/array JSON first so only its actual string values are redacted.
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(redactToolOutputDeep(JSON.parse(value), seen))
      } catch {
        // Ordinary text can begin with a brace; fall through to text redaction.
      }
    }
    return redactText(value).redacted
  }
  if (value === null || value === undefined) return value
  if (typeof value !== "object" || value instanceof Date) return value
  if (seen.has(value)) return "[circular tool output omitted]"
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactToolOutputDeep(item, seen))
  if (value instanceof Map) {
    return new Map(
      [...value.entries()].map(([key, inner]) => [
        redactToolOutputDeep(key, seen),
        redactToolOutputDeep(inner, seen),
      ])
    )
  }
  if (value instanceof Set) {
    return new Set([...value].map((item) => redactToolOutputDeep(item, seen)))
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, redactToolOutputDeep(inner, seen)])
  )
}

function hasNoLeakingPiiToolOutput(output) {
  if (typeof output === "string") {
    const trimmed = output.trim()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return hasNoLeakingPiiDeep(JSON.parse(output))
      } catch {
        // Not valid structured output; scan it as ordinary text below.
      }
    }
  }
  return hasNoLeakingPiiDeep(output)
}

function assertModelSafeToolOutput(output) {
  // Embedded textual resources cross the provider boundary as base64 file
  // parts. Decode them before scanning; otherwise the encoded bytes look like
  // an opaque safe token while the model decodes the original PII.
  const decodedSafe = redactTextualResourceBlobs(output)
  if (hasNoLeakingPiiToolOutput(decodedSafe)) return decodedSafe
  const redacted = redactToolOutputDeep(decodedSafe)
  if (!hasNoLeakingPiiToolOutput(redacted)) throw new Error(TOOL_RESULT_PII_ERROR)
  return redacted
}

/**
 * Map a tool's execute output to an AI SDK v6 model output. Text results stay
 * plain text (unchanged behavior); image, audio, and embedded-resource results
 * become content parts so models receive the actual payload.
 *
 * Image blocks are emitted as the current `image-data` part (a base64 image),
 * NOT the legacy `media` part — `media` is `@deprecated` in AI SDK v6 and only
 * survives via a runtime up-conversion. Emitting `image-data` directly keeps the
 * tool-result output on the supported, forward-compatible shape.
 */
function builtinToModelOutput({ output }) {
  if (typeof output === "string") return { type: "text", value: output }
  const blocks = Array.isArray(output?.content) ? output.content : []
  const value = []
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      value.push({ type: "text", text: b.text })
    } else if (b.type === "image" && b.data) {
      const mediaType = b.mimeType ?? "image/png"
      value.push(binaryModelPart(b.data, mediaType))
    } else if (b.type === "audio" && b.data) {
      value.push(binaryModelPart(b.data, b.mimeType ?? "audio/mpeg"))
    } else if (b.type === "resource" && b.resource) {
      const resource = b.resource
      if (typeof resource.text === "string") {
        value.push({ type: "text", text: resource.text })
      } else if (typeof resource.blob === "string") {
        value.push(
          binaryModelPart(
            resource.blob,
            resource.mimeType ?? "application/octet-stream",
            resource.name ?? resource.title
          )
        )
      }
    } else if (b.type === "resource_link" && typeof b.uri === "string") {
      const label =
        typeof b.name === "string" && b.name.length > 0
          ? `${b.name}: `
          : typeof b.title === "string" && b.title.length > 0
            ? `${b.title}: `
            : ""
      value.push({ type: "text", text: `${label}${b.uri}` })
    }
  }
  return { type: "content", value }
}

/**
 * Apply the PostToolUse review (renderer round-trip) to a tool's EXECUTE-layer
 * output — this is the only layer where a rewrite actually reaches the model:
 * streamText persists the execute return into the conversation, so a rewrite
 * applied later (e.g. on the fullStream tool-result event) is display-only.
 * `review` returns the updated output, or undefined/null to pass through.
 */
async function applyOutputReview(review, namespaced, toolCallId, output, isError) {
  if (typeof review !== "function") return output
  try {
    const updated = await review(namespaced, toolCallId, output, isError)
    return updated === undefined || updated === null ? output : updated
  } catch {
    return output // fail-open: a broken reviewer never loses a tool result
  }
}

function builtinDefToAiSdkTool(def, gate, timeoutMs, reviewToolOutput) {
  const namespaced = `mcp__${SERVER_NAME}__${def.name}`
  return tool({
    description: def.description ?? "",
    inputSchema: z.object(def.inputSchema ?? {}),
    execute: async (args, options) => {
      const effective = gate
        ? await gate(namespaced, args ?? {}, options?.abortSignal)
        : (args ?? {})
      let result
      try {
        result = await runBuiltinHandler(def, effective, timeoutMs, options?.abortSignal)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const reviewed = await applyOutputReview(
          reviewToolOutput,
          namespaced,
          options?.toolCallId,
          msg,
          true
        )
        const safe = String(assertModelSafeToolOutput(reviewed))
        throw reviewed === msg && safe === msg ? err : new Error(safe)
      }
      if (result && result.isError) {
        const msg = callToolResultToText(result) || `${def.name} failed`
        const reviewed = await applyOutputReview(
          reviewToolOutput,
          namespaced,
          options?.toolCallId,
          msg,
          true
        )
        const safe = assertModelSafeToolOutput(reviewed)
        throw new Error(String(safe))
      }
      // Structured content passes through as the raw MCP object for
      // toModelOutput; text-only results keep the established flattening.
      const out = hasRichContentBlock(result) ? result : callToolResultToText(result)
      const reviewed = await applyOutputReview(
        reviewToolOutput,
        namespaced,
        options?.toolCallId,
        out,
        false
      )
      return assertModelSafeToolOutput(reviewed)
    },
    toModelOutput: builtinToModelOutput,
  })
}

/**
 * Convert a plugin tool manifest entry into an AI SDK tool whose `execute`
 * round-trips through the renderer over stdio: it emits `plugin_tool_exec` and
 * awaits a `plugin_tool_response` resolved via `pendingPluginToolCalls` (the
 * same Map claude-host populates for the Anthropic path). Execution is gated.
 */
function pluginToolToAiSdkTool(
  manifest,
  {
    emit,
    sessionId,
    pendingPluginToolCalls,
    gate,
    reviewToolOutput,
    remoteExecutionContext,
    sandboxRuntimeRef,
    turnId,
    attemptId,
  }
) {
  const namespaced = `mcp__${PLUGIN_TOOLS_SERVER_NAME}__${manifest.name}`
  return tool({
    description: manifest.description ?? "",
    inputSchema: jsonSchema(manifest.jsonSchema ?? { type: "object", properties: {} }),
    execute: async (args, options) => {
      const effective = gate
        ? await gate(namespaced, args ?? {}, options?.abortSignal)
        : (args ?? {})
      const toolUseId = randomUUID()
      // Preserve the manifest's lifecycle contract on the AI SDK rail just as
      // buildPluginToolsServer does on the Anthropic rail. In particular,
      // dispatch_agent/ask_user declare `timeoutMs: 0`: the child run or human
      // interaction owns its own bounds, so the generic 120s relay timeout must
      // not sever a still-live round-trip while the renderer keeps working.
      const pending = awaitPluginToolResponse(
        pendingPluginToolCalls,
        toolUseId,
        manifest.name,
        typeof manifest.timeoutMs === "number" ? manifest.timeoutMs : undefined
      )
      emit({
        type: "plugin_tool_exec",
        sessionId,
        toolUseId,
        name: manifest.name,
        args: effective,
        ...(turnId ? { turnId } : {}),
        ...(attemptId ? { attemptId } : {}),
        ...(sandboxRuntimeRef ? { sandboxRuntimeRef } : {}),
        ...(remoteExecutionContext ? { remoteExecutionContext } : {}),
      })
      const response = await pending
      if (response && response.error) {
        const msg = String(response.error)
        const reviewed = await applyOutputReview(
          reviewToolOutput,
          namespaced,
          options?.toolCallId,
          msg,
          true
        )
        const safe = assertModelSafeToolOutput(reviewed)
        throw new Error(String(safe))
      }
      const payload = response ? response.result : null
      // A plugin that already speaks MCP passes its content blocks straight
      // through for `builtinToModelOutput` to map — the same treatment built-in
      // tools get above. Without this a plugin can only ever return text, so an
      // media result reaches the model (and the chat) as base64 gibberish.
      const out = hasRichContentBlock(payload)
        ? payload
        : typeof payload === "string"
          ? payload
          : JSON.stringify(payload ?? null)
      const reviewed = await applyOutputReview(
        reviewToolOutput,
        namespaced,
        options?.toolCallId,
        out,
        false
      )
      return assertModelSafeToolOutput(reviewed)
    },
    toModelOutput: builtinToModelOutput,
  })
}

/**
 * Build the AI SDK `tools` map for a turn: built-in tools gated by enabled
 * categories (`sendOptions.builtinTools`) plus any renderer-proxied plugin
 * tools (`sendOptions.pluginTools`). Returns `{}` when nothing is available, so
 * the dispatcher can omit the `tools` option entirely.
 *
 * @param {{
 *   sendOptions: Record<string, any>,
 *   emit: (msg: any) => void,
 *   sessionId: string,
 *   pendingApprovals?: Map<string, { resolve: (r: any) => void }>,
 *   pendingPluginToolCalls?: Map<string, { resolve: (r: any) => void }>,
 *   lspResolver?: unknown,
 *   codeGraphResolver?: unknown,
 *   readTracker?: unknown,
 *   taskStore?: unknown,
 * }} params
 * @returns {Record<string, ReturnType<typeof tool>>}
 */
export function buildAiSdkTools({
  sendOptions,
  emit,
  sessionId,
  pendingApprovals,
  pendingPluginToolCalls,
  lspResolver,
  codeGraphResolver,
  readTracker,
  bgShells,
  hostRpc,
  taskStore,
  doomGuard: providedDoomGuard,
  reviewToolOutput,
}) {
  // An empty `allowedTools` array means "no filtering" on this path. Honor the
  // explicit runtime-wide deny-all contract before collecting any built-in or
  // plugin definitions so Support sessions cannot inherit a tool accidentally.
  if (sendOptions.toolSurface === "none") return {}

  /** @type {Record<string, ReturnType<typeof tool>>} */
  const tools = {}
  // Accept a caller-owned guard so the session can `reset()` it per turn (the
  // guard counts identical-call repetition WITHIN a turn — matching the
  // Anthropic path, which gets a fresh guard per `query()`). Falls back to an
  // owned guard for callers/tests that don't pass one.
  const doomGuard = providedDoomGuard ?? createDoomLoopGuard()
  const gate = createToolPermissionGate({
    emit,
    sessionId,
    pendingApprovals,
    sendOptions,
    doomGuard,
  })

  // Deny-list enforcement. The Anthropic path delegates allowed/disallowed
  // tool filtering to the agent SDK; `streamText` has no such concept, so the
  // bridge must honour `disallowedTools` itself — restricted mode (untrusted
  // workspace) and the IM-channel blacklist both arrive through it. Entries
  // may be bare (`bash`) or namespaced (`mcp__cognia-tools__bash`).
  const disallowed = new Set(
    Array.isArray(sendOptions.disallowedTools) ? sendOptions.disallowedTools : []
  )
  const isDisallowed = (bareName) =>
    disallowed.has(bareName) || disallowed.has(`mcp__${SERVER_NAME}__${bareName}`)

  // Allow-list enforcement (parity with the Anthropic path, where the agent
  // SDK applies `allowedTools` itself). When a character / skill / mode scopes
  // the tool palette, the AI-SDK path must honour it too — previously the
  // whitelist was built by `resolveSendOptions` but never consulted here, so a
  // restricted character silently kept its full tool set on non-Anthropic
  // providers. Deny (`disallowedTools`, checked separately) still wins.
  const allowSet =
    Array.isArray(sendOptions.allowedTools) && sendOptions.allowedTools.length > 0
      ? new Set(sendOptions.allowedTools)
      : null

  // Per-tool execution deadline for read-only built-ins (see
  // `DEFAULT_BUILTIN_TOOL_TIMEOUT_MS`). Honour an explicit override (incl. `0` to
  // disable); fall back to the default safety net otherwise.
  const builtinToolTimeoutMs =
    typeof sendOptions.toolExecutionTimeoutMs === "number"
      ? sendOptions.toolExecutionTimeoutMs
      : DEFAULT_BUILTIN_TOOL_TIMEOUT_MS

  for (const def of collectCogniaToolDefs({
    enabled: sendOptions.builtinTools,
    lspResolver,
    codeGraphResolver,
    readTracker,
    cwd: sendOptions.cwd,
    dispatchPath: "ai-sdk",
    bgShells,
    hostRpc,
    sessionId,
    taskStore,
    model: sendOptions.model,
    provider: sendOptions.provider,
    // ADR-0117: the frozen composition decides which tool surface the model
    // sees. Read from the send spec rather than re-derived here, so renderer
    // and sidecar cannot disagree about what this turn is.
    toolPresentation: sendOptions.execution?.composition?.toolPresentation,
    // ADR-0045 plan authoring — same default as the Anthropic path.
    planTools: sendOptions.planTools !== false,
  })) {
    if (!def || !def.name || isDisallowed(def.name)) continue
    const candidates = [def.name, `mcp__${SERVER_NAME}__${def.name}`]
    const alias = CLAUDE_TOOL_NAME_BY_COGNIA_BARE[def.name]
    if (alias) candidates.push(alias)
    if (!passesAllowList(allowSet, candidates)) continue
    tools[def.name] = markAiSdkToolSource(
      builtinDefToAiSdkTool(def, gate, builtinToolTimeoutMs, reviewToolOutput),
      {
        serverName: SERVER_NAME,
        alwaysLoad: def?._meta?.["anthropic/alwaysLoad"] === true,
      }
    )
  }

  if (Array.isArray(sendOptions.pluginTools) && pendingPluginToolCalls) {
    for (const manifest of sendOptions.pluginTools) {
      if (!manifest || !manifest.name) continue
      if (
        disallowed.has(manifest.name) ||
        disallowed.has(`mcp__${PLUGIN_TOOLS_SERVER_NAME}__${manifest.name}`)
      ) {
        continue
      }
      if (
        !passesAllowList(allowSet, [
          manifest.name,
          `mcp__${PLUGIN_TOOLS_SERVER_NAME}__${manifest.name}`,
        ])
      ) {
        continue
      }
      tools[manifest.name] = markAiSdkToolSource(
        pluginToolToAiSdkTool(manifest, {
          emit,
          sessionId,
          pendingPluginToolCalls,
          gate,
          reviewToolOutput,
          remoteExecutionContext: sendOptions.remoteExecutionContext,
          sandboxRuntimeRef: sendOptions.sandboxRuntimeRef,
          turnId: sendOptions.turnId,
          attemptId: sendOptions.execution?.identity?.attemptId,
        }),
        { serverName: PLUGIN_TOOLS_SERVER_NAME }
      )
    }
  }

  // Rebuild in sorted-key order so the tools map serializes identically
  // across turns/sessions — built-in registry and pluginTools arrive in
  // registration order, and an unstable order silently breaks provider
  // prompt-cache prefix matching.
  /** @type {Record<string, ReturnType<typeof tool>>} */
  const sorted = {}
  for (const name of Object.keys(tools).sort()) sorted[name] = tools[name]
  return sorted
}

export const __testing__ = {
  builtinDefToAiSdkTool,
  pluginToolToAiSdkTool,
  applyOutputReview,
  callToolResultToText,
  runBuiltinHandler,
  builtinToModelOutput,
  hasImageBlock,
  hasRichContentBlock,
  assertModelSafeToolOutput,
  DEFAULT_BUILTIN_TOOL_TIMEOUT_MS,
}
