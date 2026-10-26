/**
 * The plugin contract's share of `lib/claude/run-and-capture.ts`, which re-exports these.
 */

import type { UsageInfo } from "./adapter"

/**
 * Typed incremental events surfaced from the SAME assistant-block parse loop
 * the capture already walks. Consumed by the plugin Agent SDK's `runStreamed`
 * so it doesn't have to re-parse `onClaudeMessage`. Best-effort: a throwing
 * callback is swallowed and never affects capture.
 */
export type CaptureStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "thinking-delta"; delta: string }
  | { type: "commentary-delta"; delta: string; messageId?: string; done?: boolean }
  | { type: "tool-summary"; summary: string; toolCallIds: string[] }
  | {
      type: "tool-call"
      toolName: string
      input: Record<string, unknown>
      /** The originating `tool_use` block id, when the SDK supplies one. A stable
       * per-call identity so consumers can pair a later `tool-result` exactly and
       * distinguish two concurrent calls with identical name+input. */
      id?: string
    }
  | {
      type: "tool-result"
      toolName: string
      /** Tool arguments correlated from the originating `tool_use` block, when known. */
      input?: Record<string, unknown>
      /** The `tool_use_id` this result answers, when known (see `tool-call.id`). */
      id?: string
      result: unknown
      isError?: boolean
    }
  /**
   * Token/cost usage for the turn, surfaced from the SDK `result` message as it
   * streams. The native Anthropic sidecar emits `session_ended` WITHOUT a
   * `result` payload, so consumers that want live usage (the CLI TUI footer)
   * cannot rely on the resolved `RunAndCaptureResult.usage` alone — this event
   * delivers it from the in-stream result message instead.
   */
  | {
      type: "usage"
      usage: UsageInfo
      /**
       * True for a MID-run per-assistant-message snapshot (not cumulative);
       * consumers that want a live figure SUM these and let the final
       * authoritative (non-partial) `result`-message usage replace the sum.
       * Absent/false = the end-of-turn authoritative usage.
       */
      partial?: boolean
    }
  /**
   * A context-compaction boundary crossed mid-stream. Both dispatch paths emit
   * the same `system` / `compact_boundary` message — the generic AI-SDK path
   * (`sidecar/dispatch/ai-sdk.mjs`) when it summarizes older turns, and the
   * Anthropic Agent SDK when it auto/manually compacts. Surfaced here so the CLI
   * TUI can mark the boundary inline (the desktop renders it from the raw
   * `claude://message` event independently). `trigger` is `"manual"` for a
   * user-requested `/compact` and `"auto"` for the threshold-driven one.
   */
  | { type: "compact"; trigger: "manual" | "auto"; preTokens: number; postTokens: number }
  /**
   * The provider leg failed transiently and is being retried, or the retry
   * budget is spent. Mirrors the canonical `retry` event so the projection is
   * lossless in both directions.
   *
   * This is the only signal a caller gets during the Agent SDK's own retry
   * ladder, whose backoff reaches ~40s per step: without it a turn against an
   * unreachable endpoint streamed NOTHING for minutes and then failed with a
   * stall message that named no cause, because the ladder's `api_retry` frames
   * had no capture projection and the headless stream carries only this union.
   */
  | {
      type: "retry"
      phase: "scheduled" | "started" | "succeeded" | "exhausted"
      /** 1-based; equals `maxRetries` on the last `scheduled`. */
      attempt: number
      maxRetries: number
      /** Failure code that triggered the retry (`api_retry` from the SDK). */
      code: string
      /** Backoff about to be applied, post-jitter. */
      delayMs?: number
      /** HTTP status behind the failure, when the runtime reported one. */
      status?: number
      message?: string
    }
