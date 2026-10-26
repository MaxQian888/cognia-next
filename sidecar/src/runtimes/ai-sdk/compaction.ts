import { createHash, randomUUID } from "node:crypto"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { isDeepStrictEqual } from "node:util"
import { claude55CapabilitiesForModel } from "@cognia/provider-types/reasoning-effort-tables"
import type { SendOptions } from "../../shared/wire/inbound.ts"
import type { HostRpcCaller } from "../../tools/state/host-background-shells.ts"
import type {
  AdapterCredentials,
  AdapterMessage,
  ProtocolAdapter,
} from "../../providers/protocol-adapters/types.ts"
import type { ProtocolExecChannel } from "../../providers/protocol-adapters/code-adapter.ts"
import type { PendingPluginHooks } from "../../hooks/kernel/types.ts"
import type { CallLedgerGate } from "../common/call-ledger-gate.ts"
import type { ConversationMessage } from "../../context/compaction.ts"
import {
  shouldCompact,
  estimateTokens,
  makeSummaryMessage,
  isSummaryMessage,
  summaryVersion,
  AUTO_COMPACT_FRACTION,
} from "../../context/compaction.ts"
import { planStrategy } from "../../context/strategies.ts"
import { queryPreCompactDecision } from "../../hooks/pre-compact.ts"
import { runPluginHookHandler, PLUGIN_HOOK_BROADCAST } from "../../hooks/handlers/plugin.ts"
import { capToolResults } from "../../context/tool-result-cap.ts"
import { unpairedToolCallIds, toolPairUnits } from "../../context/tool-message-pairing.ts"
import { resolveAdapter } from "../../providers/protocol-adapters/registry.ts"
import { SIWC_PROTOCOL } from "../../providers/siwc-fetch.ts"
import {
  drainSideCallStream,
  estimatePromptTokens,
  runLedgeredSideCall,
} from "../common/call-ledger-gate.ts"
import { errorToMessage } from "./messages.ts"
import {
  PROGRESS_CHECKPOINT_PROMPT,
  parseProgressCheckpoint,
  progressCheckpointIssueCodes,
  mergeProgressCheckpoint,
  renderProgressCheckpoint,
  type ProgressCheckpoint,
} from "../../context/progress-checkpoint.ts"
const COMPACT_KEEP_RECENT_MESSAGES = 6
const MAX_FROZEN_SUMMARIES = 4
function toolResultIds(messages: readonly ConversationMessage[]): string[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part && part.type === "tool-result" && typeof part.toolCallId === "string"
            ? [part.toolCallId]
            : []
        )
      : []
  )
}
const DEFAULT_SUMMARY_PROMPT =
  "You compact a long conversation. Produce a concise summary that preserves " +
  "decisions made, facts established, file paths, and any open threads. Use " +
  "terse bullet points. Preserve the original goal, completed work, verified " +
  "findings with file:line references, unsuccessful searches, unresolved questions " +
  "and the next concrete action. Distinguish completed research from remaining " +
  "work so the agent continues instead of restarting. Do not add commentary."
/**
 * Framing for the transcript the summary call reads. Without it a model sees a
 * bare `user: … assistant: …` log as a conversation to continue, and answers
 * the last request (with tool calls) instead of summarizing it.
 */
const SUMMARY_TRANSCRIPT_PREAMBLE =
  "Summarize the conversation transcript below. It is material to summarize, " +
  "not a conversation to continue: do not answer its requests, do not call " +
  "tools, and output only the summary."
export interface CompactionState {
  model: string
  lastInputTokens: number
  frozenSummaryVersion: number
  ledgerSideCalls: number
  turnLedgerGate: CallLedgerGate | null
  activeAbortController: AbortController | null
  /** Measured input minus matching conversation estimate; includes tools/framing. */
  promptOverheadTokens?: number
}
export interface CompactorOptions {
  state: CompactionState
  conversation: ConversationMessage[]
  sendOptions: SendOptions
  provider: string
  sessionId: string
  sdkSessionId: string
  hostRpc?: HostRpcCaller
  emit(event: Record<string, unknown>): void
  log(level: string, message: string): void
  protocolAdapter: ProtocolAdapter
  pendingProtocolExecs: Map<string, ProtocolExecChannel>
  pendingPluginHookCalls: PendingPluginHooks
  streamTextOverride?: (args: Record<string, unknown>) => unknown
  isCancelled(): boolean
}
/**
 * Why a manual compaction ended without a `compact_boundary`. `failed` means
 * the summary (or the preparation) produced nothing: the history is unchanged.
 */
export type ManualCompactOutcome =
  "nothing_to_compact" | "skipped_by_plugin" | "deferred" | "failed"

/**
 * The `informational` system event reporting a manual compaction's outcome
 * when no boundary follows. `compact_outcome` is what a waiting `/compact`
 * matches; `content` is what any transcript renders.
 */
export function manualCompactOutcomeEvent(
  sdkSessionId: string,
  outcome: ManualCompactOutcome,
  content: string
): Record<string, unknown> {
  return {
    type: "system",
    subtype: "informational",
    uuid: randomUUID(),
    session_id: sdkSessionId,
    level: outcome === "failed" ? "warning" : "info",
    content,
    compact_outcome: outcome,
  }
}

