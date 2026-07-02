/**
 * PII-aware wrapper around `runAndCaptureAssistantReply` used by the
 * connector subsystem when it drives an auto-mode AI turn on behalf of
 * an inbound IM message.
 *
 * Why the wrapper exists: the same red-line that `lib/twin/ingest/` and
 * `lib/goal/` enforce — "raw user-supplied text MUST be checked by
 * `hasNoLeakingPii` before it leaves the device" — also applies to
 * auto-mode IM replies. The renderer-side chat composer is reviewed by
 * a human; the IM-driven loop is not. So this wrapper:
 *
 *   1. Walks every text-bearing block of the inbound `SendContent` plus
 *      any `appendSystemPrompt` injected by build-options.
 *   2. Calls `hasNoLeakingPii` on each.
 *   3. If anything leaks, aborts before calling the model and writes a
 *      `connector.error` audit row tagged `reason: "pii_blocked"` so the
 *      operator can see why the auto reply did not fire.
 *
 * Returns the same shape as `runAndCaptureAssistantReply` so callers can
 * substitute one for the other without code-path changes.
 */

import { hasNoLeakingPii } from "@/lib/twin/ingest/redact"
import {
  RunAndCaptureError,
  runAndCaptureAssistantReply,
  type RunAndCaptureOptions,
  type RunAndCaptureResult,
} from "@/lib/claude/run-and-capture"
import type { SendContent, SendOptions } from "@/lib/claude/types"
import { appendAudit } from "@/lib/connectors/audit"
import { recordProviderOutcome } from "@/lib/claude/provider-telemetry"
import { recordConnectorUsage, swallowUsageWrite } from "@/lib/db/session-usage"

export interface SafeSendPromptOptions extends RunAndCaptureOptions {
  /**
   * The adapter the auto-mode call originated from. Used as the
   * `adapterId` of the audit row when PII gating aborts the call.
   */
  adapterId: string
  /**
   * The conversation key on the adapter side — surfaced in the audit
   * row so the operator can jump straight to the offending thread.
   */
  conversationKey: string
}

/**
 * Bounded memo for the *system-prompt* PII scan. The `appendSystemPrompt`
 * build-options injects (character prompt + twin/memory/skills/capability
 * sections) is large and largely stable across a conversation's turns, so the
 * same string is otherwise rescanned (≈12 regex sweeps) every turn. Caching the
 * boolean by exact content skips the sweep on a repeat.
 *
 * This does NOT weaken the gate: `hasNoLeakingPii` is a pure, stateless function
 * of its text (redact.ts:388), so a cached `true` is permanently valid for that
 * exact string. A never-seen OR PII-leaking prompt is a cache miss that runs the
 * real scan and still throws. The inbound user prompt (line ~78) is intentionally
 * NOT cached — it changes every turn, so a cache would only add overhead.
 */
const SYSTEM_PROMPT_PII_CACHE_CAP = 64
const systemPromptPiiCache = new Map<string, boolean>()

export function hasNoLeakingPiiCached(text: string): boolean {
  const hit = systemPromptPiiCache.get(text)
  if (hit !== undefined) {
    // Refresh LRU recency (delete + re-set moves the key to the newest slot).
    systemPromptPiiCache.delete(text)
    systemPromptPiiCache.set(text, hit)
    return hit
  }
  const result = hasNoLeakingPii(text)
  if (systemPromptPiiCache.size >= SYSTEM_PROMPT_PII_CACHE_CAP) {
    const oldest = systemPromptPiiCache.keys().next().value
    if (oldest !== undefined) systemPromptPiiCache.delete(oldest)
  }
  systemPromptPiiCache.set(text, result)
  return result
}

/** Test-only — clear the system-prompt PII memo between cases. */
export function _resetSystemPromptPiiCacheForTest(): void {
  systemPromptPiiCache.clear()
}

export class PiiGateBlocked extends Error {
  constructor(
    readonly source: "prompt" | "appendSystemPrompt",
    readonly adapterId: string,
    readonly conversationKey: string
  ) {
    super(`PII gate blocked auto-mode send (${source}) on ${adapterId}/${conversationKey}`)
    this.name = "PiiGateBlocked"
  }
}

