/**
 * Handler-facing log and progress appends for a Bot run.
 *
 * Extracted from `runBotDelivery` so the same two writes are reachable both
 * from the in-process `BotRunContextV1` (`ctx.log` / `ctx.progress`) and from
 * the `ctx.bots.log` / `ctx.bots.progress` host calls a cross-process handler
 * drives by `runId`. Both are fire-and-forget: a journal append must never
 * fail the handler's work.
 */

import { nanoid } from "nanoid"

import { runEventJournal, semanticRunEvent } from "@/lib/db/execution-runs"
import type { BotLogLevel, BotProgressUpdateV1 } from "@/types/bot/run"

/** Append one handler log line to the run journal. */
export function appendBotRunLog(
  runId: string,
  level: BotLogLevel,
  message: string,
  data: Record<string, unknown> | undefined,
  now: () => number
): void {
  void runEventJournal
    .append(
      runId,
      semanticRunEvent(
        level === "error" ? "step.failed" : "step.progress",
        { message, ...(data ?? {}) },
        { ts: now(), sourceEventId: `log:${nanoid(10)}` }
      )
    )
    .catch(() => undefined)
}

/**
 * Append one handler progress update to the run journal.
 *
 * `| Record<string, unknown>` because the journal also carries structured
 * host notes (`{emitted, matched}` from `ctx.bots.emit`) that are not part of
 * the handler-facing `BotProgressUpdateV1`.
 */
export function appendBotRunProgress(
  runId: string,
  update: BotProgressUpdateV1 | Record<string, unknown>,
  now: () => number
): void {
  void runEventJournal
    .append(runId, semanticRunEvent("step.progress", { ...update }, { ts: now() }))
    .catch(() => undefined)
}
