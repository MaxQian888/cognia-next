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

import type { Character, SendContent, SendContentBlock } from "@cognia/agent-config-types"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { EvalCase, EvalSample, EvalToolCall, EvalRetrievedChunk } from "@/types/eval/eval"
import type { EvalTarget } from "@cognia/eval-core"
import type { EvalPersistenceScope } from "@/lib/db/eval-lab"
import Dexie from "dexie"
import { createEvalDeadline } from "./deadline"
import { waitForEvalTracePersistence } from "./trace-persistence"

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
  /** Measured around the entire target operation, not just the span envelope. */
  wallTimeMs?: number
}

/** Fold a run's spans + final text into the Sample scorers consume. */
export function assembleSampleFromSpans(
  spans: AgentTraceSpan[],
  options: AssembleOptions
): EvalSample {
  const unique = [
    ...new Map(spans.map((span) => [`${span.traceId}:${span.spanId ?? span.id}`, span])).values(),
  ]
  const toolSpans = unique
    .filter((s) => s.operationName === "execute_tool")
    .sort((a, b) => a.startTime - b.startTime)
  const toolCalls: EvalToolCall[] = toolSpans.map((s, index) => ({
    name: s.toolName ?? "(unknown)",
    args: parseArgs(s),
    index,
    ...(s.errorType || s.errorMessage ? { errored: true } : {}),
  }))

  const retrievedChunks = unique
    .filter((s) => s.operationName === "retrieval")
    .sort((a, b) => a.startTime - b.startTime)
    .flatMap(extractChunks)

  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  let costUsd = 0
  let minStart = Number.POSITIVE_INFINITY
  let maxEnd = Number.NEGATIVE_INFINITY
  let stepCount = 0
  const isAggregate = (span: AgentTraceSpan) =>
    span.metadata?.accountingScope === "aggregate" || span.metadata?.role === "squad-run"
  const bySpanId = new Map(unique.map((span) => [span.spanId ?? span.id, span]))
  const coveredBy = (child: AgentTraceSpan, aggregate: AgentTraceSpan) => {
    if (child.traceId !== aggregate.traceId || child === aggregate) return false
    if (aggregate.metadata?.role === "squad-run") return true
    const visited = new Set<string>()
    let parentId = child.parentSpanId
    while (parentId && !visited.has(parentId)) {
      if (parentId === (aggregate.spanId ?? aggregate.id)) return true
      visited.add(parentId)
      parentId = bySpanId.get(parentId)?.parentSpanId
    }
    return false
  }
  const usageAccounting = unique.filter(
    (span) => !isAggregate(span) || !unique.some((child) => coveredBy(child, span) && child.usage)
  )
  const costAccounting = unique.filter(
    (span) =>
      !isAggregate(span) ||
      !unique.some((child) => coveredBy(child, span) && typeof child.costUsdEstimate === "number")
  )
  const usageIds = new Set(usageAccounting.map((span) => span.id))
  const costIds = new Set(costAccounting.map((span) => span.id))
  let usageRows = 0
  let costRows = 0
  let billableRows = 0
  let partialUsage = false
  let partialCost = false
  for (const s of unique) {
    const orchestrationOnly =
      s.metadata?.accountingScope === "aggregate" ||
      ["squad-run", "squad-review", "squad-recovery"].includes(String(s.metadata?.role))
    const billable =
      !orchestrationOnly && (s.operationName === "chat" || s.operationName === "invoke_agent")
    if (billable) {
      billableRows += 1
      if (s.metadata?.usageKnown === false) partialUsage = true
      if (s.metadata?.costKnown === false) partialCost = true
    }
    if (usageIds.has(s.id) && s.usage) {
      usageRows += 1
      usage.inputTokens += s.usage.inputTokens
      usage.outputTokens += s.usage.outputTokens
      usage.cacheReadTokens += s.usage.cacheReadTokens
      usage.cacheCreationTokens += s.usage.cacheCreationTokens
    }
    if (costIds.has(s.id) && typeof s.costUsdEstimate === "number") {
      costRows += 1
      costUsd += s.costUsdEstimate
    }
    if (s.startTime < minStart) minStart = s.startTime
    const end = s.endTime ?? s.startTime
    if (end > maxEnd) maxEnd = end
    if (billable || s.operationName === "execute_tool") stepCount += 1
  }

  const knownSpanTime = unique.length > 0 && Number.isFinite(minStart) && Number.isFinite(maxEnd)
  const latencyMs = options.wallTimeMs ?? (knownSpanTime ? maxEnd - minStart : 0)

  return {
    output: options.output,
    toolCalls,
    retrievedChunks,
    usage,
    costUsd,
    latencyMs,
    stepCount,
    degraded: options.degraded ?? false,
    metricAvailability: {
      usage:
        usageRows === 0
          ? "unavailable"
          : partialUsage || usageRows < billableRows
            ? "partial"
            : "known",
      cost:
        costRows === 0
          ? "unavailable"
          : partialCost || costRows < billableRows
            ? "partial"
            : "estimated",
      latency: options.wallTimeMs !== undefined || knownSpanTime ? "known" : "unavailable",
      steps: unique.length > 0 ? "known" : "unavailable",
    },
  }
}

