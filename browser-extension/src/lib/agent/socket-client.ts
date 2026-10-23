/**
 * The extension's end of the device socket (ADR-0228 §5).
 *
 * One socket per browser, owned by the service worker: a single-use ticket
 * from `POST /api/auth/socket-ticket`, then `ws://…/ws/browser-companion`, a
 * `hello`, and from then on status hints, drive changes and — for a browser
 * the Owner let agents drive — operation frames answered by the executor.
 *
 * Two MV3 facts shape it. A worker is kept alive by WebSocket *messages*, so
 * the heartbeat is a text frame every 20 seconds, which also keeps the Host's
 * 75-second idle check satisfied. And the worker can be reclaimed whenever no
 * socket is open, so whoever wants the socket — agent mode, a running task,
 * an open panel — calls `start()` again from the next event that wakes it.
 */
import {
  HELLO_VERSION,
  AGENT_PROFILE,
  AgentOperationError,
  parseHostFrame,
  serializeFrame,
  toFailure,
  type AgentOperation,
  type ExtensionFrame,
} from "./protocol"

/** The slice of `WebSocket` the client uses, so tests can drive one. */
export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

const OPEN = 1

export type SocketState =
  | { kind: "stopped" }
  | { kind: "connecting"; attempt: number }
  | { kind: "connected"; connectionId: string; driveAllowed: boolean }
  | { kind: "status-only"; connectionId: string }
  | { kind: "incompatible"; code: "browser_protocol_incompatible" }
  /** Waiting to retry; `code` names a refusal the person can act on, if any. */
  | { kind: "waiting"; retryAt: number; code: string | null }

export interface SocketClientDeps {
  /** A fresh single-use ticket; throws with a `code` the Host gave, when it gave one. */
  issueTicket(): Promise<string>
  socketUrl(ticket: string): string
  createSocket(url: string): SocketLike
  execute(
    operation: AgentOperation,
    args: Record<string, unknown>,
    deadlineMs: number,
    signal: AbortSignal
  ): Promise<unknown>
  canExecute?(): boolean
  extensionVersion: string
  features: string[]
  onStatusHint(): void
  onDrive(allowed: boolean): void
  onState(state: SocketState): void
  now(): number
  random(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export const HEARTBEAT_MS = 20_000
const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
/** A refusal the person must fix in the app: retried, but rarely. */
const REFUSED_RETRY_MS = 5 * 60_000
/** The Host's frame ceiling, less room for the envelope. */
export const MAX_RESULT_BYTES = 16 * 1024 * 1024 - 1024

/**
 * Refusals a retry cannot fix until somebody changes something on the Host —
 * a revoked device, a capability not granted, Browser Access switched off.
 */
const STANDING_REFUSALS = new Set([
  "device_unavailable",
  "token_key_mismatch",
  "socket_capability_required",
  "browser_companion_forbidden",
  "browser_submissions_disabled",
  "origin_mismatch",
])

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code
    return typeof code === "string" && code.length > 0 ? code : null
  }
  return null
}

export function backoffMs(attempt: number, random: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt))
  // ±20% so a Host restart is not met by every browser in the same second.
  return Math.round(ceiling * (0.8 + 0.4 * random))
}

