import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { SendOptions } from "../../shared/wire/inbound.ts"
import type { HostRpcCaller } from "../../tools/state/host-background-shells.ts"
import type {
  AdapterCredentials,
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
  summaryVersion,
  AUTO_COMPACT_FRACTION,
} from "../../context/compaction.ts"
import { planStrategy } from "../../context/strategies.ts"
import { queryPreCompactDecision } from "../../hooks/pre-compact.ts"
import { runPluginHookHandler, PLUGIN_HOOK_BROADCAST } from "../../hooks/handlers/plugin.ts"
import { capToolResults } from "../../context/tool-result-cap.ts"
import { resolveAdapter } from "../../providers/protocol-adapters/registry.ts"
import {
  drainSideCallStream,
  estimatePromptTokens,
  runLedgeredSideCall,
} from "../common/call-ledger-gate.ts"
import { errorToMessage } from "./messages.ts"
const COMPACT_KEEP_RECENT_MESSAGES = 6
const MAX_FROZEN_SUMMARIES = 4
const DEFAULT_SUMMARY_PROMPT =
  "You compact a long conversation. Produce a concise summary that preserves " +
  "decisions made, facts established, file paths, and any open threads. Use " +
  "terse bullet points. Do not add commentary."
export interface CompactionState {
  model: string
  lastInputTokens: number
  frozenSummaryVersion: number
  ledgerSideCalls: number
  turnLedgerGate: CallLedgerGate | null
  activeAbortController: AbortController | null
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
    return messages
      .map((m) => {
        const text =
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("")
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
    result?: Prepared
    settled: boolean
    promise: Promise<void>
  }
  let pending: Job | undefined
  const running = new Set<Job>()

  function invalidate() {
    generation++
    pending?.controller.abort()
    for (const job of running) job.controller.abort()
    pending = undefined
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
      return
    }

    const keepRecent =
      typeof comp.keepRecent === "number" ? comp.keepRecent : COMPACT_KEEP_RECENT_MESSAGES

    const plan = planStrategy({
      // Plugin strategy override takes precedence, then user-configured strategy
      strategy: preCompactDecision.strategyOverride ?? comp.strategy,
      conversation,
      keepRecent,
      preserveSystemMessages: comp.preserveSystemMessages,
      recursiveChunkSize: comp.recursiveChunkSize,
      importanceThreshold: comp.importanceThreshold,
      retainedFraction: comp.retainedFraction,
      modelId: state.model,
      // Authoritative catalog-resolved window (same source `shouldCompact`
      // uses) so the drain-line budget doesn't fall back to the regex table.
      ...(typeof comp.contextWindow === "number" ? { contextWindow: comp.contextWindow } : {}),
    })
    if (plan.kind === "none") return

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

    // Summary executor: alternate cheap state.model + credentials + adapter, with the
    // output token cap. Returns trimmed text, or null on failure/empty. When AI
    // summarization is disabled, falls back to a deterministic extractive cut.
    const useAI = comp.useAISummarization !== false
    const summaryCap =
      typeof comp.maxSummaryTokens === "number" && comp.maxSummaryTokens > 0
        ? comp.maxSummaryTokens
        : 500
    const summarize = async (messages: ConversationMessage[]) => {
      signal.throwIfAborted()
      const transcript = renderForSummary(messages)
      if (!useAI) {
        const cap = summaryCap * 4
        return transcript.length > cap
          ? `${transcript.slice(0, cap)}\n... (extractive summary truncated)`
          : transcript
      }
      try {
        const sum = comp.summary ?? {}
        const summaryModel = sum.model || state.model
        const summaryCreds = sum.credentials || creds
        let summaryAdapter = protocolAdapter
        if (sum.protocol) {
          const alt = resolveAdapter(sum.protocol, sum.protocolAdapterSpec, {
            emit,
            sessionId,
            pendingProtocolExecs,
          })
          if (alt) summaryAdapter = alt
        }
        const summaryParams = { ...modelParams, maxOutputTokens: summaryCap }
        const summaryProviderId = sum.credentials ? sum.providerId : provider
        // Router + Fusion: inside a ledgered turn the summary is a reserved call
        // like any other; a refusal skips the AI summary.
        const outcome = await runLedgeredSideCall(
          state.turnLedgerGate,
          {
            logicalStepId: `compact:${++state.ledgerSideCalls}`,
            deploymentId: `${summaryProviderId}::${summaryModel}`,
            estimatedInputTokens: estimatePromptTokens([systemPrompt, transcript]),
            maxOutputTokens: summaryCap,
          },
          () =>
            abortable(signal, async () => {
              const run = await summaryAdapter.start({
                sessionId,
                model: summaryModel,
                messages: [
                  { role: "system", content: systemPrompt },
                  { role: "user", content: transcript },
                ],
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
              return drainSideCallStream(run, {
                withBilling: state.turnLedgerGate?.active === true,
              })
            }),
          { isCancelled: () => signal.aborted || isCancelled() }
        )
        if (!outcome.sent) {
          log("warn", `compaction summary refused by Router + Fusion: ${outcome.refusal.code}`)
          return null
        }
        return outcome.value.trim() || null
      } catch (err) {
        log("warn", `compaction summary failed, skipping: ${errorToMessage(err)}`)
        return null
      }
    }

    // Reuse prior frozen summaries verbatim (prefix-cache stable) until too many
    // accumulate, then collapse once.
    const frozen = "frozen" in plan ? plan.frozen : []
    const regenerate = frozen.length >= MAX_FROZEN_SUMMARIES
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
            emit,
            sessionId,
            pendingProtocolExecs,
          })
          if (alt) visionAdapter = alt
        }
        const visionModel = sum.model || state.model
        const visionProviderId = sum.credentials ? sum.providerId : provider
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
                      { type: "image", image: dataUrl, mediaType: "image/png" },
                      {
                        type: "text",
                        text: "Transcribe ALL text visible in this image verbatim, preserving reading order. Output only the transcription, no commentary.",
                      },
                    ],
                  },
                ],
                modelParams: { ...modelParams, maxOutputTokens: 1024 },
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
        const parts = (await Promise.all(plan.chunks.map((chunk) => summarize(chunk)))).filter(
          Boolean
        )
        if (regenerate && frozen.length) parts.unshift(renderForSummary(frozen))
        if (parts.length === 0) return
        summaryText =
          parts.length > 1 && useAI
            ? ((await summarize([{ role: "user", content: parts.join("\n\n") }])) ??
              parts.join("\n\n"))
            : parts.join("\n\n")
      } else {
        const material = plan.kind === "selective" ? plan.summarizeSet : plan.middle
        const full = regenerate && frozen.length ? [...frozen, ...material] : material
        summaryText = await summarize(full)
      }
      if (!summaryText) return
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

  function publish(job: Job) {
    if (!job.result || !matches(job)) return
    const { next, version, captureUndo, metadata } = job.result
    // Newly appended messages were never included in the preparation and must
    // survive verbatim. Undo captures the complete history at publication.
    const preMessages = captureUndo ? structuredClone(conversation) : undefined
    const preTokens = state.lastInputTokens || estimateTokens(conversation)
    const combined = [...next, ...conversation.slice(job.snapshot.length)]
    conversation.splice(0, conversation.length, ...combined)
    if (version !== undefined) state.frozenSummaryVersion = version
    state.lastInputTokens = 0
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
          ...(preMessages ? { pre_messages: preMessages } : {}),
        },
      },
    })
  }
  function triggered(factor: number) {
    const comp = sendOptions.compaction ?? {}
    if (comp.enabled === false || comp.trigger === "manual") return false
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
            lastInputTokens: state.lastInputTokens,
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
    if (pending && (!matches(pending) || options.force)) invalidate()
    if (pending?.settled) {
      const completed = pending
      pending = undefined
      publish(completed)
      // A failed preparation is retried only at a later safe boundary.
      return
    }
    const hard = options.force || triggered(1)
    if (!pending && (hard || triggered(0.8))) {
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
        settled: false,
        promise: Promise.resolve(),
      }
      pending = job
      running.add(job)
      job.promise = prepare(creds, modelParams, job, options)
        .then((result) => {
          job.result = result
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            log("warn", `compaction preparation failed: ${errorToMessage(error)}`)
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
