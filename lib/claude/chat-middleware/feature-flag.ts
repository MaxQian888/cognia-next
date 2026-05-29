/**
 * Chat-middleware execution flag (ADR-0026 §4 §A — locked decision 2026-05-30).
 *
 * Around-style chat middlewares wrap the *entire* send call, so running them
 * sits on the hottest path in the app (every chat turn). To ship the wiring
 * without changing default behaviour, execution is gated behind this flag —
 * DEFAULT OFF. Registration (the bridge) always happens; only the runner
 * call-site consults this flag. Mirrors the `confirmDangerousByDefault`
 * pattern in the permission guard.
 *
 * When off (the default) the send path skips `runChatMiddlewareChain`
 * entirely — zero overhead, identical behaviour to before this feature.
 */

let chatMiddlewareExecutionEnabled = false

/** Whether registered chat middlewares should actually run on send. */
export function isChatMiddlewareExecutionEnabled(): boolean {
  return chatMiddlewareExecutionEnabled
}

/** Toggle middleware execution (settings UI / tests). */
export function setChatMiddlewareExecutionEnabled(enabled: boolean): void {
  chatMiddlewareExecutionEnabled = enabled
}

/** Test-only reset to the shipped default (off). */
export function __resetChatMiddlewareFlagForTesting(): void {
  chatMiddlewareExecutionEnabled = false
}