export function createSocketClient(deps: SocketClientDeps) {
  let desired = false
  let socket: SocketLike | null = null
  let generation = 0
  let attempt = 0
  let reconnect: unknown = null
  let heartbeat: unknown = null
  let state: SocketState = { kind: "stopped" }
  const pending = new Map<string, AbortController>()

  function cancelOperations(code = "browser_operation_cancelled") {
    for (const controller of pending.values()) {
      controller.abort(new AgentOperationError(code, "Browser operation authorization ended"))
    }
    pending.clear()
  }

  function incompatible(target: SocketLike) {
    cancelOperations("browser_protocol_incompatible")
    deps.onDrive(false)
    clearHeartbeat()
    socket = null
    setState({ kind: "incompatible", code: "browser_protocol_incompatible" })
    // Browser WebSocket.close only permits 1000 or application codes 3000–4999.
    target.close(4002, "browser_protocol_incompatible")
  }

  function setState(next: SocketState) {
    state = next
    deps.onState(next)
  }

  function clearHeartbeat() {
    if (heartbeat !== null) deps.clearInterval(heartbeat)
    heartbeat = null
  }

  function schedule(delay: number, code: string | null) {
    if (!desired) return
    if (reconnect !== null) deps.clearTimeout(reconnect)
    setState({ kind: "waiting", retryAt: deps.now() + delay, code })
    reconnect = deps.setTimeout(() => {
      reconnect = null
      void connect()
    }, delay)
  }

  function send(target: SocketLike, frame: ExtensionFrame): boolean {
    if (target !== socket || target.readyState !== OPEN) return false
    target.send(serializeFrame(frame))
    return true
  }

  async function answer(
    target: SocketLike,
    id: string,
    operation: AgentOperation,
    args: Record<string, unknown>,
    deadlineMs: number
  ) {
    let frame: ExtensionFrame
    const controller = new AbortController()
    pending.set(id, controller)
    const expiresAt = deps.now() + deadlineMs
    const expire = () =>
      controller.abort(
        new AgentOperationError(
          "browser_operation_timeout",
          "The browser operation deadline expired"
        )
      )
    const timeout = deps.setTimeout(expire, deadlineMs)
    try {
      const value = await deps.execute(operation, args, deadlineMs, controller.signal)
      if (deps.now() >= expiresAt) expire()
      controller.signal.throwIfAborted()
      frame = { t: "result", id, ok: true, value: value ?? null }
      if (serializeFrame(frame).length > MAX_RESULT_BYTES) {
        frame = {
          t: "result",
          id,
          ok: false,
          error: {
            code: "browser_result_too_large",
            message: "the answer is larger than the device socket carries",
          },
        }
      }
    } catch (error) {
      frame = { t: "result", id, ok: false, error: toFailure(error) }
    } finally {
      deps.clearTimeout(timeout)
      if (pending.get(id) === controller) pending.delete(id)
    }
    // A socket replaced while the operation ran is gone; the Host already
    // failed the call when that connection closed.
    send(target, frame)
  }

  function handleMessage(target: SocketLike, data: unknown) {
    if (target !== socket) return
    if (typeof data !== "string") return
    const frame = parseHostFrame(data)
    if (!frame) return
    switch (frame.t) {
      case "welcome":
        if (frame.v !== HELLO_VERSION || state.kind !== "connecting") {
          incompatible(target)
          return
        }
        attempt = 0
        if (frame.agentProfile !== AGENT_PROFILE) {
          setState({ kind: "status-only", connectionId: frame.connectionId })
          deps.onDrive(false)
          deps.onStatusHint()
          return
        }
        setState({
          kind: "connected",
          connectionId: frame.connectionId,
          driveAllowed: frame.driveAllowed,
        })
        deps.onDrive(frame.driveAllowed)
        deps.onStatusHint()
        return
      case "drive":
        if (state.kind !== "connected") return
        if (!frame.allowed) cancelOperations("browser_drive_revoked")
        setState({ ...state, driveAllowed: frame.allowed })
        deps.onDrive(frame.allowed)
        return
      case "status":
        deps.onStatusHint()
        return
      case "heartbeat":
        return
      case "op":
        if (
          state.kind !== "connected" ||
          !state.driveAllowed ||
          deps.canExecute?.() === false ||
          pending.has(frame.id)
        ) {
          send(target, {
            t: "result",
            id: frame.id,
            ok: false,
            error: {
              code:
                state.kind === "status-only"
                  ? "browser_protocol_incompatible"
                  : "browser_drive_forbidden",
              message: "A compatible handshake and current driving permission are required",
            },
          })
          return
        }
        if ((frame.op as string) === "__unknown__") {
          send(target, {
            t: "result",
            id: frame.id,
            ok: false,
            error: {
              code: "browser_operation_unknown",
              message: "this extension does not implement it",
            },
          })
          return
        }
        void answer(target, frame.id, frame.op, frame.args, frame.deadlineMs)
        return
    }
  }

  async function connect(): Promise<void> {
    if (!desired || socket) return
    const mine = ++generation
    setState({ kind: "connecting", attempt })
    let ticket: string
    try {
      ticket = await deps.issueTicket()
    } catch (error) {
      if (mine !== generation || !desired) return
      const code = errorCode(error)
      if (code && STANDING_REFUSALS.has(code)) {
        schedule(REFUSED_RETRY_MS, code)
      } else {
        schedule(backoffMs(attempt++, deps.random()), code)
      }
      return
    }
    if (mine !== generation || !desired) return

    let target: SocketLike
    try {
      target = deps.createSocket(deps.socketUrl(ticket))
    } catch {
      schedule(backoffMs(attempt++, deps.random()), null)
      return
    }
    socket = target
    target.onopen = () => {
      if (target !== socket || !desired) return
      send(target, {
        t: "hello",
        v: HELLO_VERSION,
        extensionVersion: deps.extensionVersion,
        features: deps.features,
      })
      clearHeartbeat()
      heartbeat = deps.setInterval(() => {
        send(target, { t: "heartbeat" })
      }, HEARTBEAT_MS)
    }
    target.onmessage = (event) => handleMessage(target, event.data)
    target.onerror = () => undefined
    target.onclose = (event) => {
      if (socket !== target) return
      socket = null
      cancelOperations("browser_extension_disconnected")
      deps.onDrive(false)
      clearHeartbeat()
      if (event.code === 1002) {
        setState({ kind: "incompatible", code: "browser_protocol_incompatible" })
        return
      }
      if (!desired) {
        setState({ kind: "stopped" })
        return
      }
      // A policy close (1008) means the authorization may have changed —
      // revoked, Browser Access switched off — but the close itself cannot be
      // trusted to be standing: it is also what a Host about to stop used to
      // send. So it reconnects on the normal backoff, and the ticket exchange
      // decides: a standing refusal there waits the long interval.
      schedule(backoffMs(attempt++, deps.random()), null)
    }
  }

  return {
    /** Keep a socket open from now on; a no-op when one is open or pending. */
    start() {
      desired = true
      if (state.kind === "incompatible") return
      if (socket || state.kind === "connecting") return
      if (reconnect !== null) {
        // Something woke the worker for a reason that wants the socket now —
        // a refusal is retried on schedule, anything else at once.
        if (state.kind === "waiting" && state.code) return
        deps.clearTimeout(reconnect)
        reconnect = null
      }
      void connect()
    },
    /** Close the socket and stop retrying. */
    stop() {
      desired = false
      cancelOperations()
      deps.onDrive(false)
      generation++
      if (reconnect !== null) deps.clearTimeout(reconnect)
      reconnect = null
      clearHeartbeat()
      const open = socket
      socket = null
      open?.close(1000, "not needed")
      setState({ kind: "stopped" })
    },
    /** Retry now, whatever the schedule — after a pairing or a grant. */
    retryNow() {
      if (!desired) return
      if (reconnect !== null) deps.clearTimeout(reconnect)
      reconnect = null
      attempt = 0
      if (!socket) void connect()
    },
    state: () => state,
    cancelOperations,
  }
}

export type SocketClient = ReturnType<typeof createSocketClient>

/** `http://127.0.0.1:27891` → `ws://127.0.0.1:27891/ws/browser-companion?ticket=…`. */
export function browserCompanionSocketUrl(baseUrl: string, ticket: string): string {
  const url = new URL("/ws/browser-companion", baseUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("ticket", ticket)
  return url.toString()
}
