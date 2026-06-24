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

import {
  collectCogniaToolDefs,
  SERVER_NAME,
  READ_ONLY_TOOL_NAMES,
} from "../builtin-tools/index.mjs"
import { EXIT_PLAN_TOOL_NAME } from "../builtin-tools/exit-plan.mjs"
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
import { createDoomLoopGuard } from "./doom-loop.mjs"

const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"

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
 */
function runBuiltinHandler(def, effective, timeoutMs) {
  const net = READ_ONLY_TOOL_NAMES.has(def.name) ? timeoutMs : 0
  const call = () => def.handler(effective, {})
  if (!Number.isFinite(net) || net <= 0) return call()
  let timer = null
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(toolBudgetMessage(def.name, net)))
    }, net)
    if (timer && typeof timer.unref === "function") timer.unref()
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

  return async function gate(toolName, input) {
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

    // Plan mode: enforce read-only here on the AI-SDK path (the Anthropic path
    // gets this from the SDK). Only read-only built-in tools — plus the
    // `exit_plan_mode` signal tool the model uses to submit its final plan and
    // the side-effect-free `ask_user` elicitation tool — may run; every
    // mutating/exec built-in, other plugin tool, or unknown tool is denied, so a
    // non-Anthropic provider in plan mode can't write/edit/bash.
    if (mode === "plan") {
      const parts = String(toolName).split("__")
      const server = parts.length >= 3 ? parts[1] : null
      const bare = parts.length >= 3 ? parts.slice(2).join("__") : String(toolName)
      const allowed =
        (server === SERVER_NAME &&
          (READ_ONLY_TOOL_NAMES.has(bare) || bare === EXIT_PLAN_TOOL_NAME)) ||
        bare === ASK_USER_TOOL_NAME
      if (!allowed) {
        throw new Error(`plan mode: tool "${toolName}" is not permitted (read-only tools only)`)
      }
      return input
    }

    // bypassPermissions skips approvals — but NOT the doom guard above.
    if (mode === "bypassPermissions" && !doomed) return input

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
      if (verdict === "allow") return input
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
    })
    const decision = await new Promise((resolve) => {
      // Stash the original input so an approved-unmodified call resolves with a
      // concrete `updatedInput` (parity with the Agent-SDK path's host handler).
      pendingApprovals.set(requestId, { resolve, input })
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
 * Map a tool's execute output to an AI SDK v6 model output. Text results stay
 * plain text (unchanged behavior); image results (from multimodal `read`)
 * become a multimodal content part so vision models see the actual image.
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
      // image/* → image-data; any other media type → file-data (e.g. audio).
      value.push(
        mediaType.startsWith("image/")
          ? { type: "image-data", mediaType, data: b.data }
          : { type: "file-data", mediaType, data: b.data }
      )
    }
  }
  return { type: "content", value }
}

function builtinDefToAiSdkTool(def, gate, timeoutMs) {
  const namespaced = `mcp__${SERVER_NAME}__${def.name}`
  return tool({
    description: def.description ?? "",
    inputSchema: z.object(def.inputSchema ?? {}),
    execute: async (args) => {
      const effective = gate ? await gate(namespaced, args ?? {}) : (args ?? {})
      const result = await runBuiltinHandler(def, effective, timeoutMs)
      if (result && result.isError) {
        throw new Error(callToolResultToText(result) || `${def.name} failed`)
      }
      // Image results pass through as the raw MCP object for toModelOutput;
      // every other result flattens to text (unchanged).
      return hasImageBlock(result) ? result : callToolResultToText(result)
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
function pluginToolToAiSdkTool(manifest, { emit, sessionId, pendingPluginToolCalls, gate }) {
  const namespaced = `mcp__${PLUGIN_TOOLS_SERVER_NAME}__${manifest.name}`
  return tool({
    description: manifest.description ?? "",
    inputSchema: jsonSchema(manifest.jsonSchema ?? { type: "object", properties: {} }),
    execute: async (args) => {
      const effective = gate ? await gate(namespaced, args ?? {}) : (args ?? {})
      const toolUseId = randomUUID()
      const pending = awaitPluginToolResponse(pendingPluginToolCalls, toolUseId, manifest.name)
      emit({
        type: "plugin_tool_exec",
        sessionId,
        toolUseId,
        name: manifest.name,
        args: effective,
      })
      const response = await pending
      if (response && response.error) throw new Error(String(response.error))
      const payload = response ? response.result : null
      return typeof payload === "string" ? payload : JSON.stringify(payload ?? null)
    },
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
 *   readTracker?: unknown,
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
  readTracker,
  bgShells,
}) {
  /** @type {Record<string, ReturnType<typeof tool>>} */
  const tools = {}
  const doomGuard = createDoomLoopGuard()
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
    readTracker,
    cwd: sendOptions.cwd,
    dispatchPath: "ai-sdk",
    bgShells,
    model: sendOptions.model,
    provider: sendOptions.provider,
  })) {
    if (!def || !def.name || isDisallowed(def.name)) continue
    const candidates = [def.name, `mcp__${SERVER_NAME}__${def.name}`]
    const alias = CLAUDE_TOOL_NAME_BY_COGNIA_BARE[def.name]
    if (alias) candidates.push(alias)
    if (!passesAllowList(allowSet, candidates)) continue
    tools[def.name] = builtinDefToAiSdkTool(def, gate, builtinToolTimeoutMs)
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
      tools[manifest.name] = pluginToolToAiSdkTool(manifest, {
        emit,
        sessionId,
        pendingPluginToolCalls,
        gate,
      })
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
  callToolResultToText,
  runBuiltinHandler,
  builtinToModelOutput,
  hasImageBlock,
  DEFAULT_BUILTIN_TOOL_TIMEOUT_MS,
}
