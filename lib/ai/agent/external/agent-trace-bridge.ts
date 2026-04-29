/**
 * Agent-Trace Bridge — no-op stub for cognia-next.
 *
 * Cognia ships a full agent-trace observability layer that this manager
 * dispatches lifecycle events to (`onStart`, `onEvent`, `onComplete`,
 * `onError`). cognia-next has not migrated agent-trace yet, so we expose
 * a contract-compatible no-op bridge that swallows every event.
 *
 * Re-implement against `useAgentTraceStore` later if observability is added.
 */

export interface ExternalAgentTraceBridgeOptions {
  sessionId: string
  turnId?: string
  traceId?: string
  spanId?: string
  parentSpanId?: string
  tracestate?: string
  modelId?: string
  agentId: string
  agentName?: string
  protocol?: string
  transport?: string
  acpSessionId?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface ExternalAgentTraceBridge {
  onStart(prompt: unknown): Promise<void>
  onEvent(event: unknown): Promise<void>
  onComplete(result: unknown): Promise<void>
  onError(error: unknown, context?: unknown): Promise<void>
}

export function createExternalAgentTraceBridge(
  _options: ExternalAgentTraceBridgeOptions
): ExternalAgentTraceBridge {
  const noop = async () => undefined
  return {
    onStart: noop,
    onEvent: noop,
    onComplete: noop,
    onError: noop,
  }
}
