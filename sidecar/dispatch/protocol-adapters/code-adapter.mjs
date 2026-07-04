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
import { makeInputStream } from "../input-stream.mjs"

/**
 * Register a pending execution channel for an execId. The host's
 * `protocol_adapter_*` handlers drive it via the returned controls; the
 * adapter consumes `fullStream` / `usage`.
 *
 * @param {Map<string, any>} pending
 * @param {string} execId
 * @param {{ onCancel?: (execId: string, reason?: string) => void }} [options]
 */
export function registerProtocolExec(pending, execId, options = {}) {
  const input = makeInputStream()
  let resolveUsage
  const usage = new Promise((resolve) => {
    resolveUsage = resolve
  })
  let settledUsage = false
  const settleUsage = (value) => {
    if (settledUsage) return
    settledUsage = true
    resolveUsage(value ?? null)
  }

  const channel = {
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

/**
 * @param {{ kind: "code", pluginId: string, adapterId: string }} spec
 * @param {{
 *   emit: (msg: any) => void,
 *   sessionId: string,
 *   pendingProtocolExecs: Map<string, any>,
 *   makeExecId?: () => string,
 * }} bridge
 * @returns {import("./types.mjs").ProtocolAdapter}
 */
export function makeCodeAdapter(spec, bridge) {
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
      })
      return { fullStream: channel.fullStream, usage: channel.usage, response: null }
    },
  }
}