/** Keep the head and tail of a long payload, eliding the middle. */
function clipPayload(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n… (${text.length - 2 * half} chars elided) …\n${text.slice(-half)}`
}

function stringifyPayload(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

/** A tool result body: AI SDK `output: { type, value }`, or a legacy field. */
function toolResultBody(part: Record<string, unknown>): string {
  const output = part.output ?? part.result ?? part.content
  if (Array.isArray(output)) {
    return output
      .map((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : stringifyPayload(b)
      )
      .join("\n")
  }
  if (output && typeof output === "object" && "value" in output) {
    const value = (output as { value: unknown }).value
    if (Array.isArray(value)) return toolResultBody({ output: value })
    return stringifyPayload(value)
  }
  return stringifyPayload(output)
}

/**
 * One content part of the summary transcript. Text is kept verbatim; tool
 * calls and results follow the configured cap, since in a coding session they carry
 * most of what happened (paths, commands, outcomes). Reasoning is private to
 * the turn that produced it and is left out; media is named, not inlined.
 */
function renderPartForSummary(part: unknown, maxPayloadChars: number): string {
  if (typeof part === "string") return part
  if (!part || typeof part !== "object") return ""
  const p = part as Record<string, unknown>
  const toolName =
    typeof (p.toolName ?? p.name) === "string" ? String(p.toolName ?? p.name) : "tool"
  switch (p.type) {
    case "text":
      return typeof p.text === "string" ? p.text : ""
    case "reasoning":
    case "redacted-reasoning":
      return ""
    case "tool-call":
    case "tool_use":
      return `[tool call ${toolName}] ${clipPayload(stringifyPayload(p.input ?? p.args), maxPayloadChars)}`
    case "tool-result":
    case "tool_result":
      return `[tool result ${toolName}] ${clipPayload(toolResultBody(p), maxPayloadChars)}`
    case "image":
      return "[image]"
    case "file":
      return `[file${typeof p.filename === "string" ? ` ${p.filename}` : ""}]`
    default:
      return typeof p.text === "string" ? p.text : ""
  }
}

/** Why a summary call that finished without error still produced no text. */
function emptySummaryReason(
  drained: { finishReason?: string; error?: unknown },
  maxOutputTokens: number
): string {
  if (drained.error) return `the summary call failed: ${errorToMessage(drained.error)}`
  switch (drained.finishReason) {
    case "length":
      return `the summary model used its whole ${maxOutputTokens}-token output budget without writing a summary (likely all reasoning)`
    case "tool-calls":
      return "the summary model answered with tool calls instead of a summary"
    case "content-filter":
      return "the summary was blocked by the provider's content filter"
    case undefined:
      return "the summary model returned no text"
    default:
      return `the summary model returned no text (finish reason: ${drained.finishReason})`
  }
}

export function createCompactor({
  state,
  conversation,
  sendOptions,
  provider,
  sessionId,
  sdkSessionId,
  hostRpc,
  emit,
  log,
  protocolAdapter,
  pendingProtocolExecs,
  pendingPluginHookCalls,
  streamTextOverride,
  isCancelled,
}: CompactorOptions) {
  // Render the to-be-summarized slice as plain transcript for the summary call.
  function renderForSummary(messages: ConversationMessage[]) {
    const cap = sendOptions.compaction?.maxToolResultTokens
    const maxPayloadChars = typeof cap === "number" && cap > 0 ? cap * 4 : Number.POSITIVE_INFINITY
    return messages
      .map((m) => {
        const text =
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content
                  .map((p) => renderPartForSummary(p, maxPayloadChars))
                  .filter(Boolean)
                  .join("\n")
              : ""
        return `${m.role}: ${text}`
      })
      .join("\n\n")
  }

  // A preparation owns an immutable prefix, cancellation, and the turn's
  // billing gate. Only a model-loop boundary may publish its result.
  const runtimeState = state
  let generation = 0
  type Prepared = Awaited<ReturnType<typeof prepare>>
  type Job = {
    generation: number
    snapshot: ConversationMessage[]
    controller: AbortController
    model: string
    gate: CallLedgerGate | null
    /** A forced (`/compact`, overflow recovery) run: its caller waits for an outcome. */
    force: boolean
    result?: Prepared
    settled: boolean
    contextKey: string
    summaries: Map<string, Promise<{ text: string | null; failure?: string }>>
    promise: Promise<void>
  }
  let pending: Job | undefined
  let rejected: Job | undefined
  let softRearmTokens = 0
  const running = new Set<Job>()

  function invalidate() {
    generation++
    pending?.controller.abort()
    for (const job of running) job.controller.abort()
    pending = undefined
    rejected = undefined
    softRearmTokens = 0
  }

  function matches(job: Job) {
    return (
      job.generation === generation &&
      !job.controller.signal.aborted &&
      job.model === state.model &&
      conversation.length >= job.snapshot.length &&
      job.snapshot.every((message, i) => isDeepStrictEqual(message, conversation[i]))
    )
  }

  // Abort also settles a non-cooperative adapter's local waiter. The provider
  // receives the same signal; late responses cannot reach publication or billing.
  function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const abort = () => {
        reject(signal.reason)
        cleanup()
      }
      const cleanup = () => signal.removeEventListener("abort", abort)
      signal.addEventListener("abort", abort, { once: true })
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted()
          return operation()
        })
        .then(
          (value) => {
            cleanup()
            resolve(value)
          },
          (error) => {
            cleanup()
            reject(error)
          }
        )
    })
  }

  function postCompactionTarget() {
    const comp = sendOptions.compaction
    const requested = comp?.postCompactionTokenBudget
    const window = comp?.contextWindow
    if (requested === undefined) return undefined
    // Default targets accommodate fixed instructions and the pair-safe tail,
    // but remain comfortably below the next background trigger.
    return comp.postCompactionTokenBudgetIsDefault && typeof window === "number"
      ? Math.max(requested, window * (comp.fraction ?? AUTO_COMPACT_FRACTION) * 0.8 * 0.9)
      : requested
  }

  async function prepare(
    creds: AdapterCredentials,
    modelParams: Record<string, unknown>,
    job: Job,
    { force = false, focus, trigger }: { force?: boolean; focus?: string; trigger?: "auto" }
  ) {
    const conversation = job.snapshot
    const state: CompactionState = {
      ...runtimeState,
      model: job.model,
      turnLedgerGate: job.gate,
      activeAbortController: job.controller,
      get ledgerSideCalls() {
        return runtimeState.ledgerSideCalls
      },
      set ledgerSideCalls(value) {
        runtimeState.ledgerSideCalls = value
      },
    }
    const comp = sendOptions.compaction ?? {}
    const progressFormat =
      comp.checkpointFormat === "progress-v1" &&
      comp.strategy !== "optical" &&
      comp.strategy !== "sliding-window" &&
      sendOptions.agentKind === "subagent" &&
      (sendOptions.agentRef === "Plan" || sendOptions.agentRef === "Explore") &&
      comp.useAISummarization !== false
    const signal = job.controller.signal
    // ── PreCompact plugin hook (ADR-0090 Phase 9) ──────────────────────────
    // Gives plugins a chance to skip compaction, inject context, or override
    // the strategy. This used to route through `host_rpc`, which is answered in
    // Rust and never reaches the renderer — so it always fell back and the hook
    // was dead. It now rides the plugin-hook round-trip. Still falls back
    // gracefully when no renderer is attached.
    const preCompactDecision = await queryPreCompactDecision(
      hostRpc,
      {
        sessionId,
        messageCount: conversation.length,
        tokenCount: state.lastInputTokens ?? estimateTokens(conversation),
        compressionRatio: undefined,
      },
      {
        log,
        pluginHookBridge: async ({ hookId, payload, timeoutMs }) => {
          signal.throwIfAborted()
          const execId = randomUUID()
          const abortHook = () =>
            pendingPluginHookCalls.get(execId)?.resolve({ error: "compaction cancelled" })
          signal.addEventListener("abort", abortHook, { once: true })
          try {
            const outcome = await runPluginHookHandler(
              {
                type: "plugin",
                pluginId: PLUGIN_HOOK_BROADCAST,
                hookId,
                timeout: (timeoutMs ?? 30000) / 1000,
              },
              JSON.stringify(payload),
              {
                emit: (frame) => emit({ ...frame }),
                sessionId,
                pendingPluginHookCalls,
                newId: () => execId,
              }
            )
            return outcome?.pluginResult
          } finally {
            signal.removeEventListener("abort", abortHook)
          }
        },
      }
    )
    signal.throwIfAborted()
    if (preCompactDecision.skip) {
      log("info", "compaction skipped by plugin preCompact decision")
      if (force)
        reportManualOutcome(
          "skipped_by_plugin",
          "Compaction skipped: a plugin's PreCompact hook declined it."
        )
      return
    }

    const keepRecent =
      typeof comp.keepRecent === "number" ? comp.keepRecent : COMPACT_KEEP_RECENT_MESSAGES
    const generationBudget = comp.maxSummaryTokens ?? 16_384
    const retainedCheckpointBudget = comp.checkpointTokenBudget ?? generationBudget
    const framingTokens = state.promptOverheadTokens ?? 0
    let totalTarget = postCompactionTarget()

    const plan = planStrategy({
      // Plugin strategy override takes precedence, then user-configured strategy
      strategy: preCompactDecision.strategyOverride ?? comp.strategy,
      conversation,
      keepRecent,
      keepRecentTokens:
        comp.keepRecentTokens ??
        (comp.keepRecent === undefined
          ? Math.min(12_000, (comp.contextWindow ?? 128_000) * 0.1)
          : undefined),
      preserveSystemMessages: comp.preserveSystemMessages,
      recursiveChunkSize: comp.recursiveChunkSize,
      importanceThreshold: comp.importanceThreshold,
      retainedFraction: comp.retainedFraction,
      ...(totalTarget !== undefined
        ? {
            retainedTokenBudget: Math.max(
              0,
              totalTarget - framingTokens - retainedCheckpointBudget
            ),
            replacesFrozen: progressFormat,
          }
        : {}),
      modelId: state.model,
      // Authoritative catalog-resolved window (same source `shouldCompact`
      // uses) so the drain-line budget doesn't fall back to the regex table.
      ...(typeof comp.contextWindow === "number" ? { contextWindow: comp.contextWindow } : {}),
    })
    if (plan.kind === "none") {
      // A manual `/compact` waits for an answer; say why nothing changed
      // instead of leaving the caller to time out.
      if (force)
        reportManualOutcome(
          "nothing_to_compact",
          `Nothing to compact yet: the conversation still fits in the ${keepRecent} most recent messages kept verbatim.`
        )
      return
    }

    // The renderer-supplied prompt already folds in the app-level focus; a
    // manual `/compact <focus>` arg layers an extra instruction on top.
    // Plugin-injected context (bounded to 4 KiB by the hook validator) is
    // prepended as additional retention guidance.
    const basePrompt = comp.summaryPrompt || DEFAULT_SUMMARY_PROMPT
    const manualFocus = typeof focus === "string" ? focus.trim() : ""
    const pluginContext = preCompactDecision.contextToInject ?? ""
    let systemPrompt = basePrompt
    if (pluginContext) {
      systemPrompt = `Important context to preserve:\n${pluginContext}\n\n${systemPrompt}`
    }
    if (manualFocus) {
      systemPrompt = `${systemPrompt}\n\nFocus especially on: ${manualFocus}`
    }
    if (progressFormat) systemPrompt += `\n\n${PROGRESS_CHECKPOINT_PROMPT}`

    // Summary executor: alternate cheap state.model + credentials + adapter, with the
    // output token cap. Returns trimmed text, or null on failure/empty. When AI
    // summarization is disabled, falls back to a deterministic extractive cut.
    const useAI = comp.useAISummarization !== false
    const summaryCap =
      typeof comp.maxSummaryTokens === "number" && comp.maxSummaryTokens > 0
        ? comp.maxSummaryTokens
        : 16_384
    const retainedBase =
      plan.kind === "rebuild"
        ? 0
        : estimateTokens([
            ...plan.systemHead,
            ...plan.keep,
            ...plan.tail,
            ...(progressFormat ? [] : plan.frozen),
          ])
    const envelopeTokens = estimateTokens([makeSummaryMessage("", state.frozenSummaryVersion + 1)])
    if (
      comp.postCompactionTokenBudgetIsDefault &&
      totalTarget !== undefined &&
      typeof comp.contextWindow === "number" &&
      plan.kind !== "rebuild"
    ) {
      totalTarget = Math.min(
        comp.contextWindow * (comp.fraction ?? AUTO_COMPACT_FRACTION) * 0.9,
        Math.max(
          totalTarget,
          framingTokens + retainedBase + retainedCheckpointBudget + envelopeTokens
        )
      )
    }
    const availableState =
      totalTarget === undefined
        ? Infinity
        : Math.floor(totalTarget - framingTokens - retainedBase - envelopeTokens)
    if (availableState <= 0 && plan.kind !== "rebuild") {
      log(
        "warn",
        "compaction cannot fit required instructions and recent tool pairs within the retained input budget"
      )
      if (force)
        reportManualOutcome(
          "failed",
          "Compaction failed: fixed instructions and recent tool pairs exceed the retained input budget. History is unchanged."
        )
      return
    }
    // The default is a starting allocation. Let accumulated findings use the
    // actual retained-input slack, while leaving room in summary requests for
    // new source and instructions. Explicit state caps remain strict.
    const checkpointBudget =
      comp.checkpointTokenBudgetIsDefault && Number.isFinite(availableState)
        ? Math.min(
            availableState,
            comp.summaryInputBudget === undefined
              ? Infinity
              : Math.floor(comp.summaryInputBudget * 0.75)
          )
        : Math.min(comp.checkpointTokenBudget ?? summaryCap, availableState)
    const shouldConsolidate = (priorContext: string) =>
      progressFormat &&
      parseProgressCheckpoint(priorContext) !== null &&
      estimateTokens([{ role: "user", content: priorContext }]) >= checkpointBudget * 0.5
    const siwcSummary =
      (comp.summary?.protocol ?? comp.summary?.credentials?.protocol ?? creds.protocol) ===
        SIWC_PROTOCOL ||
      (!comp.summary?.protocol && protocolAdapter.id === `ai-sdk:${SIWC_PROTOCOL}`)
    // Why the last AI summary produced nothing, for the manual caller.
    let summaryFailure: string | undefined
    const summaryMessages = (transcript: string, priorContext = ""): AdapterMessage[] => {
      const previous = progressFormat ? parseProgressCheckpoint(priorContext) : null
      // Established paragraphs stay host-owned: showing them as summary input
      // invites paraphrased copies to accumulate on every delta. The actor still
      // receives their full lossless merge; the summarizer needs task/status/ranges.
      const consolidate = shouldConsolidate(priorContext)
      const priorForDelta =
        previous && !consolidate
          ? JSON.stringify({
              ...previous,
              items: previous.items.map(({ summary: _retained, facts, ...item }) => ({
                ...item,
                ...(facts
                  ? { retainedFacts: facts.map(({ id, evidence }) => ({ id, evidence })) }
                  : {}),
              })),
            })
          : priorContext
      const background = consolidate
        ? `Consolidate this complete prior checkpoint with the new transcript into one UPDATED checkpoint. Rewrite repetitive prose into concise source-backed findings; retain every required workstream, inspected range, unresolved question and correction. Keep exact user-required literals in verbatim. The host preserves prior verbatim values, evidence, original goal/constraints and protected completion transitions. Do not append another retelling of the old summary.\n<prior_context>\n${priorContext}\n</prior_context>\n\n`
        : priorContext
          ? `${previous ? "The host retains established findings separately and merges your delta. This is prior workstream metadata, not findings to rewrite. Keep the original workstream IDs and source ranges; do not turn inspected ranges into pending ranges." : progressFormat ? "This legacy summary must be incorporated into the first structured checkpoint." : "Previous checkpoints remain preserved separately."} Use them to understand the original task, constraints, completed findings and outstanding work. Summarize the new material below, retaining a brief original-goal/constraints anchor and updated next actions. Do not repeat unchanged prior findings or infer a replacement task from tool output.\n<prior_context>\n${priorForDelta}\n</prior_context>\n\n`
          : ""
      const ownershipGuidance = consolidate
        ? "Rewrite navigation prose only. Return only NEW source-backed facts; the host retains all committed fact statements, citations, exact literals and legacy findings. Never replace required behaviors with a claim that earlier findings are unchanged. Do not duplicate fact statements in summary."
        : previous
          ? "The host retains previous facts verbatim and merges this DELTA. Never paraphrase or restate earlier findings; omit unchanged items."
          : priorContext
            ? "Establish the first structured checkpoint. Include established facts and unresolved work from the legacy prior context: they are not yet host-merged."
            : "Establish the first structured checkpoint with the original required workstreams and established facts."
      const budgetGuidance = progressFormat
        ? `${ownershipGuidance} The retained checkpoint budget is ${checkpointBudget} estimated tokens, independent of this call's ${summaryCap}-token generation budget (which also includes reasoning). Previous retained state uses ${previous ? estimateTokens([{ role: "user", content: priorContext }]) : 0}. ${consolidate ? "Consolidate to fit the retained budget." : "Use the remaining retained budget for concise new facts."} Preserve requested exact evidence codes and source-correction pairs, including superseded and current literal values.\n\n`
        : ""
      return [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `${background}${budgetGuidance}${SUMMARY_TRANSCRIPT_PREAMBLE}\n\n<transcript>\n${transcript}\n</transcript>`,
        },
      ]
    }
    const summaryInputTokens = (messages: ConversationMessage[], prior: ConversationMessage[]) =>
      estimatePromptTokens(
        summaryMessages(renderForSummary(messages), renderForSummary(prior)).map((m) => m.content)
      )
    // Keep only the immediately rejected preparation's actual summary inputs.
    // Appending history changes a snapshot but may leave its first partition
    // identical. Reuse that outcome instead of billing the same failed prefix.
    // A forced request, changed credentials/parameters or invalidation may retry.
    const summarizedToolResults = new Set<string>()
    const summarize = async (
      messages: ConversationMessage[],
      prior: ConversationMessage[] = [],
      refinement = 0,
      draft?: ProgressCheckpoint
    ): Promise<string | null> => {
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            summaryMessages(renderForSummary(messages), renderForSummary(prior)),
            prior,
            refinement,
            draft,
          ])
        )
        .digest("hex")
      let attempt = job.summaries.get(key)
      if (
        !attempt &&
        !force &&
        rejected?.contextKey === job.contextKey &&
        rejected.generation === job.generation &&
        rejected.gate === job.gate
      )
        attempt = rejected.summaries.get(key)
      if (!attempt)
        attempt = (async () => {
          const text = await summarizeUncached(messages, prior, refinement, draft)
          return { text, ...(summaryFailure ? { failure: summaryFailure } : {}) }
        })()
      job.summaries.set(key, attempt)
      const result = await attempt
      if (result.failure) summaryFailure = result.failure
      if (result.text) for (const id of toolResultIds(messages)) summarizedToolResults.add(id)
      return result.text
    }
    const summarizeUncached = async (
      messages: ConversationMessage[],
      prior: ConversationMessage[] = [],
      refinement = 0,
      draft?: ProgressCheckpoint
    ): Promise<string | null> => {
      signal.throwIfAborted()
      const inputBudget = comp.summaryInputBudget
      if (
        useAI &&
        inputBudget !== undefined &&
        summaryInputTokens(messages, prior) >= inputBudget
      ) {
        const units = toolPairUnits(messages)
        if (units.some((unit) => summaryInputTokens(unit, prior) >= inputBudget)) {
          summaryFailure =
            "required prior context or one indivisible tool exchange exceeds the summary model input budget"
          return null
        }
        const parts: string[] = []
        let cursor = 0
        while (cursor < units.length) {
          signal.throwIfAborted()
          // Carry a bounded accumulated checkpoint for research. Other summaries
          // retain the first part as the original-goal/constraints anchor; all
          // parts are reduced together below, never silently discarded.
          const context = parts.length
            ? progressFormat
              ? [{ role: "user", content: parts.at(-1)! }]
              : [...prior, { role: "user", content: parts[0]! }]
            : prior
          const chunk: ConversationMessage[] = []
          while (
            cursor < units.length &&
            summaryInputTokens([...chunk, ...units[cursor]!], context) < inputBudget
          ) {
            chunk.push(...units[cursor++]!)
          }
          if (!chunk.length) {
            summaryFailure =
              "required prior context or one indivisible tool exchange exceeds the summary model input budget"
            return null
          }
          const part = await summarize(chunk, context, refinement)
          if (!part) return null
          parts.push(part)
        }
        if (progressFormat) return parts.at(-1) ?? null
        const combined: ConversationMessage[] = parts.map((content) => ({ role: "user", content }))
        if (summaryInputTokens(combined, prior) >= summaryInputTokens(messages, prior)) {
          summaryFailure =
            "partitioned summaries did not reduce the material within the summary input budget"
          return null
        }
        return summarize(combined, prior, refinement)
      }
      const transcript = renderForSummary(messages)
      if (!useAI) {
        const suffix = "\n... (extractive summary truncated)"
        const cap = Math.max(0, checkpointBudget * 4 - suffix.length)
        return transcript.length > cap ? `${transcript.slice(0, cap)}${suffix}` : transcript
      }
      const text = (await summarizeOnce(transcript, summaryCap, renderForSummary(prior))).text
      if (!text || !progressFormat) return text
      const parsed = parseProgressCheckpoint(text)
      if (!parsed) {
        const issues = progressCheckpointIssueCodes(text).join(", ")
        if (refinement === 0) {
          log("warn", `compaction repairing one unpublished checkpoint draft (${issues})`)
          return summarize(
            [
              {
                role: "user",
                content: `Repair only this UNPUBLISHED checkpoint JSON draft. Schema errors: ${issues}. Preserve every reported source behavior, citation, required literal and correction. Give each fact a unique stable source/behavior ID; evidence must be an array of strings. Return valid checkpoint JSON only. Do not investigate or reread sources.\n<invalid_draft>\n${text}\n</invalid_draft>`,
              },
            ],
            prior,
            1
          )
        }
        summaryFailure = `invalid research progress checkpoint (${issues})`
        return null
      }
      const update = draft
        ? mergeProgressCheckpoint(draft, parsed, { consolidate: true, refineDraft: true })
        : parsed
      try {
        let previous: ProgressCheckpoint | null = null
        for (const message of prior) {
          const parsed =
            typeof message.content === "string" ? parseProgressCheckpoint(message.content) : null
          if (parsed) previous = mergeProgressCheckpoint(previous, parsed)
        }
        const merged = renderProgressCheckpoint(
          mergeProgressCheckpoint(
            previous,
            !previous && prior.length
              ? {
                  ...update,
                  legacyContext: renderForSummary(prior),
                }
              : update,
            {
              consolidate: shouldConsolidate(renderForSummary(prior)),
            }
          )
        )
        // The merged state is the summary itself, not an unbudgeted appendix.
        if (estimateTokens([{ role: "user", content: merged }]) > checkpointBudget) {
          if (refinement === 0) {
            // Reuse the already-produced state, not the source transcript.
            // This retry is distinct, ledgered, PII-gated and bounded to once.
            return summarize(
              [
                {
                  role: "user",
                  content: `This UNPUBLISHED draft exceeds the ${checkpointBudget}-token retained-state budget. Shorten its new fact statements and navigation prose without dropping required behaviors, citations, exact literals or corrections. Previously committed facts in prior_context remain host-owned; do not copy them. Return the refined delta only. No new investigation.\n<unpublished_draft>\n${renderProgressCheckpoint(update)}\n</unpublished_draft>`,
                },
              ],
              prior,
              1,
              update
            )
          }
          summaryFailure = "merged research progress exceeds the retained checkpoint budget"
          return null
        }
        return merged
      } catch {
        summaryFailure = "research progress exceeds its bounded state schema"
        return null
      }
    }
    const summarizeOnce = async (
      transcript: string,
      maxOutputTokens: number,
      priorContext = ""
    ): Promise<{ text: string | null; finishReason?: string }> => {
      let drained: { finishReason?: string; error?: unknown } = {}
      try {
        const sum = comp.summary ?? {}
        const summaryModel = sum.model || state.model
        const summaryCreds = sum.credentials || creds
        let summaryAdapter = protocolAdapter
        if (sum.protocol) {
          const alt = resolveAdapter(sum.protocol, sum.protocolAdapterSpec, {
            ...(hostRpc
              ? {
                  nativeCall: (method: string, params: Record<string, unknown>) =>
                    hostRpc.call(method, params, { timeoutMs: 70_000 }),
                }
              : {}),
            emit,
            sessionId,
            pendingProtocolExecs,
          })
          if (alt) summaryAdapter = alt
        }
        if (siwcSummary && state.turnLedgerGate?.active) {
          throw new Error(
            "SIWC preview cannot enforce the output-token cap required for a ledgered summary"
          )
        }
        // The preview rejects max_output_tokens. Preserve an explicit user
        // constraint for native validation, but do not invent an unsupported cap.
        const summaryParams: Record<string, unknown> = siwcSummary
          ? { ...modelParams }
          : { ...modelParams, maxOutputTokens }
        const summaryProviderId = sum.credentials ? sum.providerId : provider
        if (summaryAdapter.id === "ai-sdk:anthropic") {
          const thinking = (
            summaryParams.providerOptions as
              | {
                  anthropic?: { thinking?: { type?: string; budgetTokens?: number } }
                }
              | undefined
          )?.anthropic?.thinking
          // The installed Anthropic SDK adds enabled thinking to maxOutputTokens.
          // Keep the wire maximum, ledger reservation and input reserve identical.
          // Adaptive-only families convert enabled thinking before this addition.
          const thinkingTokens =
            thinking?.type === "enabled" &&
            !claude55CapabilitiesForModel(summaryModel) &&
            !summaryModel.includes("claude-fable-5")
              ? (thinking.budgetTokens ?? 1024)
              : 0
          if (thinkingTokens >= maxOutputTokens)
            throw new Error("The explicit summary thinking budget leaves no room for summary text")
          summaryParams.maxOutputTokens = maxOutputTokens - thinkingTokens
        }
        // Native DeepSeek V4 enables thinking by default; a small auxiliary
        // summary can otherwise spend its entire existing output cap reasoning.
        // Default to direct text for this auxiliary extraction, preserving all
        // explicit provider knobs and effort. Relays may ignore thinking flags.
        if (
          summaryProviderId === "deepseek" &&
          summaryAdapter.id === "ai-sdk:openai" &&
          summaryCreds.apiFlavor !== "responses" &&
          summaryModel.includes("deepseek-v4")
        ) {
          const rawOptions = summaryParams.providerOptions
          const recordOptions = (value: unknown): value is Record<string, unknown> =>
            typeof value === "object" && value !== null && !Array.isArray(value)
          if (
            (rawOptions === undefined || recordOptions(rawOptions)) &&
            (rawOptions?.deepseek === undefined || recordOptions(rawOptions.deepseek))
          ) {
            const providerOptions = summaryParams.providerOptions as
              Record<string, unknown> | undefined
            const explicit = providerOptions?.deepseek as Record<string, unknown> | undefined
            // Provider wire input may carry "none" outside the canonical agent effort union.
            const wireOptions: { effort?: SendOptions["effort"] | "none" } = sendOptions
            const effort = wireOptions.effort
            const defaults =
              effort === "none"
                ? { thinking: { type: "disabled" } }
                : effort
                  ? { reasoningEffort: effort }
                  : sendOptions.maxThinkingTokens !== undefined ||
                      explicit?.thinking !== undefined ||
                      explicit?.reasoningEffort !== undefined
                    ? {}
                    : { thinking: { type: "disabled" } }
            summaryParams.providerOptions = {
              ...providerOptions,
              deepseek: { ...defaults, ...explicit },
            }
          }
        }
        const messages = summaryMessages(transcript, priorContext)
        if (!hasNoLeakingPiiDeep(messages))
          throw new Error("Compaction summary blocked by the PII gate")
        const estimatedInputTokens = estimatePromptTokens(messages.map((m) => m.content))
        if (
          comp.summaryInputBudget !== undefined &&
          estimatedInputTokens >= comp.summaryInputBudget
        )
          throw new Error(
            `Compaction summary exceeds the summary model input budget (${estimatedInputTokens} estimated tokens; limit ${comp.summaryInputBudget})`
          )
        // Router + Fusion: inside a ledgered turn the summary is a reserved call
        // like any other; a refusal skips the AI summary.
        const outcome = await runLedgeredSideCall(
          state.turnLedgerGate,
          {
            logicalStepId: `compact:${++state.ledgerSideCalls}`,
            deploymentId: `${summaryProviderId}::${summaryModel}`,
            estimatedInputTokens,
            maxOutputTokens,
          },
          () =>
            abortable(signal, async () => {
              const run = await summaryAdapter.start({
                sessionId,
                model: summaryModel,
                messages,
                modelParams: summaryParams,
                tools: undefined,
                maxSteps: 1,
                credentials: summaryCreds,
                // Must track whichever credentials won above: a distinct summary
                // provider carries its own id, otherwise these ARE the turn's creds
                // and so is its provider. Omitting it dropped codex-on-a-relay back
                // to `.chat()` for compaction only — the turn itself still worked.
                providerId: summaryProviderId,
                // Interruptible: a hung summary provider must not stall the turn
                // head forever. Absent for a between-turns manual compaction (no
                // active controller) — that call has no turn to stall.
                ...(state.activeAbortController
                  ? { abortSignal: state.activeAbortController.signal }
                  : {}),
                streamTextFn: streamTextOverride,
              })
              const result = await drainSideCallStream(run, {
                withBilling: state.turnLedgerGate?.active === true,
              })
              drained = result
              return result
            }),
          { isCancelled: () => signal.aborted || isCancelled() }
        )
        if (!outcome.sent) {
          log("warn", `compaction summary refused by Router + Fusion: ${outcome.refusal.code}`)
          summaryFailure = `the summary call was refused by Router + Fusion (${outcome.refusal.code})`
          return { text: null }
        }
        if (
          drained.error ||
          (drained.finishReason !== undefined && drained.finishReason !== "stop")
        ) {
          summaryFailure =
            drained.finishReason === "length"
              ? `the summary was truncated at its ${maxOutputTokens}-token output limit`
              : drained.error
                ? `the summary call failed: ${errorToMessage(drained.error)}`
                : drained.finishReason === "tool-calls" || drained.finishReason === "content-filter"
                  ? emptySummaryReason(drained, maxOutputTokens)
                  : `the summary ended without a normal stop (finish reason: ${drained.finishReason}; visible characters: ${outcome.value.length})`
          log("warn", `compaction summary rejected: ${summaryFailure}`)
          return { text: null, finishReason: drained.finishReason }
        }
        const text = outcome.value.trim()
        if (text)
          return { text, ...(drained.finishReason ? { finishReason: drained.finishReason } : {}) }
        summaryFailure = emptySummaryReason(drained, maxOutputTokens)
        log("warn", `compaction summary produced no text: ${summaryFailure}`)
        return {
          text: null,
          ...(drained.finishReason ? { finishReason: drained.finishReason } : {}),
        }
      } catch (err) {
        if (signal.aborted) throw err
        log("warn", `compaction summary failed, skipping: ${errorToMessage(err)}`)
        summaryFailure = `the summary call failed: ${errorToMessage(err)}`
        return { text: null }
      }
    }

    // A manual `/compact` is waiting for an answer: say the summary failed and
    // nothing changed, instead of letting it time out into "it will apply
    // later" — no later attempt is queued.
    const reportSummaryFailure = () => {
      // A cancelled preparation is superseded (a newer request or the turn
      // that aborted it answers instead), not failed.
      if (!force || signal.aborted) return
      reportManualOutcome(
        "failed",
        `Compaction failed: ${summaryFailure ?? "the summary model returned no text"}. Nothing was compacted.`
      )
    }

    // Reuse prior frozen summaries verbatim (prefix-cache stable) until too many
    // accumulate, then collapse once.
    const frozen = "frozen" in plan ? plan.frozen : []
    // A resumed child starts a new transport conversation. Restore its saved
    // structured findings as merge state, rather than asking the model to
    // reconstruct them from the textual continuation wrapper.
    const restored =
      progressFormat && frozen.length === 0
        ? conversation
            .filter((message) => message.role === "user")
            .map((message) => renderForSummary([message]))
            .filter(
              (text) =>
                text.includes("You previously worked on this task:\n") &&
                text.includes("Your result was:\n")
            )
            .map(parseProgressCheckpoint)
            .filter((checkpoint) => checkpoint !== null)
            .at(-1)
        : null
    const summaryPrior: ConversationMessage[] = restored
      ? [{ role: "user", content: renderProgressCheckpoint(restored) }]
      : frozen
    const regenerate = progressFormat || frozen.length >= MAX_FROZEN_SUMMARIES
    const nextVersion =
      (frozen.length > 0
        ? Math.max(state.frozenSummaryVersion, ...frozen.map(summaryVersion))
        : state.frozenSummaryVersion) + 1

    let next
    let decision = "reused"
    let summaryProduced = false
    let opticalMeta

    // Optical strategy (ADR-0063): render the `middle` to image frame(s) the
    // vision state.model reads back. `buildOpticalCompaction` gates on coverage,
    // budget, and a round-trip readability check; on any failure it returns null
    // and we drop through to summarize the same `middle` as text below.
    if (plan.kind === "optical") {
      const { buildOpticalCompaction } = await import("../../context/optical/compact.ts")
      const opticalTranscribe = async (dataUrl: string) => {
        signal.throwIfAborted()
        const sum = comp.summary ?? {}
        let visionAdapter = protocolAdapter
        if (sum.protocol) {
          const alt = resolveAdapter(sum.protocol, sum.protocolAdapterSpec, {
            ...(hostRpc
              ? {
                  nativeCall: (method: string, params: Record<string, unknown>) =>
                    hostRpc.call(method, params, { timeoutMs: 70_000 }),
                }
              : {}),
            emit,
            sessionId,
            pendingProtocolExecs,
          })
          if (alt) visionAdapter = alt
        }
        const visionModel = sum.model || state.model
        const visionProviderId = sum.credentials ? sum.providerId : provider
        if (siwcSummary && state.turnLedgerGate?.active) {
          throw new Error(
            "SIWC preview cannot enforce the output-token cap required for a ledgered vision call"
          )
        }
        const outcome = await runLedgeredSideCall(
          state.turnLedgerGate,
          {
            logicalStepId: `optical:${++state.ledgerSideCalls}`,
            deploymentId: `${visionProviderId}::${visionModel}`,
            // An image part is billed as input tokens the text estimate cannot see.
            estimatedInputTokens: estimatePromptTokens([dataUrl]),
            maxOutputTokens: 1024,
          },
          () =>
            abortable(signal, async () => {
              const run = await visionAdapter.start({
                model: visionModel,
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "file", data: dataUrl, mediaType: "image/png" },
                      {
                        type: "text",
                        text: "Transcribe ALL text visible in this image verbatim, preserving reading order. Output only the transcription, no commentary.",
                      },
                    ],
                  },
                ],
                modelParams: siwcSummary
                  ? { ...modelParams }
                  : { ...modelParams, maxOutputTokens: 1024 },
                tools: undefined,
                maxSteps: 1,
                credentials: sum.credentials || creds,
                // Same pairing as the summary call above.
                providerId: visionProviderId,
                ...(state.activeAbortController
                  ? { abortSignal: state.activeAbortController.signal }
                  : {}),
                streamTextFn: streamTextOverride,
              })
              return drainSideCallStream(run, {
                withBilling: state.turnLedgerGate?.active === true,
              })
            }),
          { isCancelled: () => signal.aborted || isCancelled() }
        )
        if (!outcome.sent) {
          throw new Error(
            `optical transcription refused by Router + Fusion: ${outcome.refusal.code}`
          )
        }
        return outcome.value.trim()
      }
      signal.throwIfAborted()
      const optical = await buildOpticalCompaction({
        middle: plan.middle,
        modelId: state.model,
        version: nextVersion,
        options: comp.optical ?? {},
        transcribe: comp.optical?.verify === false ? undefined : opticalTranscribe,
        log,
      })
      if (optical) {
        next = [...plan.systemHead, ...frozen, ...(plan.keep ?? []), optical.message, ...plan.tail]
        opticalMeta = optical.meta
        summaryProduced = true
      }
    }

    if (next === undefined && plan.kind === "rebuild") {
      // Sliding-window (or a no-op fallback) — no LLM call.
      next = plan.rebuilt
    } else if (next === undefined && plan.kind !== "rebuild") {
      let summaryText
      if (plan.kind === "chunked") {
        // Chunks are independent — summarize them concurrently (order is
        // preserved by Promise.all's positional results).
        const prior = progressFormat || !regenerate ? summaryPrior : []
        const parts: (string | null)[] = []
        if (progressFormat) {
          let context = prior
          for (const chunk of plan.chunks) {
            const part = await summarize(chunk, context)
            parts.push(part)
            if (!part) break
            context = [{ role: "user", content: part }]
          }
        } else
          parts.push(...(await Promise.all(plan.chunks.map((chunk) => summarize(chunk, prior)))))
        if (parts.some((part) => !part)) {
          reportSummaryFailure()
          return
        }
        if (!progressFormat && regenerate && frozen.length) parts.unshift(renderForSummary(frozen))
        if (parts.length === 0) {
          reportSummaryFailure()
          return
        }
        if (progressFormat) {
          summaryText = parts.at(-1)!
          if (estimateTokens([{ role: "user", content: summaryText }]) > checkpointBudget) {
            summaryFailure = "merged research progress exceeds the retained checkpoint budget"
            reportSummaryFailure()
            return
          }
        } else
          summaryText =
            parts.length > 1 && useAI
              ? await summarize([{ role: "user", content: parts.join("\n\n") }], prior)
              : parts.join("\n\n")
      } else {
        const material = plan.kind === "selective" ? plan.summarizeSet : plan.middle
        const full =
          !progressFormat && regenerate && frozen.length ? [...frozen, ...material] : material
        // Prior context informs a delta without paying output tokens to copy
        // unchanged findings into each independently preserved cached checkpoint.
        summaryText = await summarize(full, progressFormat || !regenerate ? summaryPrior : [])
      }
      if (!summaryText) {
        reportSummaryFailure()
        return
      }
      if (progressFormat && !hasNoLeakingPiiDeep(summaryText)) {
        summaryFailure = "generated research progress blocked by the PII gate"
        reportSummaryFailure()
        return
      }
      summaryProduced = true
      decision = regenerate ? "regenerated" : "reused"
      const summaryMsg = makeSummaryMessage(summaryText, nextVersion)
      const keep = plan.keep ?? []
      next = regenerate
        ? [...plan.systemHead, ...keep, summaryMsg, ...plan.tail]
        : [...plan.systemHead, ...frozen, ...keep, summaryMsg, ...plan.tail]
    }

    // Per-tool-result cap (independent of the summary strategy).
    next = capToolResults(next!, {
      maxToolResultTokens: comp.maxToolResultTokens,
      preserveToolCallMetadata: comp.preserveToolCallMetadata,
    })

    return {
      next,
      retainedTarget: totalTarget,
      checkpointBudget,
      summarizedToolResultIds: useAI && summaryProduced ? [...summarizedToolResults] : [],
      version: summaryProduced ? nextVersion : undefined,
      captureUndo: comp.captureUndoSnapshot,
      metadata: {
        trigger: trigger ?? (force ? "manual" : "auto"),
        strategy: comp.strategy ?? "summary",
        ...(summaryProduced ? { frozenSummaryDecision: decision } : {}),
        ...(opticalMeta ? { optical: { ...opticalMeta, sessionId } } : {}),
        ...(plan.kind === "optical" && !opticalMeta ? { opticalFallback: true } : {}),
      },
    }
  }

  /** Tell a manual compaction's caller it finished without a boundary. */
  function reportManualOutcome(outcome: ManualCompactOutcome, content: string) {
    emit({
      type: "event",
      sessionId,
      event: manualCompactOutcomeEvent(sdkSessionId, outcome, content),
    })
  }

  function publish(job: Job) {
    if (!matches(job)) return
    if (!job.result) {
      rejected = job
      return
    }
    const { next, version, captureUndo, metadata } = job.result
    // Newly appended messages were never included in the preparation and must
    // survive verbatim. Undo captures the complete history at publication.
    const preMessages = captureUndo ? structuredClone(conversation) : undefined
    const preTokens = state.lastInputTokens || estimateTokens(conversation)
    const combined = [...next, ...conversation.slice(job.snapshot.length)]
    // The compacted history is what gets saved and later resumed, and a resume
    // refuses an orphan tool result or an unanswered call. The planner keeps
    // pairs whole; refuse to publish if a compaction would still split one
    // that was intact (a pair already broken before is not ours to judge).
    const before = unpairedToolCallIds(conversation)
    const split = [...unpairedToolCallIds(combined)].filter((id) => !before.has(id))
    if (split.length > 0) {
      rejected = job
      log(
        "warn",
        `compaction discarded: it would separate ${split.length} tool call(s) from their results (${split.slice(0, 3).join(", ")})`
      )
      if (job.force)
        reportManualOutcome(
          "failed",
          "Compaction failed: it would have separated a tool call from its result, which would make the session impossible to resume. Nothing was compacted."
        )
      return
    }
    const postTokens = estimateTokens(combined)
    const limit = sendOptions.compaction?.contextWindow
    const comp = sendOptions.compaction
    const projectedInput = postTokens + (state.promptOverheadTokens ?? 0)
    // A default target may meet an irreducible system/pair-safe-tail floor.
    // Accommodate it only below the trigger, with a further safety margin.
    // An explicit total target is never relaxed.
    const target = job.result.retainedTarget ?? postCompactionTarget()
    // Validate the whole published candidate, including concurrent appends and
    // frozen summaries. A non-shrinking automatic compaction cannot make progress.
    if (
      (typeof limit === "number" && projectedInput >= limit) ||
      (target !== undefined && projectedInput > target) ||
      (!job.force && postTokens >= estimateTokens(conversation))
    ) {
      rejected = job
      log("warn", "compaction discarded: replacement does not fit or reduce the context budget")
      if (job.force)
        reportManualOutcome(
          "failed",
          "Compaction failed: replacement exceeds the context budget. Nothing was compacted."
        )
      return
    }
    conversation.splice(0, conversation.length, ...combined)
    rejected = undefined
    if (version !== undefined) state.frozenSummaryVersion = version
    state.lastInputTokens = 0
    // Require new growth after a successful swap. Hard limits bypass this gate.
    softRearmTokens = projectedInput + (typeof limit === "number" ? limit * 0.1 : 0)
    const continuationSummary = combined
      .filter(isSummaryMessage)
      .flatMap((message) => (typeof message.content === "string" ? [message.content] : []))
      .join("\n\n")
    const retainedToolResults = new Set(toolResultIds(combined))
    emit({
      type: "event",
      sessionId,
      event: {
        type: "system",
        subtype: "compact_boundary",
        uuid: randomUUID(),
        session_id: sdkSessionId,
        compact_metadata: {
          ...metadata,
          pre_tokens: preTokens,
          post_tokens: estimateTokens(combined),
          projected_input_tokens: projectedInput,
          post_compaction_token_budget: target,
          checkpoint_token_budget: job.result.checkpointBudget,
          summary_generation_token_budget: comp?.maxSummaryTokens,
          // Text checkpoints only: never include optical image payloads or
          // reasoning. Budget-stop capture retains this bounded model summary.
          continuation_summary: continuationSummary,
          // Serialization length, not another configurable budget. The whole
          // candidate has already passed the retained-input guard above.
          continuation_summary_chars: continuationSummary.length,
          continuation_tool_result_ids: job.result.summarizedToolResultIds.filter(
            (id) => !retainedToolResults.has(id)
          ),
          ...(preMessages ? { pre_messages: preMessages } : {}),
        },
      },
    })
  }
  function triggered(factor: number) {
    const comp = sendOptions.compaction ?? {}
    if (comp.enabled === false || comp.trigger === "manual") return false
    if (factor < 1 && comp.trigger !== "message-count" && state.lastInputTokens < softRearmTokens)
      return false
    return shouldCompact(
      comp.trigger === "message-count"
        ? {
            trigger: "message-count",
            messageCount: conversation.length,
            messageCountThreshold:
              typeof comp.messageCountThreshold === "number"
                ? Math.ceil(comp.messageCountThreshold * factor)
                : undefined,
          }
        : {
            lastInputTokens: Math.max(
              state.lastInputTokens,
              estimateTokens(conversation) + (state.promptOverheadTokens ?? 0)
            ),
            modelId: state.model,
            contextWindow: comp.contextWindow,
            fraction: (comp.fraction ?? AUTO_COMPACT_FRACTION) * factor,
          }
    )
  }

  async function maybeCompact(
    creds: AdapterCredentials,
    modelParams: Record<string, unknown>,
    options: { force?: boolean; focus?: string; trigger?: "auto" } = {}
  ) {
    const contextKey = createHash("sha256")
      .update(
        JSON.stringify([
          state.model,
          creds,
          modelParams,
          sendOptions.compaction,
          options.focus,
          sendOptions.effort,
          sendOptions.maxThinkingTokens,
        ])
      )
      .digest("hex")
    if (pending && (!matches(pending) || pending.contextKey !== contextKey || options.force))
      invalidate()
    if (pending?.settled) {
      const completed = pending
      pending = undefined
      publish(completed)
      // A failed preparation is retried only at a later safe boundary.
      return
    }
    const hard = options.force || triggered(1)
    // Small contexts cannot absorb a background checkpoint plus the growing
    // exact tail. Compact synchronously there; retain an explicit override.
    const background = sendOptions.compaction?.background ?? state.lastInputTokens >= 64_000
    if (!pending && (hard || (background && triggered(0.8)))) {
      const controller = new AbortController()
      const parentSignal = state.activeAbortController?.signal
      const abort = () => controller.abort(parentSignal?.reason)
      if (parentSignal?.aborted) abort()
      else parentSignal?.addEventListener("abort", abort, { once: true })
      const job: Job = {
        generation,
        snapshot: structuredClone(conversation),
        controller,
        model: state.model,
        gate: state.turnLedgerGate,
        force: options.force === true,
        settled: false,
        contextKey,
        summaries: new Map(),
        promise: Promise.resolve(),
      }
      pending = job
      running.add(job)
      job.promise = prepare(creds, modelParams, job, options)
        .then((result) => {
          job.result = result
        })
        .catch((error) => {
          if (controller.signal.aborted) return
          log("warn", `compaction preparation failed: ${errorToMessage(error)}`)
          if (options.force)
            reportManualOutcome(
              "failed",
              `Compaction failed: ${errorToMessage(error)}. Nothing was compacted.`
            )
        })
        .finally(() => {
          job.settled = true
          running.delete(job)
          parentSignal?.removeEventListener("abort", abort)
        })
    }
    if (hard && pending) {
      const job = pending
      await job.promise
      if (pending === job) {
        pending = undefined
        publish(job)
      }
    }
  }

  // Do not let a side call outlive the turn that owns its ledger reservation.
  // Completed candidates can safely wait for the next model-loop boundary.
  async function settle() {
    const jobs = [...running]
    if (pending && !pending.settled) invalidate()
    for (const job of jobs) job.controller.abort()
    await Promise.all(jobs.map((job) => job.promise))
  }
  return Object.assign(maybeCompact, { invalidate, settle })
}
