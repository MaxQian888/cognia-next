import type { PumpContext } from "./runtime-types.ts"

import { PLUGIN_TOOLS_SERVER_NAME } from "../../policy/tool-catalog/names.ts"

import { restorePluginToolNamesInSdkMessage } from "../../policy/tool-catalog/plugin-aliases.ts"

import { extractHttpErrorMeta } from "../../providers/http-error-meta.ts"
import { sessionEndedFromResult } from "./result-terminal.ts"
import { createProviderStreamLogger } from "../../providers/stream-log.ts"

export function startAnthropicPump({
  sessionId,
  sendOptions,
  emit,
  log,
  q,
  mcpAutoReconnect,
  pluginToolNameAliases,
  session,
  state,
  mcpStderrSink,
  toolSession,
}: PumpContext) {
  const closeInput = session.closeInput
  // Pipe SDK events to the parent. Captures the SDK-issued session id on the
  // first event that carries one (powers resume continuity).
  let sdkSessionIdSeen = false
  // Separates "the provider never answered" from "the stream broke mid-flight"
  // when a turn stalls — see `../src/providers/stream-log.ts`.
  const streamLog = createProviderStreamLogger({ sessionId, turnId: sendOptions.turnId, log })
  // `session_ended` is emitted exactly once per turn, from whichever of the
  // three exits below is reached first (the `result` frame, the iterator
  // draining, or a throw).
  let turnEnded = false
  const endTurn = (event: Record<string, unknown>) => {
    if (turnEnded) return
    turnEnded = true
    emit(event)
  }
  void (async () => {
    try {
      for await (const evt of q) {
        streamLog.onEvent()
        if (!sdkSessionIdSeen && evt && typeof evt.session_id === "string") {
          sdkSessionIdSeen = true
          emit({
            type: "sdk_session_id",
            sessionId,
            sdkSessionId: evt.session_id,
          })
        }
        mcpAutoReconnect.onEvent(evt)
        emit({
          type: "event",
          sessionId,
          event: restorePluginToolNamesInSdkMessage(
            pluginToolNameAliases,
            PLUGIN_TOOLS_SERVER_NAME,
            evt
          ),
        })
        // THE turn boundary. `query()` is driven by a streaming input iterable,
        // so the SDK keeps the query open for another prompt after the `result`
        // frame and this `for await` does not end on its own — it ends when the
        // input stream closes, which for this rail only happens at session
        // teardown. Waiting for that meant `session_ended` never fired per
        // turn, and `run-and-capture` (CLI, connectors, goal runner) completes
        // on nothing else: every turn ran to its wall-clock deadline, and an
        // upstream failure carried on this frame — a 404 from a mistyped
        // `ANTHROPIC_BASE_URL` — never reached the caller at all.
        //
        // The desktop adapter has always treated `result` as the end of the
        // turn (`turnComplete: true` in `lib/claude/adapter.ts`); this makes
        // the sidecar say the same thing to everyone else.
        if (evt?.type === "result") {
          state.outstandingPrompts -= 1
          // A steer pushed a second prompt into this same query; its `result`
          // is still to come, so the turn is not over.
          if (state.outstandingPrompts > 0) continue
          streamLog.onEnd()
          endTurn(sessionEndedFromResult(sessionId, evt))
          // Every prompt has been answered. Context is rebuilt next turn via
          // SDK `resume` (see `restartReason` in agent-host.mjs, which retires
          // an Anthropic session on every `session_ended`), so close the input
          // and let the subprocess exit instead of idling until teardown.
          closeInput()
          break
        }
      }
      // Reached when the iterator drained without a `result` frame (input
      // closed, or the query was torn down). Already-ended turns skip it.
      if (!turnEnded) {
        streamLog.onEnd()
        endTurn({ type: "session_ended", sessionId })
      }
    } catch (err) {
      streamLog.onError(err)
      endTurn({
        type: "session_ended",
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        // Forward the real HTTP status + Retry-After so the renderer classifies
        // the failure and times the breaker cooldown off authoritative data
        // instead of string-matching the message.
        ...extractHttpErrorMeta(err),
      })
    } finally {
      session._ended = true
      // Flush any trailing partial stderr line so the last unterminated MCP log
      // isn't dropped at session end.
      mcpStderrSink.end()
      // Close the per-session LSP servers and code-graph store + file watcher.
      toolSession.disposeResolvers()

      // Kill any background shells the agent left running this session.
      void toolSession.disposeProcesses()
    }
  })()
}