/**
 * Drive a Claude turn for the connector auto-mode loop, gating on the
 * PII red-line first.
 *
 * Throws `PiiGateBlocked` when the prompt OR the appendSystemPrompt
 * carries leakable PII; the audit row is written before the throw so
 * the caller can simply propagate.
 *
 * Throws `RunAndCaptureError` on the same conditions as the underlying
 * `runAndCaptureAssistantReply` — the wrapper is transparent past the
 * PII gate.
 */
export async function safeSendPrompt(
  sessionId: string,
  prompt: SendContent,
  options: SendOptions | undefined,
  opts: SafeSendPromptOptions
): Promise<RunAndCaptureResult> {
  // ── 1. Walk prompt content for PII ─────────────────────────────────
  if (!isPiiSafeSendContent(prompt)) {
    await appendAudit({
      adapterId: opts.adapterId,
      kind: "adapter.error",
      at: Date.now(),
      conversationKey: opts.conversationKey,
      reason: "pii_blocked",
      message: "auto-mode prompt rejected by PII gate before sendPrompt",
    })
    throw new PiiGateBlocked("prompt", opts.adapterId, opts.conversationKey)
  }

  // ── 2. Walk the model-side system-prompt tail (build-options may
  //     inject capability context, twin runtime hints, etc.). We don't
  //     redact — we abort, because the auto-mode loop has no human to
  //     decide what to redact.
  if (options?.appendSystemPrompt && !hasNoLeakingPiiCached(options.appendSystemPrompt)) {
    await appendAudit({
      adapterId: opts.adapterId,
      kind: "adapter.error",
      at: Date.now(),
      conversationKey: opts.conversationKey,
      reason: "pii_blocked",
      message: "auto-mode appendSystemPrompt rejected by PII gate",
    })
    throw new PiiGateBlocked("appendSystemPrompt", opts.adapterId, opts.conversationKey)
  }

  // ── 3. Delegate to the existing capture wrapper ────────────────────
  // Forward the FULL capture surface, not just signal/timeout/onPartial:
  // the primary inbound ai-run wires `onPermissionRequest` (IM tool-approval
  // HITL) and `onEvent` (live-activity card). Dropping them here would
  // silently disable both when the inbound turn is routed through this gate.
  const result = await runAndCaptureAssistantReply(sessionId, prompt, options, {
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onPartial: opts.onPartial,
    onPermissionRequest: opts.onPermissionRequest,
    onEvent: opts.onEvent,
    execution: {
      kind: "connector",
      label: `${opts.adapterId} · ${opts.conversationKey}`,
    },
  })
  if (result.usage) {
    const usage = result.usage
    swallowUsageWrite(
      recordConnectorUsage({
        adapterId: opts.adapterId,
        conversationKey: opts.conversationKey,
        usage,
      })
    )
    if (options?.provider) {
      recordProviderOutcome({
        providerId: options.provider,
        ok: true,
        latencyMs: usage.durationMs ?? 0,
        estimatedCostUsd: usage.totalCostUsd,
        modelId: options.model,
        tokensUsed: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadInputTokens,
        cacheCreationTokens: usage.cacheCreationInputTokens,
        sessionId,
        // Provider child span nests under the connector turn's root span
        // (minted by resolveSendOptions with traceSurface "connector").
        traceId: options?.traceId,
        parentSpanId: options?.spanId,
        surface: "connector",
      })
    }
  }
  return result
}

/**
 * Walk every text-bearing block of a `SendContent` value and return true
 * iff every one passes the PII gate. Image / file blocks are skipped —
 * the gate is about leakable text; binary attachments are out of scope
 * (the attachment pipeline encrypts them on disk via attachments.rs).
 *
 * Matches the actual `SendContent` union (`string | SendContentBlock[]`)
 * defined in `lib/claude/types.ts`. SendContentBlock is a discriminated
 * union with `type: "text" | "image" | …` — we only need the `"text"`
 * branch.
 */
export function isPiiSafeSendContent(content: SendContent): boolean {
  if (typeof content === "string") {
    return hasNoLeakingPii(content)
  }
  if (!Array.isArray(content)) return true
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text") {
      if (!hasNoLeakingPii(block.text)) return false
    }
  }
  return true
}

// Re-export the wrapped error for callers that want to discriminate.
export { RunAndCaptureError }
