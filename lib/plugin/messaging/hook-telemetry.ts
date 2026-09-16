/**
 * Plugin-hook failure telemetry.
 *
 * Extracted from `hooks-system.ts` into a leaf module so the interceptor
 * dispatcher can record spans without importing the hook system — which now
 * dispatches THROUGH the interceptor chain and would otherwise close a module
 * cycle. Nothing here knows about hooks or interceptors specifically; it is a
 * bounded error ring plus one span emitter, and both surfaces want the same
 * two so plugin failures land in one place in the Settings panel.
 */

import { emitFinishedSpan } from "@cognia/agent-trace/emitter"

// =============================================================================
// Plugin hook failure telemetry
// =============================================================================

/** A single captured plugin-hook failure, surfaced in the Settings panel. */
export interface PluginHookErrorRecord {
  pluginId: string
  hookName: string
  message: string
  at: number
}

const PLUGIN_HOOK_ERROR_BUFFER_CAP = 256
const pluginHookErrors: PluginHookErrorRecord[] = []

/**
 * Record a plugin-hook failure into a bounded ring buffer. Called from the
 * isolated per-plugin try/catch in `dispatchTeamHook` so one misbehaving
 * plugin's errors are observable without crashing the team runtime.
 */
export function recordPluginHookError(pluginId: string, hookName: string, error: unknown): void {
  pluginHookErrors.push({
    pluginId,
    hookName,
    message: error instanceof Error ? error.message : String(error),
    at: Date.now(),
  })
  if (pluginHookErrors.length > PLUGIN_HOOK_ERROR_BUFFER_CAP) {
    pluginHookErrors.splice(0, pluginHookErrors.length - PLUGIN_HOOK_ERROR_BUFFER_CAP)
  }
}

/** Snapshot of recent plugin-hook failures (newest last). */
export function getRecentPluginHookErrors(): readonly PluginHookErrorRecord[] {
  return [...pluginHookErrors]
}

/** Test-only: clear the captured plugin-hook failure buffer. */
export function __resetPluginHookErrorsForTesting(): void {
  pluginHookErrors.length = 0
}

/** Pull a sessionId out of a hook payload when one is present. Every team
 * payload type carries it under one of `sessionId` / `chatSessionId` /
 * `id` (consensus events). Returns undefined for hooks with no chat scope. */
export function extractSessionIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const p = payload as Record<string, unknown>
  const candidates = [p.sessionId, p.chatSessionId]
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c
  }
  return undefined
}

/**
 * Emit a finished agent-trace span for a single plugin-hook handler run.
 * Caller measures duration themselves (the team-hook dispatcher already
 * runs handlers inside `queueMicrotask`, so start/end pairing here would
 * fight the fire-and-forget model). On failure, also routes through
 * `recordPluginHookError` to keep the legacy ring buffer populated.
 *
 * `sessionId` defaults to `"plugin-runtime"` for hooks that aren't bound to
 * a chat session (lifecycle hooks, theme hooks, etc.). Caller can pass a
 * concrete sessionId when one is available (team / agent / message hooks).
 */
export function recordPluginHookEvent(args: {
  pluginId: string
  hookName: string
  startTime: number
  durationMs: number
  sessionId?: string
  error?: unknown
}): void {
  if (args.error) {
    recordPluginHookError(args.pluginId, args.hookName, args.error)
  }
  try {
    emitFinishedSpan({
      operationName: "execute_tool",
      providerName: "cognia.plugin",
      sessionId: args.sessionId ?? "plugin-runtime",
      surface: "plugin-hook",
      toolName: args.hookName,
      pluginId: args.pluginId,
      startTime: args.startTime,
      durationMs: Math.max(0, args.durationMs),
      errorType: args.error ? "plugin_hook_error" : undefined,
      errorMessage: args.error
        ? args.error instanceof Error
          ? args.error.message
          : String(args.error)
        : undefined,
    })
  } catch {
    // emit is best-effort; never break the host loop
  }
}
