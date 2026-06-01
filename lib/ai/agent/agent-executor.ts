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
}

export type ExecuteAgentChannel = "sidecar" | "text"

export interface ExecuteAgentResult {
  text: string
  finishReason?: string
  /** Which execution channel actually ran. */
  channel: ExecuteAgentChannel
  /** Whether the tool-enabled loop was used (true only on the sidecar channel). */
  toolsAvailable: boolean
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
    const result = await runner.runAndCaptureAssistantReply(session.id, prompt, sendOptions, {
      signal: config.abortSignal,
      ...(typeof config.timeoutMs === "number" ? { timeoutMs: config.timeoutMs } : {}),
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
      return { text, finishReason: "stop", channel: "sidecar", toolsAvailable: true }
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
  if (config.systemPrompt) options.system = config.systemPrompt
  if (config.temperature !== undefined) options.temperature = config.temperature
  if (config.abortSignal) options.abortSignal = config.abortSignal

  const result = streamText(options as Parameters<typeof streamText>[0])
  let text = ""
  for await (const chunk of result.textStream) {
    text += chunk
  }
  const finishReason = await result.finishReason
  return {
    text,
    finishReason: typeof finishReason === "string" ? finishReason : undefined,
    channel: "text",
    toolsAvailable: false,
  }
}
