/**
 * What a Bot handler receives, and the durable primitives it may use.
 *
 * ## The one rule that shapes all of it
 *
 * A handler is re-entered FROM THE TOP after a crash, a Host handover, or a
 * resumed wait. Nothing in this context assumes the process that started the
 * run is the process that finishes it. Work that must not repeat goes inside
 * `step.run`, which memoizes on the run's own event journal, so a re-entry
 * replays completed steps from the log instead of doing them again.
 *
 * ## Why the host contract is three plain calls
 *
 * The Python runtime refuses any API method that takes a callback, because
 * neither the callback nor its disposer survives the stdio boundary
 * (ADR-0145). So the host side of a step is `stepBegin` / `stepComplete` /
 * `stepFail`, all of which take and return plain values, and each SDK wraps
 * them in whatever reads naturally for its language. TypeScript gets
 * `step.run(name, fn)`. Python gets an async context manager. Both drive the
 * same three calls, so the two languages cannot drift.
 */

import type { BotEventEnvelopeV1 } from "./event"

/** Severity for a handler's own log lines. Mirrors the run journal's levels. */
export type BotLogLevel = "debug" | "info" | "warn" | "error"

/**
 * A decision the handler needs from a human before it may continue.
 *
 * This does NOT replace the Integration action broker's own approval. Every
 * brokered write is already gated there. `waitForApproval` is for the decision
 * the broker cannot see, most often "here is the diff I intend to push".
 */
export interface BotApprovalRequestV1 {
  title: string
  message?: string
  /**
   * Structured detail rendered on the shared decision surface. Untrusted
   * content belongs here, never in `title`, so it is displayed as data.
   */
  detail?: Record<string, unknown>
  /**
   * What the handler believes this costs if approved. Fed to the ceremony
   * resolver, which may demand MORE than this and never less.
   */
  risk?: "low" | "medium" | "high"
  /** How long the decision stays answerable. The host clamps it. */
  timeoutMs?: number
}

export interface BotApprovalDecisionV1 {
  outcome: "approved" | "denied" | "expired" | "cancelled"
  decidedAt: number
  /**
   * Who answered. Absent for `expired`, because nobody did, which is why an
   * expiry must never be treated as a quiet approval.
   */
  decidedBy?: { principalId?: string; displayName?: string }
}

export interface BotWaitForEventInput {
  /** Correlation key an inbound envelope must carry to wake this run. */
  key: string
  /** Give up after this long. The host clamps it against the run's budget. */
  timeoutMs: number
}

export interface BotStepApiV1 {
  /**
   * Run `fn` once per run, ever. On re-entry the memoized value is returned
   * without calling `fn`.
   *
   * `name` is the memoization key, so it must be stable across re-entries and
   * unique within the run. A name built from loop data needs the loop index in
   * it, or the second iteration replays the first one's output.
   */
  run<T>(name: string, fn: () => Promise<T> | T): Promise<T>

  /**
   * Park the run until a human answers. The run's status becomes `waiting` and
   * the request appears wherever pending decisions appear, so it survives a
   * restart with its original deadline intact.
   */
  waitForApproval(name: string, request: BotApprovalRequestV1): Promise<BotApprovalDecisionV1>

  /**
   * Park the run until a matching event arrives, or the timeout elapses.
   * Resolves to `null` on timeout rather than throwing, because "it never came"
   * is an ordinary branch for a Bot that is watching something.
   */
  waitForEvent(name: string, input: BotWaitForEventInput): Promise<BotEventEnvelopeV1 | null>
}

/** Progress a handler reports, projected onto the run's event journal. */
export interface BotProgressUpdateV1 {
  /** 0 to 1. Omit when the handler genuinely does not know. */
  fraction?: number
  message?: string
}

export interface BotRunContextV1 {
  runId: string
  /** The installation this run belongs to, which owns config and credentials. */
  installationId: string
  /** The definition id, namespaced by owning plugin for a contributed Bot. */
  botId: string
  /** What started this run. */
  event: BotEventEnvelopeV1
  /**
   * Resolved per-installation configuration, already validated against the
   * definition's `configSchema`.
   */
  config: Record<string, unknown>
  /**
   * Aborted when the run is cancelled, the budget is spent, or the Host is
   * handing the run over. A handler that ignores it will be killed instead.
   */
  signal: AbortSignal
  step: BotStepApiV1
  log(level: BotLogLevel, message: string, data?: Record<string, unknown>): void
  progress(update: BotProgressUpdateV1): void
}

/**
 * The serialisable half of {@link BotRunContextV1}.
 *
 * A handler running in another process cannot be handed `step`, `signal`,
 * `log` or `progress`, because none of them survives the stdio boundary. It is
 * handed this instead, and reaches the rest through `ctx.bots.*` host calls
 * keyed by `runId`.
 *
 * Cancellation crosses the same way: once a run is cancelled, the next
 * `stepBegin`, `waitForApproval` or `waitForEvent` rejects. A cross-process
 * handler therefore notices cancellation at its next step boundary, which is
 * the only place it could safely notice one anyway.
 */
export interface BotRunSnapshotV1 {
  runId: string
  installationId: string
  botId: string
  event: BotEventEnvelopeV1
  config: Record<string, unknown>
}

export interface BotHandlerResultV1 {
  /** One line for the run list. Plain text. */
  summary?: string
  /** Structured result, kept on the run for later steps and for replay. */
  output?: unknown
}

/**
 * A Bot's durable handler.
 *
 * Returning normally completes the run. Throwing fails it, and the failure is
 * retried according to the delivery's retry policy, which means the handler
 * runs again from the top with its completed steps already memoized.
 */
export type BotHandlerV1 = (
  ctx: BotRunContextV1
) => Promise<BotHandlerResultV1 | void> | BotHandlerResultV1 | void