/** Shared text rendering so Chat and Squad candidates receive equivalent input. */
export function renderEvalTextPrompt(evalCase: EvalCase): string {
  if (evalCase.contentParts?.some((part) => part.type === "asset")) {
    throw new Error("Team evaluation does not support asset content")
  }
  const text = evalCase.contentParts?.length
    ? evalCase.contentParts.map((part) => (part.type === "text" ? part.text : "")).join("\n")
    : evalCase.input
  if (!evalCase.history?.length) return text
  const prior = evalCase.history
    .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
    .join("\n")
  return `${prior}\n\n${text}`
}

/** Render the case (history + prompt) into a single driving prompt string. */
async function renderPrompt(
  evalCase: EvalCase,
  resolveAsset?: ChatTargetDeps["resolveAsset"]
): Promise<SendContent> {
  if (!evalCase.contentParts?.some((part) => part.type === "asset")) {
    return renderEvalTextPrompt(evalCase)
  }
  const blocks: SendContentBlock[] = []
  if (evalCase.history?.length) {
    blocks.push({
      type: "text",
      text: `${evalCase.history.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n")}\n\n`,
    })
  }
  for (const part of evalCase.contentParts) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text })
      continue
    }
    if (!resolveAsset) throw new Error(`Evaluation asset ${part.assetId} is unavailable`)
    const asset = await resolveAsset(part.assetId)
    blocks.push({
      type: asset.mediaType.startsWith("image/") ? "image" : "document",
      source: {
        type: "base64",
        media_type: asset.mediaType,
        data: asset.data,
      },
    })
  }
  return blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks
}

export interface ChatTargetConfig {
  label: string
  providerId?: string
  model: string
  characterId?: string
  cwd?: string
  timeoutMs?: number
  /** Ephemeral Character supplied by the Twin target; never persisted. */
  character?: Character
}

