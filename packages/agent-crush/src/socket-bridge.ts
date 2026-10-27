import type { AgentFetch, AgentOutboundGate, AgentProcessHost } from "@cognia/agent-contracts/host"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import type { CrushServiceLauncher } from "./client"

export interface CrushBridgeLaunch {
  command: string
  args: string[]
  env?: Record<string, string>
}
export interface CrushSocketBridgeDeps {
  processHost: AgentProcessHost
  outboundGate: AgentOutboundGate
  resolveBridgeLaunch(config: ExternalAgentConfig, cwd: string): Promise<CrushBridgeLaunch>
}
export const CRUSH_SOCKET_FRAME_LIMIT = 1024 * 1024
export interface CrushSocketFrame {
  type: string
  [key: string]: unknown
}
export function decodeCrushSocketFrame(raw: string): CrushSocketFrame {
  if (raw.length > CRUSH_SOCKET_FRAME_LIMIT)
    throw new Error("Crush socket frame exceeded the limit")
  const value: unknown = JSON.parse(raw)
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![
      "init",
      "ready",
      "request",
      "head",
      "chunk",
      "ack",
      "end",
      "cancel",
      "close",
      "error",
    ].includes(String((value as CrushSocketFrame).type))
  )
    throw new Error("Malformed Crush socket frame")
  return value as CrushSocketFrame
}
export function encodeCrushSocketFrame(value: CrushSocketFrame): string {
  const raw = JSON.stringify(value)
  decodeCrushSocketFrame(raw)
  return raw
}
interface RequestState {
  resolve(response: Response): void
  reject(error: Error): void
  controller?: ReadableStreamDefaultController<Uint8Array>
  pending?: { bytes: Uint8Array; seq: number }
  cleanup(): void
}
interface Lease {
  processId: string
  token: string
  requests: Map<string, RequestState>
  off: Array<() => void>
  closed: boolean
  send(frame: CrushSocketFrame): Promise<void>
  close(): Promise<void>
}

