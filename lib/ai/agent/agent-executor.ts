/**
 * Agent executor entrypoint.
 *
 * Plugins call `executeAgent(prompt, config)` to dispatch a one-shot
 * agent run. cognia-next's authoritative agent execution path is the
 * tool-enabled Claude SDK invocation driven through the Tauri sidecar
 * (`lib/claude/run-and-capture.ts` + `lib/claude/build-options.ts`).
 *
 * Two execution channels:
 *  - `channel: "sidecar"` — when `config.toolsEnabled` is set AND the
 *    desktop sidecar is available, the run rides the SAME tool-enabled
 *    pipeline connectors and the `agent.turn` workflow node use, so the
 *    agent can actually call Bash/Read/Edit/plugin tools (subject to the
 *    existing per-tool approval gate). This closes the long-standing
 *    "tools accepted but dropped" gap.
 *  - `channel: "text"` — the web/mobile fallback (or when tools were not
 *    requested): a single `streamText` completion with the resolved
 *    provider. No tool dispatch is possible without the sidecar.
 *
 * The result always reports which channel ran and whether tools were
 * available, so callers can degrade gracefully.
 */

import { streamText } from "ai"
import {
  createFeatureProviderModel,
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
  type ProviderSettingsEntry,
  type CustomProviderDefinition,
} from "@/lib/ai/provider-consumption"
import type { Character } from "@/lib/claude/types"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import type { DispatchContext } from "@/lib/claude/agents/dispatch-context-registry"
import type { ExternalSessionPermissionSpec } from "@/lib/ai/agent/external/permission-cascade"
import { buildJsonInstruction, parseStructured } from "@/lib/workflow/nodes/ai/structured"
import type {
  PluginAgentOutputFormat,
  PluginToolPermissionFn,
} from "@/types/plugin/plugin-agent-sdk"
import type { PluginPostToolUseFn } from "@/types/plugin/plugin-agent-hooks"

export interface AgentTool {
  /** Stable id; defaults to `name` when the caller omits it. */
  id?: string
  name: string
  description?: string
  schema?: Record<string, unknown>
  /**
   * Parameter definition consumed by the AI SDK's tool-calling layer.
   * Either a JSON-Schema literal or a Zod schema (the bridge converts
   * raw JSON Schema to Zod and forwards it as-is). Mirrors `schema` for
   * plugin authors who used the older field name; both are accepted,
   * `parameters` wins when set.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters?: Record<string, unknown> | any
  /**
   * When true, the host pauses before invoking the tool and asks the
   * user (or the permission guard) to approve. Plugin authors set this
   * for actions with side effects.
   */
  requiresApproval?: boolean
  /**
   * Tool implementation. Returns a JSON-serialisable result. The
   * runtime wraps non-Promise returns in `Promise.resolve()` so callers
   * can always `.then` / `.catch`.
   */
  execute: (input: Record<string, unknown>) => Promise<unknown>
  /**
   * Optional per-tool permission gate (allow / deny / rewrite args). Composes
   * with a run-level `canUseTool`; the tool-level gate runs first.
   */
  canUseTool?: PluginToolPermissionFn
}

