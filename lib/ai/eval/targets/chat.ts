/**
 * Chat / Character eval target — drives the chat main path headlessly and
 * assembles the captured trajectory into an {@link EvalSample}.
 *
 * The pure core is {@link assembleSampleFromSpans}: it folds the `agentTraces`
 * spans a run emitted into the Sample every scorer consumes (tool calls from
 * `execute_tool` spans, RAG chunks from `retrieval` spans, usage/cost/latency
 * rolled up). {@link createChatTarget} is dependency-injected so it is fully
 * unit-testable; {@link defaultChatTargetDeps} wires the real sidecar path
 * (`runAndCaptureAssistantReply` + `agentTraces` query) on desktop.
 */

import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { EvalCase, EvalSample, EvalToolCall, EvalRetrievedChunk } from "@/types/eval/eval"
import type { EvalTarget } from "../runner"

function parseArgs(span: AgentTraceSpan): Record<string, unknown> {
  // Prefer structured metadata, fall back to the (PII-gated) inputPreview JSON.
  const metaArgs = span.metadata?.args
  if (metaArgs && typeof metaArgs === "object" && !Array.isArray(metaArgs)) {
    return metaArgs as Record<string, unknown>
  }
  if (typeof span.inputPreview === "string") {
    try {
      const parsed = JSON.parse(span.inputPreview)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // not JSON — args unknown
    }
  }
  return {}
}

function extractChunks(span: AgentTraceSpan): EvalRetrievedChunk[] {
  const raw = span.metadata?.retrievedChunks
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({
      ...(typeof c.id === "string" ? { id: c.id } : {}),
      text: typeof c.text === "string" ? c.text : "",
      ...(typeof c.score === "number" ? { score: c.score } : {}),
    }))
}

export interface AssembleOptions {
  output: string
  degraded?: boolean
}

const STEP_OPS = new Set<AgentTraceSpan["operationName"]>(["execute_tool", "chat", "invoke_agent"])

/** Fold a run's spans + final text into the Sample scorers consume. */
export function assembleSampleFromSpans(
  spans: AgentTraceSpan[],
  options: AssembleOptions
): EvalSample {
  const toolSpans = spans
    .filter((s) => s.operationName === "execute_tool")
    .sort((a, b) => a.startTime - b.startTime)
  const toolCalls: EvalToolCall[] = toolSpans.map((s, index) => ({
    name: s.toolName ?? "(unknown)",
    args: parseArgs(s),
    index,
    ...(s.errorType || s.errorMessage ? { errored: true } : {}),
  }))

  const retrievedChunks = spans
    .filter((s) => s.operationName === "retrieval")
    .sort((a, b) => a.startTime - b.startTime)
    .flatMap(extractChunks)

  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  let costUsd = 0
  let minStart = Number.POSITIVE_INFINITY
  let maxEnd = Number.NEGATIVE_INFINITY
  let stepCount = 0
  for (const s of spans) {
    if (s.usage) {
      usage.inputTokens += s.usage.inputTokens
      usage.outputTokens += s.usage.outputTokens
      usage.cacheReadTokens += s.usage.cacheReadTokens
      usage.cacheCreationTokens += s.usage.cacheCreationTokens
    }
    if (typeof s.costUsdEstimate === "number") costUsd += s.costUsdEstimate
    if (s.startTime < minStart) minStart = s.startTime
    const end = s.endTime ?? s.startTime
    if (end > maxEnd) maxEnd = end
    if (STEP_OPS.has(s.operationName)) stepCount += 1
  }

  const latencyMs = Number.isFinite(minStart) && Number.isFinite(maxEnd) ? maxEnd - minStart : 0

  return {
    output: options.output,
    toolCalls,
    retrievedChunks,
    usage,
    costUsd,
    latencyMs,
    stepCount,
    degraded: options.degraded ?? false,
  }
}

