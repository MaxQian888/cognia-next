// AI SDK tool bridge for the non-Anthropic dispatch path.
//
// The Anthropic dispatcher hands built-in tools + plugin tools to the Claude
// Agent SDK as in-process MCP servers. The AI SDK has no MCP-server concept for
// `streamText`, so we convert the SAME built-in tool definitions (and the
// renderer-proxied plugin tools) into native AI SDK `tool()` objects keyed by
// name. This is what lets local / OpenAI / Gemini models actually call tools in
// the main chat — previously the ai-sdk path was text-only.
//
// Tool execution runs through the rail's permission gate
// (src/policy/permission/ai-sdk-gate.ts), so a local model can't silently run
// shell/process tools.

import { tool, jsonSchema } from "ai"
import { z } from "zod"
import { randomUUID } from "node:crypto"

import { collectCogniaToolDefs } from "../builtin-tools/index.mjs"
import {
  BUILTIN_SERVER_NAME as SERVER_NAME,
  READ_ONLY_TOOL_NAMES,
} from "../src/policy/tool-catalog/catalog.ts"
import { PLUGIN_TOOLS_SERVER_NAME } from "../src/policy/tool-catalog/names.ts"
import {
  DEFAULT_BUILTIN_TOOL_TIMEOUT_MS,
  toolBudgetMessage,
} from "../builtin-tools/read-only-timeout.mjs"

import { awaitPluginToolResponse } from "../builtin-tools/plugin-tools.mjs"
import { createToolPermissionGate } from "../src/policy/permission/ai-sdk-gate.ts"
import { createDoomLoopGuard } from "../src/policy/doom-loop.ts"
import { assertModelSafeToolOutput } from "../src/policy/pii/tool-output.ts"
import { markAiSdkToolSource } from "./ai-sdk-tool-search.mjs"

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
    builtinProcessSandbox: sendOptions.builtinProcessSandbox,
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