export interface ExecuteAgentConfig {
  systemPrompt?: string
  model?: string
  tools?: AgentTool[]
  maxSteps?: number
  temperature?: number
  abortSignal?: AbortSignal
  /**
   * Provider snapshot inputs. When omitted, the executor falls back to
   * the user's default provider via the snapshot helpers — but the
   * caller must pass them in if they want a specific provider.
   */
  providerSettings?: Record<string, ProviderSettingsEntry>
  customProviders?: CustomProviderDefinition[]
  defaultProvider?: string
  /**
   * Per-run provider override (cross-provider subagents). When set, this run
   * targets THIS provider instead of the default — on the sidecar channel via
   * the session's `providerOverride`, on the text channel as the explicit
   * `resolveFeatureProvider` provider id. Lets a subagent run on a different
   * provider than the dispatching session (e.g. a DeepSeek chat delegating to a
   * Claude reviewer). Omit to inherit the default/session provider.
   */
  provider?: string
  /**
   * Opt into the tool-enabled sidecar pipeline. When `true` AND the
   * desktop sidecar is reachable, the run goes through `resolveSendOptions`
   * + `runAndCaptureAssistantReply` so the host's tool surface (Bash, Read,
   * Edit, plugin tools, MCP, …) is available. When the sidecar is absent
   * (web/mobile) the run silently degrades to the text-only channel and
   * `toolsAvailable` comes back `false`.
   */
  toolsEnabled?: boolean
  /**
   * Resolve an existing persona for the tool-enabled run (its system
   * prompt, model, allowed tools, skills, MCP servers, computer-use config
   * all flow through `resolveSendOptions`). When omitted, a minimal
   * in-memory character is synthesised from `systemPrompt` / `model` /
   * `allowedTools`. Ignored on the text-only channel.
   */
  characterId?: string
  /** Absolute working directory the tool-enabled run is scoped to. */
  cwd?: string
  /** Restrict the tool surface for the synthesised character. */
  allowedTools?: string[]
  /** Wall-clock timeout (ms) for the tool-enabled run. Defaults to the runner's own default. */
  timeoutMs?: number
  /**
   * Live text deltas (text channel only — the sidecar stream is not
   * re-chunked here). Lets workflow nodes surface streaming output.
   */
  onDelta?: (delta: string) => void
  /**
   * Append to the resolved system prompt instead of replacing it
   * (preset-with-append). On the sidecar channel this rides
   * `SendOptions.appendSystemPrompt` so character/skill blocks are preserved.
   */
  appendSystem?: string
  /**
   * Request structured JSON output. A JSON-only instruction is appended to the
   * system prompt and the final text is parsed via `parseStructured`; the
   * parsed value lands on `result.object` (parse failures surface on
   * `result.parseError`, never thrown). Reuses the repo's JSON-mode idiom — no
   * native `generateObject`.
   */
  outputFormat?: PluginAgentOutputFormat
  /**
   * Per-tool-call permission gate. On the sidecar channel it answers the
   * sidecar's `permission_request` round-trip (so it can allow / deny /
   * **rewrite** tool arguments). Only *ask*-tier tools reach it.
   */
  canUseTool?: PluginToolPermissionFn
  /**
   * Typed stream events (text deltas + tool calls). On the sidecar channel
   * these come from the capture loop; on the text channel only text deltas.
   */
  onEvent?: (event: CaptureStreamEvent) => void
  /**
   * PostToolUse lifecycle hook. Fired after each tool returns on the sidecar
   * channel (driven from the capture loop's `tool-result` events). Observational
   * here; a returned `updatedToolOutput` is honored only when the tool-result
   * review round-trip is engaged (see {@link onToolResultReview}). Never fires on
   * the text channel (no tools run).
   */
  onPostToolUse?: PluginPostToolUseFn
  /**
   * Run this turn on an EXISTING persistent session instead of an ephemeral
   * one. The session is NOT deleted afterwards and its SDK session id is
   * persisted for resume (the sidecar continues the conversation on the next
   * send). Powers the plugin Agent SDK's multi-turn sessions (Package D).
   */
  sessionId?: string
  /**
   * Prior conversation turns, used ONLY on the text channel to give a
   * degraded multi-turn experience where the sidecar (and its native resume)
   * is unavailable. Ignored on the sidecar channel (resume handles continuity).
   */
  priorMessages?: Array<{ role: "user" | "assistant"; content: string }>
  /**
   * Nested-dispatch context for this run (depth, maxDepth, parent chain). When
   * present, the run is a dispatched subagent: the executor registers it by the
   * ephemeral session id so the `dispatch_agent` host tool can thread depth, and
   * `resolveSendOptions` gates whether THIS run is itself offered `dispatch_agent`
   * (only when `depth < maxDepth`). Absent for top-level chat / plain plugin runs.
   */
  dispatchContext?: DispatchContext
  /**
   * True when this run is a dispatched subagent (set unconditionally by
   * `dispatchSubagent`). A dispatched run WITHOUT a `dispatchContext` is a
   * LEAF (its def never opted into nesting): `resolveDispatchAgentGate` must
   * withhold `dispatch_agent` from it — including the plan-mode force-offer —
   * instead of treating it as a top-level chat (CLI leaf parity).
   */
  isDispatchedSubagent?: boolean
  /**
   * Parent permission ceiling for this dispatched run. Threaded into
   * `resolveSendOptions` so the child's resolved tool surface is intersected /
   * unioned / mode-clamped against the parent (fail-closed). Set by the
   * `dispatch_agent` host tool from the caller's resolved ceiling. Absent for a
   * top-level / unconstrained run (no parent ⇒ no ceiling).
   */
  permissionCeiling?: ExternalSessionPermissionSpec
  /**
   * Permission-ask routing for a dispatched run: registered under the child's
   * ephemeral session id so the renderer's `permission_request` listener can
   * re-bucket asks into the PARENT chat session instead of auto-denying against
   * the unopened ephemeral session. Set by the `dispatch_agent` host tool.
   */
  approvalRoute?: import("@/types/plugin/plugin-agent-sdk").PluginDispatchApprovalRoute
}