/** Render the case (history + prompt) into a single driving prompt string. */
function renderPrompt(evalCase: EvalCase): string {
  if (!evalCase.history || evalCase.history.length === 0) return evalCase.input
  const prior = evalCase.history.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n")
  return `${prior}\n\n${evalCase.input}`
}

export interface ChatTargetConfig {
  label: string
  model: string
  characterId?: string
  cwd?: string
  timeoutMs?: number
}

export interface ChatTargetDeps {
  /** Run one chat turn; returns the final text and the session it ran in. */
  runTurn(input: {
    prompt: string
    model: string
    characterId?: string
    cwd?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<{ text: string; sessionId: string }>
  /** Fetch the spans emitted for a session. */
  fetchSpans(sessionId: string): Promise<AgentTraceSpan[]>
  /** Whether the tool-enabled (sidecar) path is available. */
  isToolCapable(): boolean
}

export function createChatTarget(config: ChatTargetConfig, deps: ChatTargetDeps): EvalTarget {
  return {
    label: config.label,
    async run(evalCase: EvalCase, signal?: AbortSignal): Promise<EvalSample> {
      const prompt = renderPrompt(evalCase)
      const { text, sessionId } = await deps.runTurn({
        prompt,
        model: config.model,
        ...(config.characterId ? { characterId: config.characterId } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
        ...(signal ? { signal } : {}),
      })
      const spans = await deps.fetchSpans(sessionId)
      return assembleSampleFromSpans(spans, { output: text, degraded: !deps.isToolCapable() })
    },
  }
}

/**
 * Wire the real desktop deps: drive `runAndCaptureAssistantReply` in a
 * dedicated session (NOT deleted afterwards, so its `agentTraces` spans stay
 * queryable), then read the spans back by session id. On a non-Tauri host the
 * run still works but degrades to text-only (no tool spans), which
 * {@link createChatTarget} flags via `degraded`.
 */
export function defaultChatTargetDeps(): ChatTargetDeps {
  return {
    async runTurn({ prompt, model, characterId, cwd, timeoutMs, signal }) {
      const [{ resolveCharacterById }, sessionsDb, settingsDb, buildOpts, runner] =
        await Promise.all([
          import("@/lib/db/characters"),
          import("@/lib/db/sessions"),
          import("@/lib/db/settings"),
          import("@/lib/claude/build-options"),
          import("@/lib/claude/run-and-capture"),
        ])
      const ts = Date.now()
      const character = characterId
        ? await resolveCharacterById(characterId)
        : {
            id: "__eval-target__",
            name: "Eval Target",
            avatarColor: "oklch(0.6 0 0)",
            systemPrompt: "You are a focused, helpful agent.",
            createdAt: ts,
            updatedAt: ts,
            model,
            ...(cwd ? { workingDir: cwd } : {}),
          }
      if (!character) throw new Error(`eval target: character "${characterId}" not found`)
      const session = await sessionsDb.createSession({
        title: "Eval Run",
        characterId: character.id,
        ...(cwd ? { workingDir: cwd } : {}),
      })
      const appSettings = await settingsDb.getSettings().catch(() => undefined)
      const sessionRow = (await sessionsDb.getSession(session.id)) ?? session
      const sendOptions = await buildOpts.resolveSendOptions({
        session: sessionRow,
        character,
        appSettings: appSettings ?? null,
      })
      const result = await runner.runAndCaptureAssistantReply(session.id, prompt, sendOptions, {
        ...(signal ? { signal } : {}),
        ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      })
      return { text: result.text ?? "", sessionId: session.id }
    },
    async fetchSpans(sessionId: string) {
      const { queryBySession } = await import("@/lib/db/agent-traces")
      return queryBySession(sessionId)
    },
    isToolCapable() {
      // Set lazily; importing tauri synchronously is fine in the renderer.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require("@/lib/tauri") as { isTauri: () => boolean }
        return mod.isTauri()
      } catch {
        return false
      }
    },
  }
}