/** A fake routing origin only: no public TCP listener or global fetch fallback. */
export function createCrushSocketBridge(deps: CrushSocketBridgeDeps): {
  fetch: AgentFetch
  launch: CrushServiceLauncher
} {
  const leases = new Map<string, Lease>()
  const launch: CrushServiceLauncher = async (config, cwd, signal) => {
    if (!deps.processHost.available || config.process?.command !== "crush")
      throw new Error("Crush private socket needs a local process host")
    const executable = await deps.resolveBridgeLaunch(config, cwd)
    signal?.throwIfAborted()
    const token = crypto.randomUUID(),
      processId = `${config.id}:crush-socket:${token}`
    let ready!: () => void, fail!: (error: Error) => void
    const readiness = new Promise<void>((yes, no) => {
      ready = yes
      fail = no
    })
    void readiness.catch(() => {})
    const lease: Lease = {
      token,
      processId,
      requests: new Map(),
      off: [],
      closed: false,
      send: (frame) =>
        lease.closed
          ? Promise.reject(new Error("Crush socket lease is closed"))
          : deps.processHost.send(processId, encodeCrushSocketFrame(frame)),
      close: async () => {
        if (lease.closed) return
        lease.closed = true
        leases.delete(token)
        for (const state of lease.requests.values()) {
          state.cleanup()
          state.reject(new Error("Crush socket lease ended"))
          state.controller?.error(new Error("Crush socket lease ended"))
        }
        lease.requests.clear()
        try {
          await deps.processHost.kill(processId)
        } finally {
          for (const off of lease.off.splice(0)) off()
        }
      },
    }
    const failed = (error: unknown) => {
      const e = error instanceof Error ? error : new Error("Crush socket bridge failed")
      fail(e)
      void lease.close().catch(() => {})
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => failed(new Error("Crush socket startup cancelled"))
    try {
      lease.off.push(
        await deps.processHost.onStdoutLine((e) => {
          if (e.processId !== processId) return
          void receive(lease, e.data, ready).catch(failed)
        })
      )
      lease.off.push(
        await deps.processHost.onStderr((e) => {
          if (e.processId === processId && e.data.length > 4096)
            failed(new Error("Crush socket diagnostic limit exceeded"))
        })
      )
      lease.off.push(
        await deps.processHost.onExit((e) => {
          if (e.processId === processId && !lease.closed)
            failed(new Error(`Crush socket bridge exited with code ${e.code}`))
        })
      )
      signal?.addEventListener("abort", abort, { once: true })
      signal?.throwIfAborted()
      const actual = await deps.processHost.spawn({
        id: processId,
        command: executable.command,
        args: executable.args,
        env: { ...config.process.env, ...executable.env },
        cwd,
        framing: "line",
        sandboxPolicy: config.sandboxPolicy,
      })
      if (actual !== processId) {
        await deps.processHost.kill(actual)
        throw new Error("Crush socket process identity mismatch")
      }
      timer = setTimeout(
        () => fail(new Error("Crush socket startup timed out")),
        config.process.startupTimeout ?? 15_000
      )
      await lease.send({ type: "init", command: config.process.command, cwd })
      await readiness
      leases.set(token, lease)
      return {
        endpoint: "http://127.0.0.1",
        headers: { "X-Cognia-Crush-Lease": token },
        close: lease.close,
      }
    } catch (error) {
      await lease.close()
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
  }
  const fetch: AgentFetch = async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url),
      token = request.headers.get("X-Cognia-Crush-Lease") ?? ""
    const lease = leases.get(token)
    if (url.origin !== "http://127.0.0.1" || url.username || url.password || !lease || lease.closed)
      throw new Error("Crush request has no owned socket lease")
    request.signal.throwIfAborted()
    let body: string | undefined
    if (request.body) body = await boundedText(request.body, 512 * 1024)
    if (!deps.outboundGate({ path: url.pathname, body }))
      throw new Error("Crush socket request blocked by the PII gate")
    const requestId = crypto.randomUUID()
    let reject!: (error: Error) => void, resolve!: (response: Response) => void
    const result = new Promise<Response>((yes, no) => {
      resolve = yes
      reject = no
    })
    const abort = () => {
      const state = lease.requests.get(requestId)
      if (!state) return
      state.cleanup()
      lease.requests.delete(requestId)
      state.reject(new Error("Crush socket request cancelled"))
      state.controller?.error(new Error("Crush socket request cancelled"))
      void lease.send({ type: "cancel", requestId }).catch(() => {})
    }
    const timer = setTimeout(abort, init?.timeout ?? init?.connectTimeout ?? 15_000)
    const state: RequestState = {
      resolve: (response) => {
        if (init?.timeout === undefined) clearTimeout(timer)
        resolve(response)
      },
      reject,
      cleanup: () => {
        clearTimeout(timer)
        request.signal.removeEventListener("abort", abort)
      },
    }
    lease.requests.set(requestId, state)
    request.signal.addEventListener("abort", abort, { once: true })
    try {
      await lease.send({
        type: "request",
        requestId,
        path: url.pathname + url.search,
        method: request.method,
        body,
      })
      return await result
    } catch (error) {
      state.cleanup()
      lease.requests.delete(requestId)
      throw error
    }
  }
  return { fetch, launch }
}
async function receive(lease: Lease, raw: string, ready: () => void): Promise<void> {
  const frame = decodeCrushSocketFrame(raw)
  if (frame.type === "ready") {
    ready()
    return
  }
  const id = String(frame.requestId),
    state = lease.requests.get(id)
  if (!state) {
    if (frame.type === "error" && frame.requestId === undefined)
      throw new Error("Crush private service failed")
    return
  }
  if (frame.type === "head") {
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        state.controller = c
      },
      pull: async () => {
        if (state.pending) {
          const chunk = state.pending
          state.pending = undefined
          state.controller!.enqueue(chunk.bytes)
          await lease.send({ type: "ack", requestId: id, seq: chunk.seq })
        }
      },
      cancel: async () => {
        state.cleanup()
        lease.requests.delete(id)
        await lease.send({ type: "cancel", requestId: id })
      },
    })
    const status = Number(frame.status)
    state.resolve(
      new Response([204, 205, 304].includes(status) ? null : body, {
        status,
        headers: frame.headers as Record<string, string>,
      })
    )
  } else if (frame.type === "chunk") {
    if (
      !state.controller ||
      state.pending ||
      typeof frame.data !== "string" ||
      frame.data.length > 90_000
    )
      throw new Error("Malformed Crush socket body chunk")
    const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0)),
      seq = Number(frame.seq)
    if ((state.controller.desiredSize ?? 0) > 0) {
      state.controller.enqueue(bytes)
      await lease.send({ type: "ack", requestId: id, seq })
    } else state.pending = { bytes, seq }
  } else if (frame.type === "end") {
    if (state.pending) throw new Error("Crush socket response ended without acknowledgement")
    state.cleanup()
    state.controller?.close()
    lease.requests.delete(id)
  } else if (frame.type === "error") {
    state.cleanup()
    const error = new Error("Crush private HTTP request failed")
    state.reject(error)
    state.controller?.error(error)
    lease.requests.delete(id)
  }
}
async function boundedText(body: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = body.getReader(),
    decoder = new TextDecoder()
  let text = "",
    bytes = 0
  try {
    for (;;) {
      const value = await reader.read()
      if (value.done) break
      bytes += value.value.byteLength
      if (bytes > limit) throw new Error("Crush request exceeded the limit")
      text += decoder.decode(value.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
