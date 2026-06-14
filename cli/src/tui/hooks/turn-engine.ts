/**
 * The bridge between a live agent session and the TUI reducer. Pure (no React,
 * no Ink): a turn is driven by `runTurn`, which streams capture events into
 * reducer actions and surfaces permission requests through a `GateController`.
 *
 * Tested directly with a fake session — abort, error, and the deferred-gate
 * round-trip are all covered without mounting Ink.
 */
import type { CapturePermissionDecision, RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { PermissionRequestEvent } from "@/lib/claude/types"

import { captureEventToActions } from "../state/event-mapper"
import { formatActiveSkillsNotice } from "../runtime/active-skills"
import { formatAttachmentNotice } from "../runtime/attachment-notice"
import type { AttachmentSummary } from "../../agent/session-runner"
import type { PermissionResponder } from "../../agent/permission-gate"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import type { TuiAction } from "../state/types"

/** The subset of `AgentSession` the turn engine drives. */
export interface TurnSession {
  send(
    prompt: string,
    opts: {
      gate: PermissionResponder
      onEvent?: (event: CaptureStreamEvent) => void
      onActiveSkills?: (skillIds: string[]) => void
      onAttachments?: (summary: AttachmentSummary) => void
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
 * the UI later calls `resolve(decision)`. Requests are queued so a second ask
 * never drops the first (capture is serial per turn, but this stays correct if
 * that ever changes).
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
  const queue: Array<(d: CapturePermissionDecision) => void> = []

  const responder: PermissionResponder = (req) =>
    new Promise<CapturePermissionDecision>((resolve) => {
      const proceed = () => {
        // Silent auto-approve (the live "Allow always" set) skips the overlay.
        if (autoApprove?.(req)) {
          resolve({ decision: "allow" })
          return
        }
        queue.push(resolve)
        onRequest(req)
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
      const next = queue.shift()
      if (next) next(decision)
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
}

/**
 * Drive one turn: announce the start, stream capture events into reducer
 * actions, then commit the result. Aborts and errors map to the matching
 * terminal action. Never throws — failures become `TURN_ERROR`/`TURN_ABORTED`.
 *
 * Returns `{ ok: false }` on error so the caller (the session hook) can clean
 * up the now-stale session (renderer-side timeout / send-failed / sidecar crash)
 * instead of reusing it and cascading into a permanent hang. On success the
 * captured `result` (assistant text + usage) rides along so a self-driving
 * caller (`/goal`, `/loop`) can feed it to a turn-driver without a second,
 * non-streaming capture.
 */
export async function runTurn(
  opts: RunTurnOptions
): Promise<{ ok: boolean; result?: RunAndCaptureResult }> {
  opts.dispatch({ type: "TURN_START", prompt: opts.prompt })
  try {
    const result = await opts.session.send(opts.prompt, {
      gate: opts.gate,
      onEvent: (event) => {
        for (const action of captureEventToActions(event)) opts.dispatch(action)
        opts.hooks?.onCapture(event)
        if (event.type === "tool-call") opts.onToolCall?.(event.toolName, event.input)
      },
      onActiveSkills: (skillIds) => {
        const message = formatActiveSkillsNotice(skillIds)
        if (message) opts.dispatch({ type: "NOTICE", message })
      },
      onAttachments: (summary) => {
        const message = formatAttachmentNotice(summary)
        if (message) opts.dispatch({ type: "NOTICE", message })
      },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    })
    opts.dispatch({ type: "TURN_COMMIT", result })
    opts.hooks?.onStop(true)
    return { ok: true, result }
  } catch (err) {
    if (opts.signal?.aborted) {
      opts.dispatch({ type: "TURN_ABORTED" })
    } else {
      opts.dispatch({ type: "TURN_ERROR", message: (err as Error).message })
    }
    opts.hooks?.onStop(false)
    return { ok: false }
  }
}
