/**
 * Cloudflare Worker adapter for the portable probe core
 * (`services/status-server/probe/src/core`).
 *
 * Outbound WebSockets in Workers are an HTTP upgrade through `fetch`
 * (`Upgrade: websocket`, `response.webSocket.accept()`), and with the
 * `global_fetch_strictly_public` flag the request takes the public route to
 * the relay — the same one users take. A runtime failure here is reported by
 * the core as `runner_error` (observer failure), never as a relay outage.
 */

import {
  ProbeTransportError,
  type HttpProbeResponse,
  type ProbeSocket,
  type ProbeTransport,
} from "../../../probe/src/core/index"

function timeoutSignal(outer: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)])
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
}

/** Cloudflare answers origin-side TLS / connect failures with 52x statuses. */
function classifyEdgeStatus(status: number): "tls_error" | "connect_error" | null {
  if (status === 525 || status === 526) return "tls_error"
  if (status === 521 || status === 522 || status === 523 || status === 524) return "connect_error"
  return null
}

class WorkerProbeSocket implements ProbeSocket {
  private readonly inbox: string[] = []
  private readonly waiters: Array<{
    resolve: (frame: string) => void
    reject: (error: unknown) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  private failure: ProbeTransportError | null = null
  private resolveClosed!: () => void
  readonly closed: Promise<void>

  constructor(private readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
    socket.addEventListener("message", (event) => {
      const data = event.data
      const frame = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer)
      const waiter = this.waiters.shift()
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      } else {
        this.inbox.push(frame)
      }
    })
    const fail = () => {
      this.failure ??= new ProbeTransportError("ws_closed", "socket closed")
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(this.failure)
      }
      this.resolveClosed()
    }
    socket.addEventListener("close", fail)
    socket.addEventListener("error", fail)
  }

  send(text: string): void {
    this.socket.send(text)
  }

  next(timeoutMs: number): Promise<string> {
    const queued = this.inbox.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new ProbeTransportError("timeout", "frame timeout"))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  close(): void {
    try {
      this.socket.close(1000, "probe complete")
    } catch {
      // Already closing or closed; nothing left to release.
    }
  }
}

export function createWorkerTransport(): ProbeTransport {
  return {
    async getJson(url, opts): Promise<HttpProbeResponse> {
      let response: Response
      try {
        response = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: timeoutSignal(opts.signal, opts.timeoutMs),
        })
      } catch (error) {
        throw new ProbeTransportError(
          isTimeout(error) ? "timeout" : "connect_error",
          "health request failed"
        )
      }
      const edge = classifyEdgeStatus(response.status)
      if (edge) throw new ProbeTransportError(edge, "edge error", response.status)
      let body: unknown
      let parseError = false
      try {
        body = await response.json()
      } catch {
        parseError = true
      }
      return { status: response.status, body, parseError }
    },

    async openSocket(url, opts): Promise<ProbeSocket> {
      const httpUrl = url.replace(/^wss:/, "https:").replace(/^ws:/, "http:")
      const headers: Record<string, string> = { upgrade: "websocket" }
      if (opts.origin !== null) headers.origin = opts.origin
      let response: Response
      try {
        response = await fetch(httpUrl, {
          headers,
          signal: timeoutSignal(opts.signal, opts.timeoutMs),
        })
      } catch (error) {
        throw new ProbeTransportError(
          isTimeout(error) ? "timeout" : "connect_error",
          "upgrade request failed"
        )
      }
      const socket = response.webSocket
      if (response.status !== 101 || !socket) {
        const edge = classifyEdgeStatus(response.status)
        const reason =
          edge ??
          (opts.origin !== null && response.status === 403 ? "origin_rejected" : "ws_upgrade")
        throw new ProbeTransportError(reason, "upgrade refused", response.status)
      }
      socket.accept()
      return new WorkerProbeSocket(socket)
    },
  }
}