export type ExecuteAgentChannel = "sidecar" | "text"

export interface ExecuteAgentResult {
  text: string
  finishReason?: string
  /** Which execution channel actually ran. */
  channel: ExecuteAgentChannel
  /** Whether the tool-enabled loop was used (true only on the sidecar channel). */
  toolsAvailable: boolean
  /**
   * Token usage when the channel reports it (text channel via the AI SDK;
   * the sidecar pipeline does not surface usage here). Undefined otherwise.
   */
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  /** Parsed object when `outputFormat` was requested and parsing succeeded. */
  object?: unknown
  /** Set (never thrown) when structured parsing failed. */
  parseError?: string
}

/**
 * Build the structured-output JSON instruction appended to the system prompt
 * when `outputFormat` is requested. Stringifies the schema for the model.
 */
function structuredInstruction(outputFormat: PluginAgentOutputFormat | undefined): string {
  if (!outputFormat) return ""
  let schemaText: string
  try {
    schemaText = JSON.stringify(outputFormat.schema, null, 2)
  } catch {
    schemaText = ""
  }
  return buildJsonInstruction(schemaText)
}

/** Join a base system prompt with optional append + structured instruction. */
export function composeSystem(
  base: string | undefined,
  ...extra: Array<string | undefined>
): string {
  return [base, ...extra].filter((s): s is string => Boolean(s && s.trim())).join("\n\n")
}

/**
 * Adapt a {@link PluginToolPermissionFn} into the capture layer's
 * `onPermissionRequest` responder (`approveTool` decision shape).
 */
function permissionResponderFor(
  canUseTool: PluginToolPermissionFn | undefined,
  signal: AbortSignal | undefined
) {
  if (!canUseTool) return undefined
  return async (req: { toolName: string; input: Record<string, unknown> }) => {
    const decision = await canUseTool(req.toolName, req.input, { signal })
    if (decision.behavior === "deny") {
      return { decision: "deny" as const, message: decision.message }
    }
    return { decision: "allow" as const, updatedInput: decision.updatedInput }
  }
}

/**
 * Adapt a {@link PluginPostToolUseFn} into the capture layer's
 * `onToolResultReview` responder. The capture loop calls this once per tool
 * result — at the rewrite round-trip on the ai-sdk channel (where
 * `updatedToolOutput` is honored) or at observation otherwise (where it is
 * ignored). The single firing point lives in the capture loop so the hook is
 * never called twice for the same tool.
 */
