/**
 * Run a host-owned external agent from the Composer, with the same contract as
 * running a local one.
 *
 * The chat controller's external branch is written against one call —
 * `executeOnExternalAgent(prompt, { onEvent })` returning an
 * `ExternalAgentResult` — and everything downstream of it (the ADR-0127
 * coalescer, `applyExternalAgentEventToParts`, the approval and elicitation
 * routing, the failure and fallback paths) hangs off that shape. So this
 * module presents exactly that shape over the remote plane instead of adding a
 * second branch. A remote turn is not a different product, and the branch that
 * renders it should not know which side of the wire the agent is on.
 *
 * The two things it must do that the local path gets for free:
 *
 *   - **Subscribe before starting.** The host begins streaming the moment it
 *     accepts, so a subscription opened after the RPC returns would miss the
 *     opening frames.
 *   - **Assemble `finalResponse`.** The local manager accumulates it while it
 *     drives the adapter; here the only evidence is the event stream, so the
 *     text deltas are collected as they pass through.
 */

import type { ExternalAgentEvent, ExternalAgentResult } from "@/types/agent/external-agent"
import type { ExternalAgentConfigStamp } from "@/types/agent/external-agent-config-store"

import {
  cancelRemoteExternalTurn,
  startRemoteExternalTurn,
  subscribeRemoteExternalRun,
} from "./remote-run-client"
import { remoteDecisionId } from "./remote-run-service"

export interface RemoteExecuteOptions {
  /** Which host configuration, at which revision and readiness generation. */
  stamp: ExternalAgentConfigStamp
  /** The chat session the frames are addressed to. */
  chatSessionId: string
  /** Resume a session this chat already established on the host. */
  externalSessionId?: string
  onEvent?: (event: ExternalAgentEvent) => void
  /**
   * A frame arrived out of order. Surfaced so the caller can say the transcript
   * is incomplete rather than render a hole as if nothing were missing.
   */
  onGap?: (expected: number, received: number) => void
  /** Injected in tests. */
  newRunId?: () => string
}

/** The chat-side id for a question this run is blocked on. */
export function remoteApprovalDecisionId(runId: string, responseRequestId: string): string {
  return remoteDecisionId(runId, responseRequestId)
}

/**
 * Text a message/content delta carries, in the two shapes adapters use.
 *
 * Deliberately narrow: anything that is not plainly a text delta is left to
 * `applyExternalAgentEventToParts`, which is the thing that actually renders
 * the turn. This accumulation exists only for the `finalResponse` fallback the
 * controller uses when an agent emitted no text track at all.
 */
function deltaText(event: ExternalAgentEvent): string {
  const candidate = event as { delta?: unknown; text?: unknown }
  if (typeof candidate.text === "string") return candidate.text
  if (typeof candidate.delta === "string") return candidate.delta
  const delta = candidate.delta as { text?: unknown } | undefined
  return typeof delta?.text === "string" ? delta.text : ""
}

const TEXT_EVENTS = new Set(["message_delta", "content_block_delta"])

/**
 * Run one turn on the host and resolve when it ends.
 *
 * Returns `null` only when the host refused to start — the same signal the
 * local path uses for "no external agent available for this request", so the
 * controller's existing refusal handling applies unchanged. A turn that started
 * and then failed resolves with `success: false` and the host's message.
 */
export async function executeOnRemoteHostAgent(
  prompt: string,
  options: RemoteExecuteOptions
): Promise<(ExternalAgentResult & { runId: string }) | null> {
  const runId = options.newRunId?.() ?? `rer_${crypto.randomUUID()}`
  let text = ""
  let externalSessionId = options.externalSessionId ?? ""

  const startedAt = Date.now()
  let settle: (value: (ExternalAgentResult & { runId: string }) | null) => void = () => {}
  const finished = new Promise<(ExternalAgentResult & { runId: string }) | null>((resolve) => {
    settle = resolve
  })

  const stop = subscribeRemoteExternalRun(runId, {
    onEvent: (event) => {
      if (event.type === "session_start" && (event as { sessionId?: string }).sessionId) {
        externalSessionId = (event as { sessionId: string }).sessionId
      }
      if (TEXT_EVENTS.has(event.type)) text += deltaText(event)
      options.onEvent?.(event)
    },
    onGap: options.onGap,
    onTerminal: (terminal, error) => {
      settle({
        runId,
        success: terminal === "completed",
        sessionId: externalSessionId,
        finalResponse: text,
        // Empty rather than reconstructed: the host already rendered the turn
        // into parts through the event stream, and these three fields exist for
        // callers that consume a completed transcript. Rebuilding them from the
        // frames would be a second, divergent renderer.
        messages: [],
        steps: [],
        toolCalls: [],
        duration: Date.now() - startedAt,
        ...(terminal === "completed" ? {} : { error: error ?? terminal }),
      })
    },
  })

  try {
    const started = await startRemoteExternalTurn({
      runId,
      chatSessionId: options.chatSessionId,
      stamp: options.stamp,
      prompt,
      externalSessionId: options.externalSessionId,
    })
    if (!started.started) {
      stop()
      return null
    }
    return await finished
  } finally {
    stop()
  }
}

/**
 * Stop a remote turn.
 *
 * Best-effort and never throws: this runs on an interrupt path where the user
 * has already moved on, and the host's own disconnect handling ends an
 * abandoned run regardless.
 */
export async function interruptRemoteHostAgent(runId: string): Promise<void> {
  try {
    await cancelRemoteExternalTurn(runId)
  } catch {
    // See the docstring.
  }
}
