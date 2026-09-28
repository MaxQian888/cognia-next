import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

import type { SessionContext } from "./runtime-types.ts"

export { drainPendingRoundTrips } from "../common/round-trips.ts"
import { drainPendingRoundTrips } from "../common/round-trips.ts"

export function createAnthropicSession({
  q,
  inputStream,
  doomGuard,
  sessionId,
  emit,
  ledgerGate,
  pendingApprovals,
  pendingPluginToolCalls,
  pendingPluginHookCalls,
  sendOptions,
}: SessionContext) {
  let steerCloseTimer: ReturnType<typeof setTimeout> | undefined
  const closeInput = () => {
    if (steerCloseTimer) clearTimeout(steerCloseTimer)
    steerCloseTimer = undefined
    inputStream.close()
  }
  // Prompts pushed into this query that the SDK has not answered with a
  // `result` frame yet. The stream loop ends the turn when this reaches zero,
  // which is what lets a STEER extend the turn: `routeSteer` pushes a second
  // user message into the live query, and ending on the first `result` would
  // close the input before the steered leg ever ran.
  const state = { outstandingPrompts: 0 }
  const session = {
    _ended: false,
    q,
    pushUserMessage: (
      content: SDKUserMessage["message"]["content"],
      priority?: SDKUserMessage["priority"]
    ) => {
      // Per-turn doom-guard reset (parity with the ai-sdk path, which builds a
      // fresh guard each turn). Without this, a legitimate identical call made
      // once per turn — e.g. reading the same config at each turn's start —
      // crosses the threshold on the 3rd TURN of a multi-turn session and
      // forces approval prompts forever after.
      doomGuard.reset()
      const accepted = inputStream.push({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: sessionId,
        ...(priority ? { priority } : {}),
      })
      // Only an ACCEPTED push earns a `result`; a rejected one (closed input)
      // would leave the counter permanently above zero and hang the turn.
      if (accepted !== false) state.outstandingPrompts += 1
      return accepted
    },
    // Manual compaction: the Agent SDK owns compaction and intercepts a
    // `/compact [focus]` user turn (emitting its own `compact_boundary`). We
    // unify the manual entry point by pushing that turn — no bespoke summary.
    requestCompact: (focus?: string) => {
      const trimmed = typeof focus === "string" ? focus.trim() : ""
      session.pushUserMessage(trimmed ? `/compact ${trimmed}` : "/compact")
    },
    closeInput,
    // A streaming query that receives a second user message remains open for
    // more input after emitting that response. Keep a short burst window for
    // adjacent steers, then close THIS query's input so its result can settle;
    // later messages fall back to the durable next-turn lane.
    scheduleSteerInputClose: () => {
      if (steerCloseTimer) clearTimeout(steerCloseTimer)
      steerCloseTimer = setTimeout(closeInput, 250)
    },
    // Immediate teardown drain for the host's interrupt/close handlers. The SDK
    // `q.interrupt()` doesn't settle `pendingPluginToolCalls`, so without this a
    // closed/crashed renderer would keep the turn alive until the per-call
    // timeout. See `drainPendingRoundTrips`.
    /** Router + Fusion: resolve a pending envelope check (`call_reserve_decision`). */
    resolveCallReserve: (message: unknown) => ledgerGate.resolveDecision(message),
    drainPending: (reason?: string) =>
      drainPendingRoundTrips(
        { pendingApprovals, pendingPluginToolCalls, pendingPluginHookCalls, ledgerGate },
        reason,
        (requestId) =>
          emit({
            type: "permission_interrupted",
            sessionId,
            requestId,
            reason: typeof reason === "string" && reason !== "" ? reason : "interrupted",
          })
      ),
    pendingApprovals,
    pendingPluginToolCalls,
    pendingPluginHookCalls,
    sendOptions,
  }

  return { session, state }
}
