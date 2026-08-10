/**
 * The bridge between a live agent session and the TUI reducer. Pure (no React,
 * no Ink): a turn is driven by `runTurn`, which streams capture events into
 * reducer actions and surfaces permission requests through a `GateController`.
 *
 * Tested directly with a fake session — abort, error, and the deferred-gate
 * round-trip are all covered without mounting Ink.
 */
import { RunAndCaptureError } from "@/lib/claude/run-and-capture"
import type { CapturePermissionDecision, RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { PermissionRequestEvent } from "@cognia/agent-config-types"
import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"

import {
  captureEventFromCanonical,
  createEnvelopeOrderTracker,
} from "@/lib/ai/agent/execution/event-envelope"
import { canonicalEnvelopeToActions, captureEventToActions } from "../state/event-mapper"
import { recordUnknownPart } from "../runtime/render-diagnostics"
import { classifyError } from "../format/error-classify"
import { formatActiveSkillsNotice } from "../runtime/active-skills"
import { formatAttachmentNotice } from "../runtime/attachment-notice"
import type { AttachmentSummary } from "../../agent/session-runner"
import type { CliDbSnapshotError } from "../../db/bootstrap"
import type { PermissionResponder } from "../../agent/permission-gate"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import type { TuiAction } from "../state/types"
import { applyCanonicalTaskEnvelope } from "../../agent/subagent-live-output"

/** The subset of `AgentSession` the turn engine drives. */
export interface TurnSession {
  send(
    prompt: string,
    opts: {
      gate: PermissionResponder
      onAction?: (action: TuiAction) => void
      onEnvelope?: (envelope: AgentEventEnvelope) => void
      onEvent?: (event: CaptureStreamEvent) => void
      onActiveSkills?: (skillIds: string[]) => void
      onAttachments?: (summary: AttachmentSummary) => void
      onTwinNotice?: (message: string) => void
      onDatabaseError?: (error: CliDbSnapshotError) => void
      signal?: AbortSignal
      timeoutMs?: number
    }
  ): Promise<RunAndCaptureResult>
}

export interface GateController {
  /** The `PermissionResponder` handed to `session.send`. */
  responder: PermissionResponder
  /** Resolve the request currently shown to the user. */
  resolve(decision: CapturePermissionDecision): void
  /** The request at the head of the queue (the one the overlay shows), or
   * undefined when nothing is pending. Lets the UI attribute a decision to its
   * tool (e.g. to fire a PermissionDenied hook) before `resolve` pops it. */
  peek(): PermissionRequestEvent | undefined
  /** Whether a request is awaiting a decision. */
  isPending(): boolean
  /**
   * Discard every pending resolver without resolving it. Used after a session
   * error (timeout / sidecar crash) to prevent a stale resolver from being
   * popped by the next turn's permission UI — a stale "allow" on an old
   * request would corrupt the gate queue and hang the new turn.
   */
  reset(): void
}

/**
 * Build a permission gate whose decisions are supplied asynchronously by the UI.
 * `onRequest` fires when the model asks for approval (the UI opens its overlay);
 * the UI later calls `resolve(decision)`.
 *
 * Requests are queued and surfaced ONE AT A TIME: `onRequest` fires only for the
 * request at the HEAD of the queue, and `resolve` re-fires it for the next queued
 * request once the head settles. This matters because a single assistant message
 * can emit several `tool_use` blocks in parallel, so `canUseTool` (and thus this
 * responder) is invoked concurrently for all of them. Firing `onRequest` for
 * every arrival would overwrite the overlay down to the last request, and the UI
 * — which resolves one decision and then closes the overlay — would leave the
 * other resolvers stranded: their `canUseTool` promises never settle, their
 * tool_results are never sent, and the whole turn hangs forever "waiting for API
 * response". Serialising the overlay keeps the displayed request and the resolved
 * resolver in lockstep (FIFO) and guarantees every parallel ask is answered.
 */
/** Optional PreToolUse pre-check: a deny here blocks the tool before the
 * approval overlay is ever shown (settings.json `PreToolUse` hooks). */
export type GatePreCheck = (
  req: PermissionRequestEvent
) => Promise<{ deny: boolean; reason?: string } | undefined>

/** Optional silent auto-approver: when it returns true for a request the gate
 * resolves `allow` immediately, never opening the overlay. Backs the "Allow
 * always" memory so an already-trusted tool stops interrupting mid-session. It
 * runs AFTER the PreToolUse pre-check, so a hook deny always wins. */
export type GateAutoApprove = (req: PermissionRequestEvent) => boolean

export function createGateController(
  onRequest: (req: PermissionRequestEvent) => void,
  preCheck?: GatePreCheck,
  autoApprove?: GateAutoApprove
): GateController {
  const queue: Array<{
    req: PermissionRequestEvent
    resolve: (d: CapturePermissionDecision) => void
  }> = []

  const responder: PermissionResponder = (req) =>
    new Promise<CapturePermissionDecision>((resolve) => {
      const proceed = () => {
        // Silent auto-approve (the live "Allow always" set) skips the overlay.
        if (autoApprove?.(req)) {
          resolve({ decision: "allow" })
          return
        }
        queue.push({ req, resolve })
        // Only open the overlay when this request is the head — queued asks wait
        // their turn and are surfaced by `resolve` as the head settles.
        if (queue.length === 1) onRequest(req)
      }
      if (!preCheck) {
        proceed()
        return
      }
      // Run the PreToolUse hooks first; a deny short-circuits the overlay. A
      // throwing/rejecting pre-check must never block a legitimate tool, so it
      // falls through to the normal approval UI.
      void preCheck(req)
        .then((decision) => {
          if (decision?.deny) {
            resolve({
              decision: "deny",
              message: decision.reason ?? "Blocked by a PreToolUse hook.",
            })
            return
          }
          proceed()
        })
        .catch(() => proceed())
    })

  return {
    responder,
    resolve(decision) {
      const head = queue.shift()
      if (head) head.resolve(decision)
      // Surface the next queued ask (if any) so a batch of parallel tool calls
      // is approved/denied one overlay at a time instead of stranding the rest.
      if (queue.length > 0) onRequest(queue[0].req)
    },
    peek() {
      return queue[0]?.req
    },
    isPending() {
      return queue.length > 0
    },
    reset() {
      queue.length = 0
    },
  }
}

/** Lifecycle-hook sink fired by {@link runTurn}: each capture event + turn end.
 * Optional so the turn engine stays usable without the hook subsystem. */
export interface TurnHookSink {
  onCapture(event: CaptureStreamEvent): void
  onStop(ok: boolean): void
}

export interface RunTurnOptions {
  session: TurnSession
  prompt: string
  dispatch: (action: TuiAction) => void
  gate: PermissionResponder
  signal?: AbortSignal
  timeoutMs?: number
  /** Optional settings.json lifecycle hooks (PostToolUse / Stop / …). */
  hooks?: TurnHookSink
  /** Fired before each tool runs (tool-call events) — drives `/rewind` shadow
   * capture. Synchronous + best-effort; must never throw into the turn. */
  onToolCall?: (toolName: string, input: unknown) => void
  /** Surface the one-line "Active skills (N): …" notice when a turn loads
   * session-enabled skills. Off by default (config `showActiveSkills`) — the
   * popup's ●/○ badges already show what's active, so the per-turn notice is
   * opt-in to keep the transcript quiet. */
  showActiveSkills?: boolean
}

/**
 * Drive one turn: announce the start, stream capture events into reducer
 * actions, then commit the result. Aborts and errors map to the matching
 * terminal action. Never throws — failures become `TURN_ERROR`/`TURN_ABORTED`.
 *
 * Returns `{ ok: false, recoverable }` on error. `recoverable` tells the caller
 * (the session hook) whether the underlying session is still usable: a timeout,
 * idle stall, provider error, send failure or user interrupt all leave the
 * multi-turn session alive WITH its accumulated context, so the caller keeps it
 * and the next message continues the conversation. Only a dead sidecar (or an
 * unknown fault) is non-recoverable — the caller drops the session and respawns.
 * On success the captured `result` (assistant text + usage) rides along so a
 * self-driving caller (`/goal`, `/loop`) can feed it to a turn-driver without a
 * second, non-streaming capture.
 */
export async function runTurn(
  opts: RunTurnOptions
): Promise<{ ok: boolean; result?: RunAndCaptureResult; recoverable?: boolean }> {
  opts.dispatch({ type: "TURN_START", prompt: opts.prompt })
  // An unsafe-snapshot report arrives mid-turn, but ending the turn on it would
  // discard a response the user already earned — the db failure is orthogonal to
  // the reply. Hold it and append a permanent error cell once the turn commits.
  let databaseError: CliDbSnapshotError | null = null
  const envelopeOrder = createEnvelopeOrderTracker()
  try {
    const result = await opts.session.send(opts.prompt, {
      gate: opts.gate,
      onEnvelope: (envelope) => {
        const order = envelopeOrder.observe(envelope)
        if (order.kind === "duplicate") return
        if (order.kind === "gap") {
          opts.dispatch({
            type: "CANONICAL_EVENT_NOTICE",
            eventId: `${envelope.eventId}:gap`,
            level: "warning",
            title: "Event stream gap",
            summary: `Expected sequence ${order.expectedSequence}, received ${order.receivedSequence}`,
          })
        }
        applyCanonicalTaskEnvelope(envelope)
        const actions = canonicalEnvelopeToActions(envelope)
        for (const action of actions) {
          if (
            action.type === "CANONICAL_EVENT_NOTICE" &&
            (action.title === "Unsupported event" || action.title === "Rejected content part")
          ) {
            recordUnknownPart()
          }
          opts.dispatch(action)
          if (action.type === "TOOL_CALL" || action.type === "TOOL_UPDATE") {
            opts.onToolCall?.(action.toolName ?? "", action.input ?? {})
          }
        }
        const legacy = captureEventFromCanonical(envelope.event)
        if (legacy) opts.hooks?.onCapture(legacy)
      },
      onAction: (action) => {
        opts.dispatch(action)
        if (action.type === "TOOL_CALL") opts.onToolCall?.(action.toolName, action.input)
      },
      onEvent: (event) => {
        for (const action of captureEventToActions(event)) opts.dispatch(action)
        opts.hooks?.onCapture(event)
        if (event.type === "tool-call") opts.onToolCall?.(event.toolName, event.input)
      },
      onActiveSkills: (skillIds) => {
        // Off by default — the `@` popup's ●/○ badges already show active skills.
        if (!opts.showActiveSkills) return
        const message = formatActiveSkillsNotice(skillIds)
        if (message) opts.dispatch({ type: "NOTICE", message })
      },
      onAttachments: (summary) => {
        const message = formatAttachmentNotice(summary)
        if (message) opts.dispatch({ type: "NOTICE", message })
      },
      onTwinNotice: (message) => {
        opts.dispatch({ type: "NOTICE", message })
      },
      onDatabaseError: (error) => {
        databaseError = error
      },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    })
    opts.dispatch({ type: "TURN_COMMIT", result })
    // A NOTICE would scroll away; this one must persist — it is the only thing
    // telling the user their data was preserved rather than lost.
    if (databaseError) {
      opts.dispatch({
        type: "TURN_ERROR",
        title: "Database restore failed",
        message: (databaseError as CliDbSnapshotError).message,
      })
    }
    opts.hooks?.onStop(true)
    return { ok: true, result }
  } catch (err) {
    if (opts.signal?.aborted) {
      // User interrupt: the session stays alive so the next message continues
      // with the accumulated context (the sidecar resets its per-turn cancel).
      opts.dispatch({ type: "TURN_ABORTED" })
      opts.hooks?.onStop(false)
      return { ok: false, recoverable: true }
    }
    const code = err instanceof RunAndCaptureError ? err.code : undefined
    const message = (err as Error).message
    // Classify the fault so the error cell carries a remediation hint and the
    // desktop notification gets a short, human title (instead of a raw string).
    const classified = classifyError({ message, code })
    opts.dispatch({
      type: "TURN_ERROR",
      message,
      title: classified.title,
      ...(classified.hint ? { hint: classified.hint } : {}),
      category: classified.category,
    })
    opts.hooks?.onStop(false)
    // Keep the session for faults that leave it usable; drop only when the
    // sidecar process is gone (or the fault is unknown).
    const recoverable =
      code === "session_error" || code === "send_failed" || code === "no_assistant_text"
    return { ok: false, recoverable }
  }
}