export interface ChatTargetDeps {
  /** Run one chat turn; returns the final text and the session it ran in. */
  runTurn(input: {
    prompt: SendContent
    providerId?: string
    model: string
    characterId?: string
    character?: Character
    cwd?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<{ text: string; sessionId: string }>
  resolveAsset?(assetId: string): Promise<{ data: string; mediaType: string }>
  /** Fetch the spans emitted for a session. */
  fetchSpans(sessionId: string): Promise<AgentTraceSpan[]>
  /** Remove the transient evaluation chat after its trace has been captured. */
  cleanupSession?(sessionId: string): Promise<void>
  /** Whether the tool-enabled (sidecar) path is available. */
  isToolCapable(): boolean
}

export function createChatTarget(config: ChatTargetConfig, deps: ChatTargetDeps): EvalTarget {
  return {
    label: config.label,
    async run(evalCase: EvalCase, signal?: AbortSignal): Promise<EvalSample> {
      const startedAt = Date.now()
      const deadline = createEvalDeadline(signal, config.timeoutMs)
      let sessionId: string | undefined
      try {
        const prompt = await renderPrompt(evalCase, deps.resolveAsset)
        const result = await deadline.run(() =>
          deps.runTurn({
            prompt,
            ...(config.providerId ? { providerId: config.providerId } : {}),
            model: config.model,
            ...(config.characterId ? { characterId: config.characterId } : {}),
            ...(config.character ? { character: config.character } : {}),
            ...(config.cwd ? { cwd: config.cwd } : {}),
            ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
            signal: deadline.signal,
          })
        )
        sessionId = result.sessionId
        const spans = await deadline.run(() => deps.fetchSpans(result.sessionId))
        return {
          ...assembleSampleFromSpans(spans, {
            output: result.text,
            degraded: !deps.isToolCapable(),
            wallTimeMs: Math.max(0, Date.now() - startedAt),
          }),
          executionStatus: "completed",
          executionProfile: "desktop-chat",
        }
      } finally {
        deadline.dispose()
        if (sessionId) await deps.cleanupSession?.(sessionId)
      }
    },
  }
}

/**
 * Wire the real desktop deps: drive `runAndCaptureAssistantReply` in a
 * dedicated session, captures its `agentTraces`, then deletes the transient
 * chat so evaluation traffic never pollutes normal history. On a non-Tauri host the
 * run still works but degrades to text-only (no tool spans), which
 * {@link createChatTarget} flags via `degraded`.
 */
export function defaultChatTargetDeps(scope?: EvalPersistenceScope): ChatTargetDeps {
  const cleanupSession = async (sessionId: string): Promise<void> => {
    scope?.assertActive()
    const { deleteSession } = await import("@/lib/db/sessions")
    scope?.assertActive()
    await deleteSession(sessionId, ...(scope ? ([scope] as const) : []))
  }
  return {
    async runTurn({
      prompt,
      providerId,
      model,
      characterId,
      character: providedCharacter,
      cwd,
      timeoutMs,
      signal,
    }) {
      const assertActive = () => {
        scope?.assertActive()
        signal?.throwIfAborted()
      }
      assertActive()
      const [{ resolveCharacterById }, sessionsDb, settingsDb, buildOpts, runner] =
        await Promise.all([
          import("@/lib/db/characters"),
          import("@/lib/db/sessions"),
          import("@/lib/db/settings"),
          import("@/lib/claude/build-options"),
          import("@/lib/claude/run-and-capture"),
        ])
      assertActive()
      const ts = Date.now()
      const character =
        providedCharacter ??
        (characterId
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
            })
      assertActive()
      if (!character) throw new Error(`eval target: character "${characterId}" not found`)
      const session = await sessionsDb.createSession(
        {
          title: "Eval Run",
          characterId: character.id,
          memoryLearn: false,
          ...(cwd ? { workingDir: cwd } : {}),
        },
        ...(scope ? ([scope] as const) : [])
      )
      try {
        assertActive()
        const appSettings = await settingsDb.getSettings(scope).catch(() => undefined)
        assertActive()
        const sessionRow = {
          ...((await (scope
            ? scope.db.sessions.get(session.id)
            : sessionsDb.getSession(session.id))) ?? session),
          ...(providerId ? { providerOverride: providerId } : {}),
          model,
        }
        assertActive()
        const twinDeps = character.twinId
          ? await import("@/lib/twin/runtime/build-deps").then(({ tryBuildTwinDeps }) => {
              assertActive()
              return tryBuildTwinDeps()
            })
          : undefined
        assertActive()
        const promptText =
          typeof prompt === "string"
            ? prompt
            : prompt
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n")
        const sendOptions = await buildOpts.resolveSendOptions({
          session: sessionRow,
          character,
          appSettings: appSettings ?? null,
          ...(twinDeps ? { twinDeps, twinUserMessage: promptText } : {}),
        })
        assertActive()
        const result = await runner.runAndCaptureAssistantReply(session.id, prompt, sendOptions, {
          ...(signal ? { signal } : {}),
          ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
        })
        assertActive()
        return { text: result.text ?? "", sessionId: session.id }
      } catch (error) {
        await cleanupSession(session.id)
        throw error
      }
    },
    async fetchSpans(sessionId: string) {
      scope?.assertActive()
      await waitForEvalTracePersistence()
      scope?.assertActive()
      const { queryBySession } = await import("@/lib/db/agent-traces")
      scope?.assertActive()
      const spans = await (scope
        ? scope.db.agentTraces
            .where("[sessionId+startTime]")
            .between([sessionId, Dexie.minKey], [sessionId, Dexie.maxKey])
            .reverse()
            .toArray()
        : queryBySession(sessionId, Number.MAX_SAFE_INTEGER))
      scope?.assertActive()
      return spans
    },
    cleanupSession,
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