function toolResultReviewResponderFor(
  onPostToolUse: PluginPostToolUseFn | undefined,
  signal: AbortSignal | undefined
) {
  if (!onPostToolUse) return undefined
  return async (req: {
    toolName: string
    input: Record<string, unknown>
    result: unknown
    isError: boolean
  }) => {
    const r = await onPostToolUse(
      { toolName: req.toolName, input: req.input, result: req.result, isError: req.isError },
      { ...(signal ? { signal } : {}) }
    )
    return { updatedToolOutput: r ? r.updatedToolOutput : undefined }
  }
}

/**
 * Build a minimal in-memory `Character` from a config that has no
 * `characterId`. Mirrors `lib/ai/agent/team/teammate-character.ts` — the
 * synthesised character is never persisted, it is handed straight to
 * `resolveSendOptions` as `BuildOptionsContext.character`.
 */
function synthesizeCharacter(config: ExecuteAgentConfig): Character {
  const ts = Date.now()
  return {
    id: "__plugin-agent__",
    name: "Plugin Agent",
    avatarColor: "oklch(0.6 0 0)",
    systemPrompt: config.systemPrompt?.trim() || "You are a focused, helpful agent.",
    createdAt: ts,
    updatedAt: ts,
    ...(config.model ? { model: config.model } : {}),
    ...(config.allowedTools && config.allowedTools.length > 0
      ? { allowedTools: [...config.allowedTools] }
      : {}),
    ...(config.cwd ? { workingDir: config.cwd } : {}),
  }
}

/**
 * Run one tool-enabled turn through the desktop sidecar. Creates a fresh
 * ephemeral session (the sidecar tracks one in-flight query per session id),
 * resolves the full send options, drives `runAndCaptureAssistantReply`, and
 * tears the session down afterwards — exactly the path the `agent.turn`
 * workflow node and teammate dispatch already use, now sanctioned for plugins.
 */
