import type { HostSession, Emit, Log } from "./sessions/types.ts"
import type { HostCommand } from "../shared/wire/inbound.ts"
import { errorMessage } from "../shared/errors.ts"
import { routeClose } from "./sessions/lifecycle.ts"
import { commandSupported, capabilityError } from "../runtimes/registry.ts"

/**
 * ADR-0090 Phase 3 — capability gating. A command the session's frozen
 * runtime adapter cannot serve returns a TYPED `capability_error`, never a
 * silent no-op. Legacy (spec-less) sessions are never blocked. Returns true
 * when the message was blocked. Exported for the co-located test.
 */
export function blockUnsupportedCommand(
  sessionsMap: Map<string, HostSession>,
  msg: HostCommand,
  emitFn: Emit
) {
  if (!msg?.sessionId) return false
  const session = sessionsMap.get(msg.sessionId)
  const adapterId = session?.runtimeAdapterId
  if (adapterId && !commandSupported(adapterId, msg.type)) {
    emitFn(capabilityError(msg.sessionId, msg.type, msg.type))
    return true
  }
  return false
}

/**
 * Dispatch one inbound command to its handler WITHOUT letting a throw escape
 * the stdin loop.
 *
 * Before this existed, `handleSend` ran bare inside `rl.on("line")` and the
 * async handlers were fire-and-forget promises. Either kind of failure was an
 * uncaught exception / unhandled rejection, which exits Node: every live
 * session died, Rust charged the recovery budget, and three such deaths held
 * the whole sidecar back. The trigger did not have to be exotic: `dispatch()`
 * throws by design for `runtimeAdapter: "external"`, and a HostState
 * `message.enqueue` from a phone could stamp that adapter from the host's
 * composer pick.
 *
 * Policy: a failed `send` ends THAT session with a `session_ended { error }`
 * (the renderer's terminal frame, so the turn settles instead of hanging), any
 * other failed command is logged, and the process keeps serving everyone else.
 * Exported for the co-located test.
 */
export function routeCommand(
  msg: HostCommand,
  {
    emit: emitFn,
    log: logFn,
    sessions: sessionsMap,
    handlers,
  }: {
    emit: Emit
    log: Log
    sessions: Map<string, HostSession>
    handlers: Record<string, ((message: HostCommand) => unknown) | undefined>
  }
) {
  const handler = handlers[msg?.type]
  if (!handler) {
    logFn("warn", `unknown command type: ${msg?.type}`)
    return
  }
  const fail = (err: unknown) => {
    const reason = errorMessage(err)
    logFn("error", `${msg.type} failed: ${reason}`)
    if (msg.type !== "send" || !msg.sessionId) return
    // The session may be half-started (dispatch threw) or wedged (push threw):
    // retire it so the next send starts clean rather than pushing into a
    // loop that never came up.
    routeClose(sessionsMap, { sessionId: msg.sessionId }, logFn)
    emitFn({
      type: "session_ended",
      sessionId: msg.sessionId,
      ...(msg.options?.turnId ? { turnId: msg.options.turnId } : {}),
      error: `send failed: ${reason}`,
    })
  }
  try {
    const result = handler(msg)
    if (
      result &&
      typeof result === "object" &&
      "then" in result &&
      typeof result.then === "function"
    )
      result.then(undefined, fail)
  } catch (err) {
    fail(err)
  }
}
