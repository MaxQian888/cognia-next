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
export function createGateController(
  onRequest: (req: PermissionRequestEvent) => void
): GateController {
  const queue: Array<(d: CapturePermissionDecision) => void> = []

  const responder: PermissionResponder = (req) =>
    new Promise<CapturePermissionDecision>((resolve) => {
      queue.push(resolve)
      onRequest(req)
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

export interface RunTurnOptions {
  session: TurnSession
  prompt: string
  dispatch: (action: TuiAction) => void
  gate: PermissionResponder
  signal?: AbortSignal
  timeoutMs?: number
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
      },
      onActiveSkills: (skillIds) => {
        const message = formatActiveSkillsNotice(skillIds)
        if (message) opts.dispatch({ type: "NOTICE", message })
      },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    })
    opts.dispatch({ type: "TURN_COMMIT", result })
    return { ok: true, result }
  } catch (err) {
    if (opts.signal?.aborted) {
      opts.dispatch({ type: "TURN_ABORTED" })
    } else {
      opts.dispatch({ type: "TURN_ERROR", message: (err as Error).message })
    }
    return { ok: false }
  }
}