async function runToolEnabledStandalone(
  prompt: string,
  config: ExecuteAgentConfig
): Promise<{ text: string; usage?: ExecuteAgentResult["usage"] }> {
  const [
    { resolveCharacterById },
    sessionsDb,
    settingsDb,
    buildOpts,
    runner,
    { registerDispatchContext, clearDispatchContext, clearResolvedPermissionCeiling },
  ] = await Promise.all([
    import("@/lib/db/characters"),
    import("@/lib/db/sessions"),
    import("@/lib/db/settings"),
    import("@/lib/claude/build-options"),
    import("@/lib/claude/run-and-capture"),
    import("@/lib/claude/agents/dispatch-context-registry"),
  ])

  // Persistent-session mode (Package D): reuse an existing ChatSession and do
  // not delete it; resume continuity flows through its persisted sdkSessionId.
  const persistent = typeof config.sessionId === "string" && config.sessionId.length > 0
  const existingRow = persistent ? await sessionsDb.getSession(config.sessionId!) : undefined
  if (persistent && !existingRow) {
    throw new Error(`executeAgent: session "${config.sessionId}" not found`)
  }

  let character: Character
  const characterId = config.characterId ?? existingRow?.characterId
  if (characterId) {
    const resolved = await resolveCharacterById(characterId)
    if (!resolved) {
      throw new Error(`executeAgent: character "${characterId}" not found`)
    }
    character = resolved
  } else {
    character = synthesizeCharacter(config)
  }

  const session =
    existingRow ??
    (await sessionsDb.createSession({
      title: "Plugin Agent",
      characterId: character.id,
      ...(config.cwd ? { workingDir: config.cwd } : {}),
    }))
  // Register this run's nesting context by its session id BEFORE the send, so
  // a `dispatch_agent` call the subagent makes mid-run resolves its depth/chain.
  if (config.dispatchContext) {
    registerDispatchContext(session.id, config.dispatchContext)
  }
  // Register the approval route BEFORE the send so even the run's first
  // permission ask re-buckets into the parent session (no race window).
  if (config.approvalRoute) {
    const { registerSubagentApprovalRoute } =
      await import("@/lib/claude/agents/subagent-approval-routes")
    registerSubagentApprovalRoute(session.id, config.approvalRoute)
  }
  try {
    const appSettings = await settingsDb.getSettings().catch(() => undefined)
    const baseSessionRow = (await sessionsDb.getSession(session.id)) ?? session
    // Cross-provider override: route THIS run through the requested provider via
    // the session's `providerOverride` (which `resolveSendOptions` honors over
    // appSettings). Applied to an in-memory copy only — never persisted, so a
    // reused persistent session keeps its own provider.
    const sessionRow = config.provider
      ? { ...baseSessionRow, providerOverride: config.provider }
      : baseSessionRow
    const sendOptions = await buildOpts.resolveSendOptions({
      session: sessionRow,
      character,
      appSettings: appSettings ?? null,
      ...(config.dispatchContext ? { dispatchContext: config.dispatchContext } : {}),
      ...(config.isDispatchedSubagent ? { isDispatchedSubagent: true } : {}),
      ...(config.permissionCeiling ? { permissionCeiling: config.permissionCeiling } : {}),
    })
    // Append-style system extension + structured-output instruction ride
    // `appendSystemPrompt` so the resolved character/skill blocks survive.
    const appended = composeSystem(
      sendOptions.appendSystemPrompt,
      config.appendSystem,
      structuredInstruction(config.outputFormat)
    )
    if (appended) sendOptions.appendSystemPrompt = appended

    // PostToolUse hook: opt into the sidecar tool-result review round-trip so
    // the ai-sdk channel can REWRITE tool output before the model sees it. The
    // capture loop fires `onPostToolUse` exactly once per tool (review on the
    // ai-sdk channel, observation otherwise).
    const onToolResultReview = toolResultReviewResponderFor(
      config.onPostToolUse,
      config.abortSignal
    )
    if (config.onPostToolUse) {
      ;(sendOptions as Record<string, unknown>).toolResultReviewEnabled = true
    }

    const result = await runner.runAndCaptureAssistantReply(session.id, prompt, sendOptions, {
      signal: config.abortSignal,
      ...(typeof config.timeoutMs === "number" ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.onEvent ? { onEvent: config.onEvent } : {}),
      execution: {
        kind: "subagent",
        label: `Subagent ${session.id.slice(0, 8)}`,
        ...(session.projectId ? { projectId: session.projectId } : {}),
      },
      ...(permissionResponderFor(config.canUseTool, config.abortSignal)
        ? { onPermissionRequest: permissionResponderFor(config.canUseTool, config.abortSignal) }
        : {}),
      ...(onToolResultReview ? { onToolResultReview } : {}),
    })
    // Persist the SDK session id so the next send on this persistent session
    // resumes the conversation (resolveSendOptions reads it as resumeSessionId).
    if (persistent && result.sdkSessionId) {
      await sessionsDb.setSdkSessionId(session.id, result.sdkSessionId).catch(() => undefined)
    }
    // Surface usage (best-effort) so nested-dispatch budget accounting can draw
    // down the subtree pool. The SDK result carries it at `session_ended`.
    const usage = result.usage
      ? {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          totalTokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
        }
      : undefined
    return { text: result.text ?? "", ...(usage ? { usage } : {}) }
  } finally {
    if (config.dispatchContext) clearDispatchContext(session.id)
    if (config.approvalRoute) {
      // Clear AFTER the run settles; the drain's `permission_interrupted` for
      // orphaned asks re-buckets via the store's requestId fallback scan, so a
      // cleared route never strands the interrupt marker.
      void import("@/lib/claude/agents/subagent-approval-routes")
        .then(({ clearSubagentApprovalRoute }) => clearSubagentApprovalRoute(session.id))
        .catch(() => undefined)
    }
    // Drop the ceiling resolveSendOptions deposited for this run's session id so
    // a re-used ephemeral id never inherits a stale ceiling.
    clearResolvedPermissionCeiling(session.id)
    // Ephemeral sessions are torn down; persistent ones survive for resume.
    if (!persistent) void sessionsDb.deleteSession(session.id).catch(() => undefined)
  }
}

