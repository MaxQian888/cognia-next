/**
 * Node `ProbeTransport`: `fetch` for HTTP, the `ws` package for WebSockets.
 *
 * Why `ws` rather than Node's global (undici) WebSocket: undici does accept
 * an `Origin` header through its non-standard `headers` init, but on a
 * refused upgrade it only fires a bare `error` event — no HTTP status and no
 * system error code. The probe must tell a 403 Origin refusal from any other
 * upgrade failure and DNS from TLS from connect errors, which `ws` exposes
 * (`unexpected-response` with the response, `error.code`). Verified locally
 * against an http upgrade server returning 403 (see transport.test.ts).
 */

import WebSocket from "ws"

import {
  ProbeTransportError,
  type HttpProbeResponse,
  type ProbeSocket,
  type ProbeTransport,
} from "../core/types"
import { classifyNetworkError, getText } from "./http"

export { classifyNetworkError }

/** Health bodies are tiny; refuse to buffer anything absurd. */
const MAX_HTTP_BODY_BYTES = 64 * 1024
/** Largest frame accepted from the relay (its data-lane cap is 64 KiB). */
const MAX_FRAME_BYTES = 256 * 1024

export interface NodeTransportOptions {
  userAgent?: string
  /** Terminate a socket whose close handshake has not finished by then. */
  forceCloseAfterMs?: number
}

export function createNodeTransport(options: NodeTransportOptions = {}): ProbeTransport {
  const userAgent = options.userAgent ?? "cognia-status-probe"
  const forceCloseAfterMs = options.forceCloseAfterMs ?? 2_000

  return {
    async getJson(url, { timeoutMs, signal }): Promise<HttpProbeResponse> {
      const response = await getText(url, {
        timeoutMs,
        signal,
        maxBytes: MAX_HTTP_BODY_BYTES,
        accept: "application/json",
        userAgent,
      })
      if (response.text === null)
        return { status: response.status, body: undefined, parseError: true }
      if (response.text.trim() === "")
        return { status: response.status, body: undefined, parseError: false }
      try {
        return {
          status: response.status,
          body: JSON.parse(response.text) as unknown,
          parseError: false,
        }
      } catch {
        return { status: response.status, body: undefined, parseError: true }
      }
    },

    openSocket(url, { origin, timeoutMs, signal }): Promise<ProbeSocket> {
      return new Promise<ProbeSocket>((resolve, reject) => {
        if (signal.aborted) {
          reject(new ProbeTransportError("runner_error", "aborted"))
          return
        }
        const headers: Record<string, string> = { "user-agent": userAgent }
        // Native clients send no Origin at all; browser/WebView profiles send
        // exactly one, verbatim.
        if (origin !== null) headers.origin = origin
        const ws = new WebSocket(url, {
          headers,
          handshakeTimeout: timeoutMs,
          maxPayload: MAX_FRAME_BYTES,
          perMessageDeflate: false,
          followRedirects: false,
        })
        let settled = false
        const fail = (error: ProbeTransportError) => {
          if (settled) return
          settled = true
          signal.removeEventListener("abort", onAbort)
          ws.removeAllListeners("open")
          ws.terminate()
          reject(error)
        }
        const onAbort = () => fail(new ProbeTransportError("runner_error", "aborted"))
        signal.addEventListener("abort", onAbort, { once: true })
        ws.once("unexpected-response", (request, response) => {
          const status = response.statusCode ?? 0
          response.resume()
          request.destroy()
          fail(new ProbeTransportError("ws_upgrade", `upgrade refused with ${status}`, status))
        })
        ws.on("error", (error: Error & { code?: string }) => {
          if (settled) return
          if (/Opening handshake has timed out/i.test(error.message)) {
            fail(new ProbeTransportError("timeout"))
            return
          }
          // Errors without a system code are protocol-level upgrade failures
          // (bad 101, wrong accept key, invalid frame during handshake).
          fail(new ProbeTransportError(error.code ? classifyNetworkError(error) : "ws_upgrade"))
        })
        ws.once("open", () => {
          if (settled) return
          settled = true
          signal.removeEventListener("abort", onAbort)
          resolve(new NodeProbeSocket(ws, signal, forceCloseAfterMs))
        })
      })
    },
  }
}

/** Buffered text-frame reader over one `ws` socket (see `ProbeSocket`). */
class NodeProbeSocket implements ProbeSocket {
  private readonly inbox: string[] = []
  private readonly waiters: Array<{
    resolve: (text: string) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  private isClosed = false
  private forceTimer: ReturnType<typeof setTimeout> | null = null
  readonly closed: Promise<void>

  constructor(
    private readonly ws: WebSocket,
    private readonly signal: AbortSignal,
    private readonly forceCloseAfterMs: number
  ) {
    this.closed = new Promise((resolve) => {
      ws.once("close", () => {
        this.isClosed = true
        if (this.forceTimer) clearTimeout(this.forceTimer)
        this.rejectAll(new ProbeTransportError("ws_closed"))
        resolve()
      })
    })
    // After open, socket errors are followed by `close`; the reader reports
    // that as ws_closed. The listener only prevents an unhandled 'error'.
    ws.on("error", () => undefined)
    ws.on("message", (data, isBinary) => {
      // The relay speaks text JSON only; a binary frame cannot be a protocol
      // answer, so it is passed on as text the core will drop as unparseable.
      const text = isBinary ? "" : data.toString()
      const waiter = this.waiters.shift()
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve(text)
      } else {
        this.inbox.push(text)
      }
    })
    signal.addEventListener("abort", this.onAbort, { once: true })
  }

  private readonly onAbort = () => {
    this.rejectAll(new ProbeTransportError("runner_error", "aborted"))
    this.ws.terminate()
  }

  private rejectAll(error: Error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  send(text: string): void {
    if (this.isClosed || this.ws.readyState !== WebSocket.OPEN) {
      throw new ProbeTransportError("ws_closed")
    }
    this.ws.send(text)
  }

  next(timeoutMs: number): Promise<string> {
    const buffered = this.inbox.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    if (this.isClosed) return Promise.reject(new ProbeTransportError("ws_closed"))
    if (this.signal.aborted)
      return Promise.reject(new ProbeTransportError("runner_error", "aborted"))
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(
          () => {
            // Remove the waiter so a frame arriving later stays buffered.
            const index = this.waiters.indexOf(waiter)
            if (index >= 0) this.waiters.splice(index, 1)
            reject(new ProbeTransportError("timeout"))
          },
          Math.max(0, timeoutMs)
        ),
      }
      this.waiters.push(waiter)
    })
  }

  close(): void {
    this.signal.removeEventListener("abort", this.onAbort)
    if (this.isClosed) return
    try {
      this.ws.close(1000, "probe complete")
    } catch {
      this.ws.terminate()
      return
    }
    if (!this.forceTimer) {
      this.forceTimer = setTimeout(() => this.ws.terminate(), this.forceCloseAfterMs)
      this.forceTimer.unref?.()
    }
  }
}
