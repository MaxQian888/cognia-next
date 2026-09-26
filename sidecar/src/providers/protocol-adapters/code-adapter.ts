// Code-level protocol adapter (P2-E): for upstreams the declarative
// `openai-compatible-variant` spec can't express, the plugin ships REAL code
// that runs in the RENDERER (where plugin code legitimately executes — same
// as routing strategies / deployment filters). The sidecar never loads the
// plugin code; instead its `start()` round-trips through the host over stdio:
//
//   sidecar → host:     { type: "protocol_adapter_exec", sessionId, execId,
//                         pluginId, adapterId, request }
//   host → renderer:    runs the plugin's executor (transform + fetch + parse)
//   renderer → host → sidecar (streamed):
//                       { type: "protocol_adapter_chunk", sessionId, execId, chunk }
//                       { type: "protocol_adapter_done",  sessionId, execId, usage? }
//                       { type: "protocol_adapter_error", sessionId, execId, error }
//
// Each `chunk` is an AI-SDK-fullStream-shaped event, so `event-adapter.mjs`
// stays the single normalizer no matter which adapter served the turn.

import { randomUUID } from "node:crypto"
import { makeInputStream } from "../../shared/input-stream.ts"
import type { CodeAdapterSpec, ProtocolAdapter } from "./types.ts"

/** One code adapter execution; the host's `protocol_adapter_*` handlers drive it. */
export interface ProtocolExecChannel {
  fullStream: AsyncIterable<unknown>
  /** Resolves with the reported usage, or null when the run did not finish. */
  usage: Promise<unknown>
  push(chunk: unknown): boolean
  finish(usage?: unknown): void
  fail(message: unknown): void
  cancel(reason?: string): void
}

/** Runtime deps a `kind: "code"` adapter needs for its renderer round-trip. */
export interface CodeAdapterBridge {
  emit: (frame: Record<string, unknown>) => void
  sessionId: string
  pendingProtocolExecs: Map<string, ProtocolExecChannel>
  makeExecId?: () => string
  onCancel?: (execId: string, reason?: string) => void
  remoteExecutionContext?: unknown
}

/**
 * Register a pending execution channel for an execId. The host's
 * `protocol_adapter_*` handlers drive it via the returned controls; the
 * adapter consumes `fullStream` / `usage`.
 */
export function registerProtocolExec(
  pending: Map<string, ProtocolExecChannel>,
  execId: string,
  options: { onCancel?: ((execId: string, reason?: string) => void) | undefined } = {}
): ProtocolExecChannel {
  const input = makeInputStream<unknown>()
  let resolveUsage!: (value: unknown) => void
  const usage = new Promise<unknown>((resolve) => {
    resolveUsage = resolve
  })
  let settledUsage = false
  const settleUsage = (value: unknown) => {
    if (settledUsage) return
    settledUsage = true
    resolveUsage(value ?? null)
  }

  const channel: ProtocolExecChannel = {
    fullStream: input.iterable,
    usage,
    // Host-driven controls:
    push: (chunk) => input.push(chunk),
    finish: (usageValue) => {
      settleUsage(usageValue ?? null)
      input.close()
    },
    fail: (message) => {
      // Surface as a fullStream error event the dispatcher turns into
      // session_ended.error, then close so the for-await loop exits.
      input.push({ type: "error", error: message })
      settleUsage(null)
      input.close()
    },
    cancel: (reason) => {
      settleUsage(null)
      input.close()
      options.onCancel?.(execId, reason)
    },
  }
  pending.set(execId, channel)
  return channel
}

export function makeCodeAdapter(spec: CodeAdapterSpec, bridge: CodeAdapterBridge): ProtocolAdapter {
  return {
    id: `code:${spec.pluginId}:${spec.adapterId}`,
    async start(req) {
      const execId = (bridge.makeExecId ?? randomUUID)()
      const channel = registerProtocolExec(bridge.pendingProtocolExecs, execId, {
        onCancel: bridge.onCancel,
      })
      bridge.emit({
        type: "protocol_adapter_exec",
        sessionId: bridge.sessionId,
        execId,
        pluginId: spec.pluginId,
        adapterId: spec.adapterId,
        request: {
          model: req.model,
          messages: req.messages,
          modelParams: req.modelParams ?? {},
          credentials: req.credentials ?? {},
          ...(req.reasoning ? { reasoning: req.reasoning } : {}),
          ...(typeof req.maxSteps === "number" ? { maxSteps: req.maxSteps } : {}),
        },
        ...(bridge.remoteExecutionContext
          ? { remoteExecutionContext: bridge.remoteExecutionContext }
          : {}),
      })
      return { fullStream: channel.fullStream, usage: channel.usage, response: null }
    },
  }
}
