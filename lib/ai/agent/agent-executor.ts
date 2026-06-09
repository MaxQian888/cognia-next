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
import { buildJsonInstruction, parseStructured } from "@/lib/workflow/nodes/ai/structured"
import type {
  PluginAgentOutputFormat,
  PluginToolPermissionFn,
} from "@/types/plugin/plugin-agent-sdk"

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
function composeSystem(base: string | undefined, ...extra: Array<string | undefined>): string {
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
): Promise<{ text: string }> {
  const [{ resolveCharacterById }, sessionsDb, settingsDb, buildOpts, runner] = await Promise.all([
    import("@/lib/db/characters"),
    import("@/lib/db/sessions"),
    import("@/lib/db/settings"),
    import("@/lib/claude/build-options"),
    import("@/lib/claude/run-and-capture"),
  ])

  let character: Character
  if (config.characterId) {
    const resolved = await resolveCharacterById(config.characterId)
    if (!resolved) {
      throw new Error(`executeAgent: character "${config.characterId}" not found`)
    }
    character = resolved
  } else {
    character = synthesizeCharacter(config)
  }

  const session = await sessionsDb.createSession({
    title: "Plugin Agent",
    characterId: character.id,
    ...(config.cwd ? { workingDir: config.cwd } : {}),
  })
  try {
    const appSettings = await settingsDb.getSettings().catch(() => undefined)
    const sessionRow = (await sessionsDb.getSession(session.id)) ?? session
    const sendOptions = await buildOpts.resolveSendOptions({
      session: sessionRow,
      character,
      appSettings: appSettings ?? null,
    })
    // Append-style system extension + structured-output instruction ride
    // `appendSystemPrompt` so the resolved character/skill blocks survive.
    const appended = composeSystem(
      sendOptions.appendSystemPrompt,
      config.appendSystem,
      structuredInstruction(config.outputFormat)
    )
    if (appended) sendOptions.appendSystemPrompt = appended

    const result = await runner.runAndCaptureAssistantReply(session.id, prompt, sendOptions, {
      signal: config.abortSignal,
      ...(typeof config.timeoutMs === "number" ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.onEvent ? { onEvent: config.onEvent } : {}),
      ...(permissionResponderFor(config.canUseTool, config.abortSignal)
        ? { onPermissionRequest: permissionResponderFor(config.canUseTool, config.abortSignal) }
        : {}),
    })
    return { text: result.text ?? "" }
  } finally {
    void sessionsDb.deleteSession(session.id).catch(() => undefined)
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
      const { text } = await runToolEnabledStandalone(prompt, config)
      return {
        text,
        finishReason: "stop",
        channel: "sidecar",
        toolsAvailable: true,
        ...finalizeStructured(text, config.outputFormat),
      }
    }
    // Requested tools but no sidecar — fall through to the text-only channel.
  }

  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: config.defaultProvider,
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

  const options: Record<string, unknown> = {
    model,
    prompt,
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