export async function executeAgent(
  prompt: string,
  config: ExecuteAgentConfig = {}
): Promise<ExecuteAgentResult> {
  // Tool-enabled branch: route through the sidecar when requested and available.
  if (config.toolsEnabled) {
    const { isTauri } = await import("@/lib/tauri")
    if (isTauri()) {
      const { text, usage } = await runToolEnabledStandalone(prompt, config)
      return {
        text,
        finishReason: "stop",
        channel: "sidecar",
        toolsAvailable: true,
        ...(usage ? { usage } : {}),
        ...finalizeStructured(text, config.outputFormat),
      }
    }
    // Requested tools but no sidecar — fall through to the text-only channel.
  }

  // A per-run `provider` override wins over the snapshot default so a
  // cross-provider subagent targets its own provider on the text channel too.
  const overrideProvider = config.provider ?? config.defaultProvider
  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: overrideProvider,
    providerSettings: config.providerSettings,
    customProviders: config.customProviders,
  })

  const resolution = resolveFeatureProvider(
    {
      featureId: "plugin-agent-executor",
      routeProfile: "general-text",
      selectionMode: snapshot.defaultProvider ? "explicit-provider" : "any",
      providerId: snapshot.defaultProvider,
      fallbackMode: "first-eligible",
    },
    snapshot
  )

  if (resolution.kind !== "resolved") {
    throw new Error(`executeAgent: ${resolution.reason}`)
  }

  const model = createFeatureProviderModel({
    ...resolution,
    model: config.model ?? resolution.model,
  })

  const options: Record<string, unknown> = { model }
  // Multi-turn on the text channel (Package D degradation): when prior turns
  // are supplied, send them as a message list so the model has context the
  // sidecar would otherwise carry via native resume. Single-shot otherwise.
  if (config.priorMessages && config.priorMessages.length > 0) {
    options.messages = [
      ...config.priorMessages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: prompt },
    ]
  } else {
    options.prompt = prompt
  }
  // System prompt = base + append + structured instruction (preset-with-append).
  const system = composeSystem(
    config.systemPrompt,
    config.appendSystem,
    structuredInstruction(config.outputFormat)
  )
  if (system) options.system = system
  if (config.temperature !== undefined) options.temperature = config.temperature
  if (config.abortSignal) options.abortSignal = config.abortSignal

  const result = streamText(options as Parameters<typeof streamText>[0])
  let text = ""
  for await (const chunk of result.textStream) {
    text += chunk
    config.onDelta?.(chunk)
    config.onEvent?.({ type: "text-delta", delta: chunk })
  }
  const finishReason = await result.finishReason
  // `usage` is a promise on real streamText results; tolerate mocks that omit it.
  const rawUsage = await Promise.resolve(result.usage).catch(() => undefined)
  const inputTokens = Number(rawUsage?.inputTokens ?? 0) || 0
  const outputTokens = Number(rawUsage?.outputTokens ?? 0) || 0
  return {
    text,
    finishReason: typeof finishReason === "string" ? finishReason : undefined,
    channel: "text",
    toolsAvailable: false,
    ...(rawUsage
      ? { usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } }
      : {}),
    ...finalizeStructured(text, config.outputFormat),
  }
}

/**
 * Parse + lightly validate the final text against `outputFormat`. Returns the
 * fields to spread onto the result: `object` on success, `parseError` on
 * failure (never throws). When no schema is requested, returns `{}`.
 */
function finalizeStructured(
  text: string,
  outputFormat: PluginAgentOutputFormat | undefined
): { object?: unknown; parseError?: string } {
  if (!outputFormat) return {}
  const { value, error } = parseStructured(text)
  if (error) return { parseError: error }
  return { object: value }
}
